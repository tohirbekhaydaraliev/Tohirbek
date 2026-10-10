"""SQLite: har bir mijozning suhbat tarixi va ariza holati. Bot qayta ishga tushsa ham saqlanadi."""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    channel            TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    client_ref         TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'active',  -- active | handoff
    name               TEXT,
    phone              TEXT,
    courses            TEXT,                             -- JSON ro'yxat
    note               TEXT,
    lead_message_id    INTEGER,                          -- guruhdagi birinchi ariza xabari
    lead_snapshot      TEXT,                             -- guruhga oxirgi yuborilgan ism/telefon/kurs (JSON)
    lead_sent_at       TEXT,
    handoff_at         TEXT,
    handoff_reason     TEXT,
    handoff_message_id INTEGER,
    prompt_hash        TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (channel, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,                       -- Claude API content bloklari (JSON)
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
"""

_JSON_FIELDS = {"courses", "lead_snapshot"}
_UPDATABLE = {
    "client_ref", "status", "name", "phone", "courses", "note", "lead_message_id", "lead_snapshot",
    "lead_sent_at", "handoff_at", "handoff_reason", "handoff_message_id", "prompt_hash",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Conversation:
    id: int
    channel: str
    user_id: str
    client_ref: str
    status: str
    name: str | None
    phone: str | None
    courses: list[str]
    note: str | None
    lead_message_id: int | None
    lead_snapshot: dict | None
    lead_sent_at: str | None
    handoff_at: str | None
    handoff_reason: str | None
    handoff_message_id: int | None
    prompt_hash: str | None
    created_at: str
    updated_at: str

    @property
    def lead_complete(self) -> bool:
        return bool(self.name and self.phone and self.courses)

    def lead_core(self) -> dict:
        """Takroriy arizani aniqlash uchun solishtiriladigan maydonlar."""
        return {"name": self.name, "phone": self.phone, "courses": list(self.courses)}

    @property
    def lead_pending(self) -> bool:
        """Ariza to'liq, lekin guruhga hali yuborilmagan (yoki o'zgargan)."""
        return self.status == "active" and self.lead_complete and self.lead_snapshot != self.lead_core()


class Storage:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock, self._db:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    # --- suhbatlar ---------------------------------------------------------

    def _row_to_conversation(self, row: sqlite3.Row) -> Conversation:
        data = dict(row)
        data["courses"] = json.loads(data["courses"]) if data["courses"] else []
        data["lead_snapshot"] = json.loads(data["lead_snapshot"]) if data["lead_snapshot"] else None
        return Conversation(**data)

    def get(self, conversation_id: int) -> Conversation:
        with self._lock:
            row = self._db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if row is None:
            raise KeyError(conversation_id)
        return self._row_to_conversation(row)

    def get_or_create(self, channel: str, user_id: str, client_ref: str) -> Conversation:
        now = utc_now()
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR IGNORE INTO conversations (channel, user_id, client_ref, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (channel, user_id, client_ref, now, now),
            )
            # Mijoz username'ini o'zgartirgan bo'lishi mumkin
            self._db.execute(
                "UPDATE conversations SET client_ref = ? WHERE channel = ? AND user_id = ? AND client_ref != ?",
                (client_ref, channel, user_id, client_ref),
            )
            row = self._db.execute(
                "SELECT * FROM conversations WHERE channel = ? AND user_id = ?", (channel, user_id)
            ).fetchone()
        return self._row_to_conversation(row)

    def update(self, conversation_id: int, **fields) -> None:
        if not fields:
            return
        unknown = set(fields) - _UPDATABLE
        if unknown:
            raise ValueError(f"Noma'lum maydon: {unknown}")
        values = [
            json.dumps(v, ensure_ascii=False) if k in _JSON_FIELDS and v is not None else v
            for k, v in fields.items()
        ]
        assignments = ", ".join(f"{k} = ?" for k in fields)
        with self._lock, self._db:
            self._db.execute(
                f"UPDATE conversations SET {assignments}, updated_at = ? WHERE id = ?",
                (*values, utc_now(), conversation_id),
            )

    def complete_leads(self) -> list[Conversation]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM conversations WHERE name IS NOT NULL AND phone IS NOT NULL AND courses IS NOT NULL"
            ).fetchall()
        return [self._row_to_conversation(r) for r in rows]

    def unsent_handoffs(self) -> list[Conversation]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM conversations WHERE status = 'handoff' AND handoff_message_id IS NULL"
            ).fetchall()
        return [self._row_to_conversation(r) for r in rows]

    # --- xabarlar ----------------------------------------------------------

    def add_messages(self, conversation_id: int, messages: list[tuple[str, list[dict]]]) -> None:
        """Bir nechta xabarni bitta tranzaksiyada qo'shadi (tool_use va tool_result ajralib qolmasin)."""
        now = utc_now()
        with self._lock, self._db:
            self._db.executemany(
                "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
                [(conversation_id, role, json.dumps(content, ensure_ascii=False), now) for role, content in messages],
            )

    def load_messages(self, conversation_id: int) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id", (conversation_id,)
            ).fetchall()
        return [{"role": r["role"], "content": json.loads(r["content"])} for r in rows]

    def strip_thinking(self, conversation_id: int) -> int:
        """Tarixdagi barcha thinking bloklarini olib tashlaydi.

        Claude thinking bloklari system prompt bilan bog'langan: knowledge.md o'zgarsa,
        eski bloklarni qayta yuborish 400 xato beradi. Shuning uchun ularni butunlay o'chiramiz.
        """
        changed = 0
        with self._lock, self._db:
            rows = self._db.execute(
                "SELECT id, content FROM messages WHERE conversation_id = ? AND role = 'assistant'",
                (conversation_id,),
            ).fetchall()
            for row in rows:
                blocks = json.loads(row["content"])
                kept = [b for b in blocks if b.get("type") not in ("thinking", "redacted_thinking")]
                if len(kept) == len(blocks):
                    continue
                changed += 1
                if kept:
                    self._db.execute(
                        "UPDATE messages SET content = ? WHERE id = ?",
                        (json.dumps(kept, ensure_ascii=False), row["id"]),
                    )
                else:
                    self._db.execute("DELETE FROM messages WHERE id = ?", (row["id"],))
        return changed
