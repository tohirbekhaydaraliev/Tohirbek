"""knowledge.md faylini o'qish. Fayl o'zgarsa, keyingi so'rovda avtomatik qayta o'qiladi."""

from __future__ import annotations

import re
from pathlib import Path

_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


class Knowledge:
    def __init__(self, path: Path):
        self.path = path
        self._mtime: float | None = None
        self._text = ""
        self.text()  # fayl yo'q bo'lsa, darhol xato beradi

    def text(self) -> str:
        mtime = self.path.stat().st_mtime
        if mtime != self._mtime:
            raw = self.path.read_text(encoding="utf-8")
            self._text = _HTML_COMMENT.sub("", raw).strip()
            self._mtime = mtime
        return self._text
