"""Telegram kanali (aiogram): mijoz xabarlarini qabul qiladi, Agent'ga beradi, javobni qaytaradi.

Instagram qo'shilganda shu faylga o'xshash channels/instagram.py yoziladi - Agent o'zgarmaydi.
"""

from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Dispatcher, F, Router
from aiogram.enums import ChatType, ParseMode
from aiogram.filters import Command
from aiogram.types import LinkPreviewOptions, Message, ReplyParameters, User
from aiogram.utils.chat_action import ChatActionSender

from ..agent import Agent
from ..config import Settings
from ..knowledge import Knowledge
from ..leads import escape
from ..llm import ClaudeLLM
from ..storage import Storage
from .base import IncomingMessage, LogNotifier, StaffNotifier

log = logging.getLogger(__name__)

RETRY_INTERVAL_SECONDS = 300


class TelegramGroupNotifier:
    """Arizalarni call-center Telegram guruhiga yuboradi."""

    def __init__(self, bot: Bot, chat_id: int):
        self.bot = bot
        self.chat_id = chat_id

    async def send(self, html: str, reply_to: int | None = None) -> int:
        reply = ReplyParameters(message_id=reply_to, allow_sending_without_reply=True) if reply_to else None
        message = await self.bot.send_message(
            self.chat_id,
            html,
            parse_mode=ParseMode.HTML,
            reply_parameters=reply,
            link_preview_options=LinkPreviewOptions(is_disabled=True),
        )
        return message.message_id


def client_ref_html(user: User) -> str:
    if user.username:
        return f"@{escape(user.username)}"
    return f'<a href="tg://user?id={user.id}">{escape(user.full_name or "Profil")}</a> (id {user.id})'


def message_text(message: Message) -> str:
    """Telegram xabarini agent uchun matnga aylantiradi (ovozli xabar, rasm va h.k. ham)."""
    if message.text:
        return message.text
    if message.contact:
        return f"Telefon raqamim: {message.contact.phone_number}"
    kind = message.content_type
    caption = f' Caption: "{message.caption}".' if message.caption else ""
    return f"[The client sent a {kind} message, not text.{caption} You can only read text; ask them to write in text.]"


def build_router(agent: Agent) -> Router:
    router = Router()

    @router.message(Command("chatid"))
    async def chat_id(message: Message) -> None:
        # Guruh ID sini bilish uchun: botni guruhga qo'shib, /chatid yozing
        await message.answer(f"Chat ID: <code>{message.chat.id}</code>", parse_mode=ParseMode.HTML)

    @router.message(F.chat.type == ChatType.PRIVATE, F.from_user)
    async def private_message(message: Message, bot: Bot) -> None:
        incoming = IncomingMessage(
            channel="telegram",
            user_id=str(message.from_user.id),
            text=message_text(message),
            client_ref=client_ref_html(message.from_user),
        )
        async with ChatActionSender.typing(bot=bot, chat_id=message.chat.id):
            reply = await agent.handle(incoming)
        if reply:
            await message.answer(reply[:4000])

    return router


async def _retry_loop(agent: Agent) -> None:
    while True:
        await asyncio.sleep(RETRY_INTERVAL_SECONDS)
        try:
            await agent.retry_pending()
        except Exception:
            log.exception("Qayta yuborishda xato")


async def run(settings: Settings) -> None:
    bot = Bot(settings.telegram_bot_token)
    me = await bot.get_me()
    notifier: StaffNotifier
    if settings.dry_run:
        log.warning("DRY_RUN yoqilgan: arizalar guruhga emas, faqat logga yoziladi")
        notifier = LogNotifier()
    else:
        # GROUP_CHAT_ID=0 bo'lsa ham shu notifier: arizalar yuborilmay turadi va
        # haqiqiy ID kiritilib bot qayta ishga tushgach guruhga qayta yuboriladi
        notifier = TelegramGroupNotifier(bot, settings.group_chat_id)
        if settings.group_chat_id == 0:
            log.warning(
                "GROUP_CHAT_ID hali kiritilmagan (0). Botni call-center guruhiga qo'shing va guruhda "
                "/chatid@%s deb yozing, keyin chiqqan raqamni GROUP_CHAT_ID ga yozib botni qayta ishga tushiring",
                me.username,
            )
        else:
            try:
                chat = await bot.get_chat(settings.group_chat_id)
                log.info("Call-center guruhi: %s", chat.title)
            except Exception:
                log.exception("GROUP_CHAT_ID guruhiga ulanib bo'lmadi - bot guruhga qo'shilganini tekshiring")

    agent = Agent(
        storage=Storage(settings.database_path),
        llm=ClaudeLLM(
            api_key=settings.anthropic_api_key, model=settings.anthropic_model, effort=settings.anthropic_effort
        ),
        notifier=notifier,
        knowledge=Knowledge(settings.knowledge_path),
        timezone_name=settings.timezone,
        handoff_hours=settings.handoff_hours,
    )

    dp = Dispatcher()
    dp.include_router(build_router(agent))
    retry_task = asyncio.create_task(_retry_loop(agent))
    log.info("Bot ishga tushdi: @%s (model %s, effort %s)", me.username, settings.anthropic_model, settings.anthropic_effort)
    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        retry_task.cancel()
        await bot.session.close()
