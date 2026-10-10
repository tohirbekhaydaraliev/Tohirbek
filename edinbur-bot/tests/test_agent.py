"""Agent mantig'i sinovlari (Claude o'rniga oldindan yozilgan javoblar bilan)."""

import json
from datetime import timedelta

import anthropic
import httpx2

from bot.agent import Agent
from bot.knowledge import Knowledge
from bot.storage import Storage
from tests.conftest import incoming, text_reply, tool_call


def last_tool_result(llm) -> dict:
    content = llm.requests[-1]["messages"][-1]["content"]
    return json.loads(content[0]["content"])


async def test_full_lead_is_sent_once_and_updated(env):
    llm, notifier = env.llm, env.notifier

    llm.queue(
        tool_call("save_client_info", {"courses": ["Ingliz tili"], "note": "Ingliz tiliga qiziqdi"}),
        text_reply("Ingliz tili kursimiz bor. Ismingiz nima?"),
    )
    assert await env.agent.handle(incoming("Ingliz tili bormi?")) == "Ingliz tili kursimiz bor. Ismingiz nima?"
    assert last_tool_result(llm)["missing"] == ["name", "phone"]
    assert notifier.sent == []

    llm.queue(tool_call("save_client_info", {"name": "Dilnoza"}), text_reply("Telefon raqamingiz?"))
    await env.agent.handle(incoming("Dilnoza"))

    # Noto'g'ri raqam: saqlanmaydi, ariza ketmaydi
    llm.queue(tool_call("save_client_info", {"phone": "90 12 34"}), text_reply("Raqam noto'g'ri, qayta yozing."))
    await env.agent.handle(incoming("90 12 34"))
    result = last_tool_result(llm)
    assert "phone_error" in result and result["saved"]["phone"] is None
    assert notifier.sent == []

    llm.queue(tool_call("save_client_info", {"phone": "901234567"}), text_reply("Rahmat! 24 soat ichida siz bilan bog'lanamiz"))
    await env.agent.handle(incoming("901234567"))
    assert last_tool_result(llm)["application"] == "sent to the call-center"
    assert len(notifier.sent) == 1
    lead = notifier.sent[0]["html"]
    assert "🆕 Yangi ariza — Telegram bot" in lead
    assert "👤 Ism: Dilnoza" in lead
    assert "📞 Telefon: +998 90 123 45 67" in lead
    assert "📚 Kurs: Ingliz tili" in lead
    assert "💬 Izoh: Ingliz tiliga qiziqdi" in lead
    assert "🔗 Mijoz: @test_user" in lead
    assert "🕐 Vaqt: 10.10.2026, 14:30" in lead  # Toshkent vaqti (UTC+5)

    # Xuddi shu ma'lumot qayta saqlansa - takroriy ariza yo'q
    llm.queue(tool_call("save_client_info", {"phone": "+998 90 123 45 67"}), text_reply("Arizangiz qabul qilingan."))
    await env.agent.handle(incoming("raqamim +998 90 123 45 67"))
    assert len(notifier.sent) == 1

    # Ma'lumot o'zgarsa - yangilangan xabar birinchi arizaga javob sifatida
    llm.queue(
        tool_call("save_client_info", {"courses": ["Ingliz tili", "Rus tili"]}),
        text_reply("Yangiladim."),
    )
    await env.agent.handle(incoming("Rus tiliga ham qiziqaman"))
    assert len(notifier.sent) == 2
    assert "♻️ Ariza yangilandi" in notifier.sent[1]["html"]
    assert "Ingliz tili, Rus tili" in notifier.sent[1]["html"]
    assert notifier.sent[1]["reply_to"] == notifier.sent[0]["message_id"]


async def test_history_survives_restart(env, knowledge_file):
    env.llm.queue(text_reply("Assalomu alaykum!"))
    await env.agent.handle(incoming("/start"))
    env.storage.close()

    storage = Storage(env.db_path)
    agent = Agent(storage=storage, llm=env.llm, notifier=env.notifier, knowledge=Knowledge(knowledge_file))
    env.llm.queue(text_reply("Ha, bor."))
    await agent.handle(incoming("Ingliz tili bormi?"))
    roles = [m["role"] for m in env.llm.requests[-1]["messages"]]
    assert roles == ["user", "assistant", "user"]
    first_assistant = env.llm.requests[-1]["messages"][1]["content"]
    assert first_assistant[0]["type"] == "thinking"  # thinking bloklari o'zgarmay qaytariladi


