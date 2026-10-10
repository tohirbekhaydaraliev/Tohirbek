"""O'zbekiston telefon raqamlarini tekshirish va +998 XX XXX XX XX ko'rinishiga keltirish."""

from __future__ import annotations

import re

# Matn ichidan telefonga o'xshash ketma-ketliklarni topish uchun (raqam, bo'sh joy, -, qavs)
_CANDIDATE = re.compile(r"\+?\d[\d\s\-()]{6,}\d")


def normalize_phone(raw: str) -> str | None:
    """To'g'ri raqam bo'lsa "+998 90 123 45 67" qaytaradi, aks holda None.

    Qabul qilinadi: 9 ta raqam (90 123 45 67) yoki 998 bilan boshlanuvchi 12 ta raqam.
    """
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("998"):
        digits = digits[3:]
    if len(digits) != 9:
        return None
    return f"+998 {digits[:2]} {digits[2:5]} {digits[5:7]} {digits[7:]}"


def find_phones(text: str) -> list[str]:
    """Matndagi barcha to'g'ri telefon raqamlarini (formatlangan holda) qaytaradi."""
    found = []
    for match in _CANDIDATE.findall(text or ""):
        phone = normalize_phone(match)
        if phone and phone not in found:
            found.append(phone)
    return found
