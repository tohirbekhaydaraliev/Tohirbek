"""Call-center guruhiga yuboriladigan xabarlar matni (Telegram HTML)."""

from __future__ import annotations

from datetime import datetime
from html import escape as _escape
from zoneinfo import ZoneInfo

from .channels.base import CHANNEL_LABELS
from .storage import Conversation

EMPTY = "—"


def escape(text: str) -> str:
    # Qo'shtirnoq/apostrof (o', g') o'zgarmasin - Telegram HTML uchun faqat <, >, & kerak
    return _escape(text, quote=False)


def format_time(now: datetime, tz: str) -> str:
    return now.astimezone(ZoneInfo(tz)).strftime("%d.%m.%Y, %H:%M")


def _field(value: str | None) -> str:
    return escape(value) if value else EMPTY


def _common_lines(conv: Conversation) -> list[str]:
    return [
        f"👤 Ism: {_field(conv.name)}",
        f"📞 Telefon: {_field(conv.phone)}",
        f"📚 Kurs: {_field(', '.join(conv.courses))}",
        f"💬 Izoh: {_field(conv.note)}",
        f"🔗 Mijoz: {conv.client_ref or EMPTY}",
    ]


def _label(conv: Conversation) -> str:
    return CHANNEL_LABELS.get(conv.channel, conv.channel)


def format_lead(conv: Conversation, *, updated: bool, time_str: str) -> str:
    title = "♻️ Ariza yangilandi" if updated else "🆕 Yangi ariza"
    lines = [f"<b>{title} — {escape(_label(conv))}</b>", *_common_lines(conv), f"🕐 Vaqt: {time_str}"]
    return "\n".join(lines)


def format_handoff(conv: Conversation, *, time_str: str) -> str:
    lines = [
        f"<b>🚨 OPERATOR KERAK — {escape(_label(conv))}</b>",
        f"❗ Sabab: {_field(conv.handoff_reason)}",
        *_common_lines(conv),
        f"🕐 Vaqt: {time_str}",
    ]
    return "\n".join(lines)


def format_followup(conv: Conversation, text: str, *, new_phone: str | None, time_str: str) -> str:
    lines = ["<b>💬 Mijoz yana yozdi (operator kutilmoqda)</b>", f"🔗 Mijoz: {conv.client_ref or EMPTY}"]
    if new_phone:
        lines.append(f"📞 Yangi telefon: {escape(new_phone)}")
    lines += [f"✉️ Xabar: {escape(text[:1500])}", f"🕐 Vaqt: {time_str}"]
    return "\n".join(lines)