async def test_operator_handoff_stops_ai_and_forwards(env):
    llm, notifier = env.llm, env.notifier
    llm.queue(
        tool_call("request_operator", {"reason": "Mijoz to'lovni qaytarishni so'ramoqda, norozi"}),
        text_reply("Operatorimiz tez orada bog'lanadi. Raqamingizni qoldiring."),
    )
    reply = await env.agent.handle(incoming("Pulimni qaytaring, odam bilan gaplashaman!"))
    assert "Operatorimiz" in reply
    assert len(notifier.sent) == 1
    handoff = notifier.sent[0]
    assert "🚨 OPERATOR KERAK — Telegram bot" in handoff["html"]
    assert "to'lovni qaytarishni" in handoff["html"]
    assert "Ask them to leave their phone number" in last_tool_result(llm)["next_step"]

    # Operator rejimida AI chaqirilmaydi, xabar guruhga uzatiladi
    requests_before = len(llm.requests)
    assert await env.agent.handle(incoming("Qachon bog'lanasizlar?")) is None
    assert len(llm.requests) == requests_before
    assert notifier.sent[1]["reply_to"] == handoff["message_id"]
    assert "Qachon bog'lanasizlar?" in notifier.sent[1]["html"]

    # Raqam yozsa - saqlanadi, guruhga ketadi, mijozga qisqa tasdiq
    reply = await env.agent.handle(incoming("Raqamim 97 777 88 99"))
    assert reply.startswith("Rahmat, raqamingizni operatorga")
    assert "📞 Yangi telefon: +998 97 777 88 99" in notifier.sent[2]["html"]
    assert env.storage.get_or_create("telegram", "42", "@test_user").phone == "+998 97 777 88 99"
    assert len(llm.requests) == requests_before


async def test_handoff_expires(env):
    env.llm.queue(tool_call("request_operator", {"reason": "Norozi"}), text_reply("Operator bog'lanadi."))
    await env.agent.handle(incoming("Yomon xizmat"))
    env.clock.now += timedelta(hours=25)
    env.llm.queue(text_reply("Yana qanday yordam kerak?"))
    assert await env.agent.handle(incoming("Salom")) == "Yana qanday yordam kerak?"


async def test_api_error_gives_fallback_and_keeps_message(env):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    env.llm.queue(anthropic.APIConnectionError(request=request))
    assert await env.agent.handle(incoming("Здравствуйте, есть курсы английского?")) == (
        "Извините, сейчас технический сбой. Мы ответим чуть позже."
    )
    env.llm.queue(text_reply("Да, есть."))
    assert await env.agent.handle(incoming("Алло?")) == "Да, есть."
    texts = [m["content"][0]["text"] for m in env.llm.requests[-1]["messages"]]
    assert texts == ["Здравствуйте, есть курсы английского?", "Алло?"]


async def test_notifier_failure_is_retried(env):
    class FlakyNotifier:
        def __init__(self):
            self.fail = True
            self.sent = []

        async def send(self, html, reply_to=None):
            if self.fail:
                raise RuntimeError("Telegram ishlamayapti")
            self.sent.append(html)
            return len(self.sent)

    env.agent.notifier = notifier = FlakyNotifier()
    env.llm.queue(
        tool_call("save_client_info", {"courses": ["Rus tili"], "name": "Olga", "phone": "93 555 12 34"}),
        text_reply("Rahmat! 24 soat ichida siz bilan bog'lanamiz"),
    )
    await env.agent.handle(incoming("Rus tili, Olga, 93 555 12 34"))
    assert notifier.sent == []

    notifier.fail = False
    await env.agent.retry_pending()
    await env.agent.retry_pending()
    assert len(notifier.sent) == 1 and "Olga" in notifier.sent[0]


async def test_knowledge_change_strips_thinking(env):
    env.llm.queue(text_reply("Salom!"))
    await env.agent.handle(incoming("/start"))
    env.knowledge_file.write_text("# Yangi ma'lumot\n- Telefon: 99 000 00 00\n", encoding="utf-8")
    import os
    os.utime(env.knowledge_file, (1, 1))  # mtime aniq o'zgarsin

    env.llm.queue(text_reply("Ha."))
    await env.agent.handle(incoming("Telefoningiz?"))
    request = env.llm.requests[-1]
    assert "99 000 00 00" in request["system"]
    assert request["messages"][1]["content"] == [{"type": "text", "text": "Salom!"}]


async def test_bad_thinking_signature_is_stripped_and_retried(env):
    env.llm.queue(text_reply("Salom!"))
    await env.agent.handle(incoming("/start"))

    response = httpx2.Response(400, request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
    error = anthropic.BadRequestError(
        "messages.1.content.0: Invalid `signature` in `thinking` block.", response=response, body=None
    )
    env.llm.queue(error, text_reply("Ha, bor."))
    assert await env.agent.handle(incoming("Kurslar bormi?")) == "Ha, bor."
    assert env.llm.requests[-1]["messages"][1]["content"] == [{"type": "text", "text": "Salom!"}]


async def test_html_comments_hidden_from_model(env):
    env.llm.queue(text_reply("Salom!"))
    await env.agent.handle(incoming("/start"))
    assert "yashirin izoh" not in env.llm.requests[0]["system"]
    assert "Ingliz tili" in env.llm.requests[0]["system"]
