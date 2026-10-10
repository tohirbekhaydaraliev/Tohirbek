"""Sozlamalar: hammasi .env fayldan (yoki hosting o'zgaruvchilaridan) o'qiladi."""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    telegram_bot_token: str
    group_chat_id: int
    anthropic_api_key: str
    anthropic_model: str
    anthropic_effort: str
    database_path: Path
    knowledge_path: Path
    timezone: str
    handoff_hours: float
    dry_run: bool
    log_file: Path | None


def _path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else BASE_DIR / path


def load_settings(*, require_telegram: bool = True) -> Settings:
    load_dotenv(BASE_DIR / ".env")

    missing = []
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    group = os.getenv("GROUP_CHAT_ID", "").strip()
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if require_telegram and not token:
        missing.append("TELEGRAM_BOT_TOKEN")
    if require_telegram and not group:
        missing.append("GROUP_CHAT_ID")
    if not api_key:
        missing.append("ANTHROPIC_API_KEY")
    if missing:
        raise ConfigError(".env faylda yo'q: " + ", ".join(missing))

    try:
        group_chat_id = int(group) if group else 0
    except ValueError:
        raise ConfigError("GROUP_CHAT_ID raqam bo'lishi kerak, masalan -1001234567890") from None

    effort = os.getenv("ANTHROPIC_EFFORT", "medium").strip().lower()
    if effort not in EFFORT_LEVELS:
        raise ConfigError(f"ANTHROPIC_EFFORT quyidagilardan biri bo'lishi kerak: {', '.join(EFFORT_LEVELS)}")

    log_file = os.getenv("LOG_FILE", "data/bot.log").strip()

    return Settings(
        telegram_bot_token=token,
        group_chat_id=group_chat_id,
        anthropic_api_key=api_key,
        anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-5-5").strip(),
        anthropic_effort=effort,
        database_path=_path(os.getenv("DATABASE_PATH", "data/bot.db").strip()),
        knowledge_path=_path(os.getenv("KNOWLEDGE_PATH", "knowledge.md").strip()),
        timezone=os.getenv("TIMEZONE", "Asia/Tashkent").strip(),
        handoff_hours=float(os.getenv("HANDOFF_HOURS", "24")),
        dry_run=os.getenv("DRY_RUN", "").strip().lower() in ("1", "true", "yes"),
        log_file=_path(log_file) if log_file else None,
    )


def setup_logging(log_file: Path | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(log_file, maxBytes=2_000_000, backupCount=3, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )
    # httpx2/aiogram so'rovlarini har birini logga yozmaslik uchun
    logging.getLogger("httpx2").setLevel(logging.WARNING)
    logging.getLogger("aiogram.event").setLevel(logging.WARNING)
