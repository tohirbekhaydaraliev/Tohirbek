"""Haqiqiy Claude bilan sinov suhbatlari. Telegram'ga ham, guruhga ham hech narsa yuborilmaydi.

    python scripts/simulate.py              # 5 ta tayyor sinov, natija: sinov_natijalari.md
    python scripts/simulate.py --chat       # o'zingiz terminalda bot bilan yozishasiz

Faqat ANTHROPIC_API_KEY kerak (.env da). Har bir ishga tushirishda vaqtinchalik baza ishlatiladi.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bot.agent import Agent  # noqa: E402
from bot.channels.base import IncomingMessage, LogNotifier  # noqa: E402
from bot.config import BASE_DIR, ConfigError, load_settings  # noqa: E402
from bot.knowledge import Knowledge  # noqa: E402
from bot.llm import ClaudeLLM  # noqa: E402
from bot.storage import Storage  # noqa: E402

# Mijoz xabarlari bot savollari tartibiga bog'liq bo'lmasligi uchun o'zi nima ekanini aytadi
SCENARIOS = [
    (
        "1. Oddiy ariza (o'zbekcha lotin) + keyin kurs qo'shilishi",
        [
            "Assalomu alaykum. Ingliz tili kurslaringiz bormi?",
            "Qayerda joylashgansizlar?",
            "Ismim Dilnoza",
            "Raqamim 90 123 45 67",
            "Aytgancha, rus tiliga ham yozilmoqchiman",
            "Rahmat",
        ],
    ),
    (
        "2. Ruscha yozgan mijoz",
        [
            "Здравствуйте! Хочу записать ребёнка на ментальную арифметику",
            "Ребёнку 7 лет. Меня зовут Ольга",
            "+998 (93) 555-12-34",
        ],
    ),
    (
        "3. Faylda yo'q narx va chegirma so'ragan mijoz",
        [
            "Salom, matematika kursi necha pul turadi?",
            "Chegirma bormi? Darslar soat nechida?",
            "Jasur",
            "998991112233",
        ],
    ),
    (
        "4. Noto'g'ri telefon yozgan mijoz (o'zbekcha kirill)",
        [
            "Ассалому алайкум, корейс тили курсига ёзилмоқчиман",
            "Исмим Бекзод",
            "90 12 34",
            "90 123 45 678",
            "901234567",
        ],
    ),
    (
        "5. Operator so'ragan, norozi mijoz",
        [
            "Salom. O'tgan oy to'lagan pulimni qaytarib bermayapsizlar, juda noroziman",
            "Men odam bilan gaplashmoqchiman, bot emas",
            "Raqamim 97 777 88 99",
        ],
    ),
]


def make_agent(settings, db_path: Path, notifier: LogNotifier) -> Agent:
    return Agent(
        storage=Storage(db_path),
        llm=ClaudeLLM(api_key=settings.anthropic_api_key, model=settings.anthropic_model, effort=settings.anthropic_effort),
        notifier=notifier,
        knowledge=Knowledge(settings.knowledge_path),
        timezone_name=settings.timezone,
        handoff_hours=settings.handoff_hours,
    )


def quote(text: str) -> str:
    return "\n".join("> " + line if line else ">" for line in text.splitlines())


async def run_scenarios(settings, out_path: Path) -> None:
    report = [
        "# Sinov suhbatlari natijasi",
        "",
        f"Model: `{settings.anthropic_model}`, effort: `{settings.anthropic_effort}`. "
        "Guruhga hech narsa yuborilmagan - guruh xabarlari quyida ko'rsatilgan.",
        "",
    ]
    with tempfile.TemporaryDirectory() as tmp:
        for index, (title, messages) in enumerate(SCENARIOS, start=1):
            notifier = LogNotifier()
            agent = make_agent(settings, Path(tmp) / f"sim{index}.db", notifier)
            report += [f"## {title}", ""]
            print(f"\n=== {title} ===")
            for text in messages:
                reply = await agent.handle(
                    IncomingMessage(channel="telegram", user_id=f"sim{index}", text=text, client_ref=f"@sinov_mijoz_{index}")
                )
                shown = reply if reply else "(javob yo'q - operator rejimi, xabar guruhga uzatildi)"
                print(f"👤 {text}\n🤖 {shown}")
                report += [f"**👤 Mijoz:** {text}", "", f"**🤖 Bot:** {shown}", ""]
            report += [f"**Guruhga ketgan xabarlar ({len(notifier.sent)} ta):**", ""]
            for item in notifier.sent:
                reply_note = f" (#{item['reply_to']} ga javob)" if item["reply_to"] else ""
                report += [f"#{item['message_id']}{reply_note}:", "", "```", item["html"], "```", ""]
                print(f"--- guruh #{item['message_id']}{reply_note} ---\n{item['html']}")
    out_path.write_text("\n".join(report), encoding="utf-8")
    print(f"\nNatija saqlandi: {out_path}")


async def chat(settings) -> None:
    notifier = LogNotifier()
    with tempfile.TemporaryDirectory() as tmp:
        agent = make_agent(settings, Path(tmp) / "chat.db", notifier)
        print("Bot bilan yozishing (chiqish: Ctrl+C). Guruh xabarlari shu yerda ko'rinadi.\n")
        seen = 0
        while True:
            try:
                text = input("👤 ").strip()
            except (EOFError, KeyboardInterrupt):
                return
            if not text:
                continue
            reply = await agent.handle(IncomingMessage(channel="telegram", user_id="cli", text=text, client_ref="@terminal"))
            print(f"🤖 {reply or '(javob yo`q - operator rejimi)'}")
            for item in notifier.sent[seen:]:
                print(f"--- guruhga ketardi ---\n{item['html']}\n-----------------------")
            seen = len(notifier.sent)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--chat", action="store_true", help="terminalda bot bilan yozishish")
    parser.add_argument("--out", default=str(BASE_DIR / "sinov_natijalari.md"), help="natija fayli")
    args = parser.parse_args()
    try:
        settings = load_settings(require_telegram=False)
    except ConfigError as exc:
        sys.exit(f"Sozlamalarda xato: {exc}")
    asyncio.run(chat(settings) if args.chat else run_scenarios(settings, Path(args.out)))


if __name__ == "__main__":
    main()
