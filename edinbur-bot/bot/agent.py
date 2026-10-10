"""Agent mantig'i: suhbat, ma'lumot yig'ish, ariza va operatorga uzatish. Kanalga bog'liq emas."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Callable

import anthropic

from . import texts
from .channels.base import IncomingMessage, StaffNotifier
from .knowledge import Knowledge
from .leads import format_followup, format_handoff, format_lead, format_time
from .llm import LLM
from .phone import find_phones, normalize_phone
from .prompt import TOOLS, build_system_prompt, prompt_hash
from .storage import Conversation, Storage

log = logging.getLogger(__name__)

MAX_STEPS = 6          # bitta mijoz xabariga eng ko'pi bilan nechta API chaqiruv
MAX_TEXT_LENGTH = 4000


class AgentError(Exception):
    pass


class Agent:
    def __init__(
        self,
        *,
        storage: Storage,
        llm: LLM,
        notifier: StaffNotifier,
        knowledge: Knowledge,
        timezone_name: str = "Asia/Tashkent",
        handoff_hours: float = 24.0,
        clock: Callable[[], datetime] | None = None,
    ):
        self.storage = storage
        self.llm = llm
        self.notifier = notifier
        self.knowledge = knowledge
        self.timezone_name = timezone_name
        self.handoff_hours = handoff_hours
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        # Bitta mijozning xabarlari navbat bilan ishlansin (tarix aralashib ketmasin)
        self._locks: defaultdict[tuple[str, str], asyncio.Lock] = defaultdict(asyncio.Lock)

    # --- asosiy kirish nuqtasi ----------------------------------------------

    async def handle(self, msg: IncomingMessage) -> str | None:
        """Mijoz xabarini ishlaydi. Mijozga yuboriladigan matnni qaytaradi (None - javob yo'q)."""
        async with self._locks[(msg.channel, msg.user_id)]:
            try:
                return await self._handle(msg)
            except Exception:
                log.exception("Xabarni ishlashda xato (%s:%s)", msg.channel, msg.user_id)
                return texts.fallback_text(msg.text)

    async def _handle(self, msg: IncomingMessage) -> str | None:
        text = msg.text.strip()[:MAX_TEXT_LENGTH]
        conv = self.storage.get_or_create(msg.channel, msg.user_id, msg.client_ref)

        if conv.status == "handoff":
            if msg.is_start or self._handoff_expired(conv):
                self.storage.update(conv.id, status="active")
                log.info("Suhbat %s operator rejimidan qaytdi", conv.id)
            else:
                return await self._handle_during_handoff(conv, text)

        self.storage.add_messages(conv.id, [("user", [{"type": "text", "text": text}])])
        try:
            return await self._run_model(conv.id)
        except Exception:
            # Mijoz xabari tarixda qoladi - keyingi safar model uni ko'radi
            log.exception("Claude javob bera olmadi (suhbat %s)", conv.id)
            return texts.fallback_text(text)

    # --- Claude bilan suhbat --------------------------------------------------

    async def _run_model(self, conversation_id: int) -> str:
        system = build_system_prompt(self.knowledge.text())
        current_hash = prompt_hash(system, TOOLS)
        conv = self.storage.get(conversation_id)
        if conv.prompt_hash != current_hash:
            # knowledge.md o'zgargan: eski thinking bloklari endi yaroqsiz
            if conv.prompt_hash is not None:
                self.storage.strip_thinking(conversation_id)
            self.storage.update(conversation_id, prompt_hash=current_hash)

        stripped_after_error = False
        for _ in range(MAX_STEPS):
            messages = self.storage.load_messages(conversation_id)
            try:
                response = await self.llm.create(system=system, tools=TOOLS, messages=messages)
            except anthropic.BadRequestError as exc:
                if "thinking" in str(exc) and not stripped_after_error:
                    log.warning("Thinking bloklari rad etildi, tozalab qayta urinamiz: %s", exc)
                    self.storage.strip_thinking(conversation_id)
                    stripped_after_error = True
                    continue
                raise

            if response.stop_reason == "refusal":
                raise AgentError(f"Model rad etdi: {response.stop_details}")
            if response.stop_reason == "max_tokens":
                raise AgentError("Javob max_tokens chegarasida uzildi")

            content = [block.to_dict(mode="json") for block in response.content]
            tool_uses = [block for block in response.content if block.type == "tool_use"]

            if response.stop_reason == "tool_use" and tool_uses:
                results = []
                for tool_use in tool_uses:
                    results.append(await self._run_tool(conversation_id, tool_use.id, tool_use.name, tool_use.input))
                self.storage.add_messages(conversation_id, [("assistant", content), ("user", results)])
                continue

            reply = "\n".join(b.text for b in response.content if b.type == "text").strip()
            if not reply:
                raise AgentError(f"Bo'sh javob (stop_reason={response.stop_reason})")
            self.storage.add_messages(conversation_id, [("assistant", content)])
            return reply

        raise AgentError("Juda ko'p qadam, javob olinmadi")

    async def _run_tool(self, conversation_id: int, tool_use_id: str, name: str, args: dict) -> dict:
        try:
            if name == "save_client_info":
                result = await self._tool_save_client_info(conversation_id, args)
            elif name == "request_operator":
                result = await self._tool_request_operator(conversation_id, args)
            else:
                raise ValueError(f"Noma'lum tool: {name}")
            return {"type": "tool_result", "tool_use_id": tool_use_id, "content": json.dumps(result, ensure_ascii=False)}
        except Exception as exc:
            log.exception("Tool xatosi: %s", name)
            return {"type": "tool_result", "tool_use_id": tool_use_id, "content": f"Error: {exc}", "is_error": True}

    async def _tool_save_client_info(self, conversation_id: int, args: dict) -> dict:
        updates: dict = {}
        phone_error = None

        courses = args.get("courses")
        if isinstance(courses, list):
            cleaned = list(dict.fromkeys(str(c).strip() for c in courses if str(c).strip()))
            if cleaned:
                updates["courses"] = cleaned
        if isinstance(args.get("name"), str) and args["name"].strip():
            updates["name"] = args["name"].strip()[:100]
        if isinstance(args.get("note"), str) and args["note"].strip():
            updates["note"] = args["note"].strip()[:300]
        if isinstance(args.get("phone"), str) and args["phone"].strip():
            phone = normalize_phone(args["phone"])
            if phone:
                updates["phone"] = phone
            else:
                phone_error = (
                    f"'{args['phone']}' is not a valid phone number: it must have 9 digits after +998 "
                    "(e.g. 90 123 45 67). It was NOT saved. Ask the client to send the number again."
                )

        self.storage.update(conversation_id, **updates)
        conv = self.storage.get(conversation_id)
        status = await self._sync_lead(conv)

        missing = [label for label, value in (("courses", conv.courses), ("name", conv.name), ("phone", conv.phone)) if not value]
        result: dict = {
            "saved": {"courses": conv.courses, "name": conv.name, "phone": conv.phone},
            "missing": missing,
        }
        if phone_error:
            result["phone_error"] = phone_error
        if status == "sent":
            result["application"] = "sent to the call-center"
            result["next_step"] = "Tell the client: \"Rahmat! 24 soat ichida siz bilan bog'lanamiz\" (in their language)."
        elif status == "updated":
            result["application"] = "updated application sent to the call-center"
            result["next_step"] = "Briefly confirm to the client that their details were updated."
        elif status == "unchanged":
            result["application"] = "already sent earlier, nothing new to send"
        else:
            result["application"] = "not sent yet"
            if not phone_error:
                result["next_step"] = f"Answer the client's question if any, then ask for: {missing[0]}."
        return result

    async def _tool_request_operator(self, conversation_id: int, args: dict) -> dict:
        reason = str(args.get("reason") or "").strip()[:300] or "Mijoz operator bilan gaplashmoqchi"
        self.storage.update(
            conversation_id, status="handoff", handoff_at=self._now_iso(), handoff_reason=reason, handoff_message_id=None
        )
        await self._send_handoff(self.storage.get(conversation_id))
        conv = self.storage.get(conversation_id)
        step = "Write one short message: an operator will contact them soon."
        if not conv.phone:
            step += " Ask them to leave their phone number so the operator can call."
        return {"operator_notified": True, "next_step": step + " Don't ask anything else."}

    # --- guruhga xabarlar ----------------------------------------------------

    def _now_iso(self) -> str:
        return self._clock().isoformat(timespec="seconds")

    def _time_str(self) -> str:
        return format_time(self._clock(), self.timezone_name)

    async def _sync_lead(self, conv: Conversation) -> str:
        """Ariza to'liq bo'lsa va guruhga hali yuborilmagan/o'zgargan bo'lsa yuboradi.

        Natija: "incomplete", "unchanged", "sent" yoki "updated".
        Bitta mijozdan bitta ariza: keyingi o'zgarishlar birinchi arizaga javob (reply) sifatida ketadi.
        """
        if not conv.lead_complete:
            return "incomplete"
        if not conv.lead_pending:
            return "unchanged"
        updated = conv.lead_message_id is not None
        html = format_lead(conv, updated=updated, time_str=self._time_str())
        try:
            message_id = await self.notifier.send(html, reply_to=conv.lead_message_id)
        except Exception:
            # Ariza yo'qolmaydi: lead_pending bo'lib qoladi va retry_pending() qayta yuboradi
            log.exception("Arizani guruhga yuborib bo'lmadi (suhbat %s)", conv.id)
            return "updated" if updated else "sent"
        fields: dict = {"lead_snapshot": conv.lead_core(), "lead_sent_at": self._now_iso()}
        if not updated:
            fields["lead_message_id"] = message_id
        self.storage.update(conv.id, **fields)
        log.info("Ariza %s (suhbat %s)", "yangilandi" if updated else "yuborildi", conv.id)
        return "updated" if updated else "sent"

    async def _send_handoff(self, conv: Conversation) -> None:
        html = format_handoff(conv, time_str=self._time_str())
        try:
            message_id = await self.notifier.send(html, reply_to=conv.lead_message_id)
        except Exception:
            log.exception("Operator so'rovini guruhga yuborib bo'lmadi (suhbat %s)", conv.id)
            return
        self.storage.update(conv.id, handoff_message_id=message_id)
        log.info("Operator chaqirildi (suhbat %s)", conv.id)

    async def retry_pending(self) -> None:
        """Avval yuborilmay qolgan arizalar va operator so'rovlarini qayta yuboradi (fon vazifasi)."""
        for conv in self.storage.complete_leads():
            if conv.lead_pending:
                async with self._locks[(conv.channel, conv.user_id)]:
                    await self._sync_lead(self.storage.get(conv.id))
        for conv in self.storage.unsent_handoffs():
            async with self._locks[(conv.channel, conv.user_id)]:
                await self._send_handoff(self.storage.get(conv.id))

    # --- operator rejimi -----------------------------------------------------

    def _handoff_expired(self, conv: Conversation) -> bool:
        if not conv.handoff_at:
            return True
        started = datetime.fromisoformat(conv.handoff_at)
        return self._clock() - started > timedelta(hours=self.handoff_hours)

    async def _handle_during_handoff(self, conv: Conversation, text: str) -> str | None:
        """Operator chaqirilgan: AI javob bermaydi, xabar guruhga uzatiladi."""
        self.storage.add_messages(conv.id, [("user", [{"type": "text", "text": text}])])

        new_phone = next((p for p in find_phones(text) if p != conv.phone), None)
        if new_phone:
            self.storage.update(conv.id, phone=new_phone)
            conv = self.storage.get(conv.id)

        html = format_followup(conv, text, new_phone=new_phone, time_str=self._time_str())
        try:
            await self.notifier.send(html, reply_to=conv.handoff_message_id)
        except Exception:
            log.exception("Mijoz xabarini guruhga uzatib bo'lmadi (suhbat %s)", conv.id)

        if not new_phone:
            return None
        reply = texts.phone_received_text(text)
        self.storage.add_messages(conv.id, [("assistant", [{"type": "text", "text": reply}])])
        return reply
