"""Ishga tushirish: python -m bot"""

import asyncio
import logging
import sys

from .channels.telegram import run
from .config import ConfigError, load_settings, setup_logging


def main() -> None:
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"Sozlamalarda xato: {exc}", file=sys.stderr)
        sys.exit(1)
    setup_logging(settings.log_file)
    try:
        asyncio.run(run(settings))
    except KeyboardInterrupt:
        logging.getLogger(__name__).info("Bot to'xtatildi")


if __name__ == "__main__":
    main()
