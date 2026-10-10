import pytest

from bot.phone import find_phones, normalize_phone
from bot.texts import detect_language


@pytest.mark.parametrize(
    "raw",
    ["90 123 45 67", "901234567", "+998 90 123 45 67", "998901234567", "+998(90)123-45-67", "90-123-45-67"],
)
def test_valid_phones(raw):
    assert normalize_phone(raw) == "+998 90 123 45 67"


@pytest.mark.parametrize("raw", ["90 12 34", "90 123 45 678", "12345", "", "abc", "+7 999 123 45 67", "99890123456"])
def test_invalid_phones(raw):
    assert normalize_phone(raw) is None


def test_find_phones_in_text():
    assert find_phones("Raqamim 97 777 88 99, ishonchli") == ["+998 97 777 88 99"]
    assert find_phones("Men 2 ta kursga qiziqaman") == []


@pytest.mark.parametrize(
    "text,lang",
    [
        ("Salom, ingliz tili kursi bormi?", "uz_latn"),
        ("Здравствуйте, хочу записаться", "ru"),
        ("Корейс тили курсига ёзилмоқчиман", "uz_cyrl"),
        ("Салом, курслар борми", "uz_cyrl"),
    ],
)
def test_detect_language(text, lang):
    assert detect_language(text) == lang
