"""Kanal va xabarnoma (call-center guruhi) uchun umumiy turlar.

Agent mantig'i kanalga bog'liq emas: har qanday kanal (Telegram, keyinchalik Instagram)
mijoz xabarini IncomingMessage ko'rinishida Agent.handle() ga beradi va javob matnini oladi.
Arizalar esa doim StaffNotifier orqali call-center guruhiga ketadi.
"""

from __future__ import annotations

import itertools
import logging
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger(__name__)

# Guruh xabaridagi "🆕 Yangi ariza — ..." sarlavhasi uchun kanal nomlari
CHANNEL_LABELS = {
    "telegram": "Telegram bot",
    "instagram": "Instagram",
}


@dataclass(frozen=True)
class IncomingMessage:
    channel: str       # "telegram", keyinchalik "instagram"
    user_id: str       # kanal ichidagi mijoz identifikatori
    text: str
    client_ref: str    # guruh xabaridagi "🔗 Mijoz:" qatori uchun HTML (masalan "@username")

    @property
    def is_start(self) -> bool:
        return self.text.strip().split(" ", 1)[0] == "/start"


class StaffNotifier(Protocol):
    async def send(self, html: str, reply_to: int | None = None) -> int:
        """Call-center guruhiga HTML xabar yuboradi va uning message_id sini qaytaradi."""
        ...


class LogNotifier:
    """Haqiqiy guruhga yubormaydi: xabarlarni logga yozadi va xotirada saqlaydi (DRY_RUN va sinovlar uchun)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self._ids = itertools.count(1)

    async def send(self, html: str, reply_to: int | None = None) -> int:
        message_id = next(self._ids)
        self.sent.append({"message_id": message_id, "reply_to": reply_to, "html": html})
        log.info("[DRY_RUN] Guruhga yuborilmadi (#%s, reply_to=%s):\n%s", message_id, reply_to, html)
        return message_id
