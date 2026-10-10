"""AI ishlatilmaydigan holatlar uchun tayyor matnlar (xatolik, operator rejimi)."""

from __future__ import annotations

_UZ_CYRL_LETTERS = set("ўқғҳЎҚҒҲ")
_UZ_CYRL_WORDS = (
    "салом", "ассалому", "рахмат", "раҳмат", "керак", "исмим", "рақам", "раками",
    "телефоним", "менга", "сизлар", "борми", "канча", "қанча", "курсига", "ёзилмоқчи",
)

FALLBACK = {
    "uz_latn": "Kechirasiz, hozir texnik nosozlik bor. Birozdan keyin javob beramiz.",
    "uz_cyrl": "Кечирасиз, ҳозир техник носозлик бор. Бироздан кейин жавоб берамиз.",
    "ru": "Извините, сейчас технический сбой. Мы ответим чуть позже.",
}

PHONE_RECEIVED = {
    "uz_latn": "Rahmat, raqamingizni operatorga yetkazdim. Tez orada siz bilan bog'lanamiz.",
    "uz_cyrl": "Раҳмат, рақамингизни операторга етказдим. Тез орада сиз билан боғланамиз.",
    "ru": "Спасибо, ваш номер передан оператору. Скоро с вами свяжемся.",
}


def detect_language(text: str) -> str:
    """Taxminiy til: "uz_latn", "uz_cyrl" yoki "ru"."""
    if any(ch in _UZ_CYRL_LETTERS for ch in text):
        return "uz_cyrl"
    cyrillic = sum(1 for ch in text.lower() if "а" <= ch <= "я" or ch == "ё")
    latin = sum(1 for ch in text.lower() if "a" <= ch <= "z")
    if cyrillic > latin:
        lowered = text.lower()
        if any(word in lowered for word in _UZ_CYRL_WORDS):
            return "uz_cyrl"
        return "ru"
    return "uz_latn"


def fallback_text(user_text: str) -> str:
    return FALLBACK[detect_language(user_text)]


def phone_received_text(user_text: str) -> str:
    return PHONE_RECEIVED[detect_language(user_text)]
