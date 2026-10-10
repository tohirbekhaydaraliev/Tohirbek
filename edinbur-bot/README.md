# Edinbur School — Telegram AI yordamchi bot

Mijoz botga yozadi. Bot (Claude AI) u bilan qisqa va samimiy suhbatlashadi, qaysi kursga qiziqishini,
ismi va telefon raqamini bilib oladi va tayyor arizani call-center Telegram guruhiga yuboradi.

- Markaz haqidagi ma'lumot faqat **`knowledge.md`** faylida. Bot shu fayldan tashqaridagi narsani (narx,
  chegirma, jadval…) to'qimaydi.
- O'zbekcha (lotin va kirill) va ruscha yozishadi: mijoz qaysi tilda yozsa, shu tilda javob beradi.
- Telefon `+998 XX XXX XX XX` ko'rinishiga keltiriladi, 9 ta raqam bo'lmasa qayta so'raladi.
- Bitta mijozdan bitta ariza ketadi. Ma'lumot keyin o'zgarsa, birinchi arizaga javob (reply) qilib
  "♻️ Ariza yangilandi" xabari yuboriladi.
- Mijoz norozi bo'lsa, operator so'rasa yoki murakkab savol bersa, guruhga "🚨 OPERATOR KERAK"
  xabari ketadi va AI shu mijozga javob berishni to'xtatadi (pastda batafsil).
- Suhbatlar SQLite bazada saqlanadi, bot qayta ishga tushsa ham yo'qolmaydi.
- Claude API ishlamay qolsa, mijozga "Birozdan keyin javob beramiz" deb yoziladi, xato logga tushadi,
  bot ishlashda davom etadi.

## Fayllar

```
edinbur-bot/
├── knowledge.md            ← markaz ma'lumoti (siz tahrirlaysiz)
├── .env.example            ← .env namunasi (maxfiy kalitlar)
├── bot/
│   ├── agent.py            ← asosiy mantiq: suhbat, ariza, operator (kanalga bog'liq emas)
│   ├── prompt.py           ← AI qoidalari (system prompt) va tool'lar
│   ├── leads.py            ← guruhga ketadigan xabar ko'rinishi
│   ├── phone.py            ← telefon tekshiruvi
│   ├── storage.py          ← SQLite baza
│   ├── llm.py              ← Claude API
│   └── channels/
│       ├── base.py         ← kanallar uchun umumiy turlar
│       └── telegram.py     ← Telegram (aiogram)
├── scripts/simulate.py     ← haqiqiy Claude bilan sinov suhbatlari (guruhga yubormaydi)
├── tests/                  ← avtomatik testlar
└── deploy/edinbur-bot.service  ← VPS uchun systemd fayli
```

## 1. Tayyorgarlik (bir marta)

1. **Bot token.** Telegram'da [@BotFather](https://t.me/BotFather) → `/newbot` → bergan tokenni saqlang.
2. **Claude API kaliti.** [platform.claude.com](https://platform.claude.com) → API Keys → yangi kalit,
   Billing bo'limida balans to'ldiring.
3. **Call-center guruhi.** Botni guruhga qo'shing (xabar yoza olishi kerak). Guruhda
   `/chatid@BotUsername` deb yozing — bot guruh ID sini aytadi (masalan `-1001234567890`).
4. `.env.example` ni `.env` nomi bilan nusxalang va uchta qiymatni yozing:
   `TELEGRAM_BOT_TOKEN`, `GROUP_CHAT_ID`, `ANTHROPIC_API_KEY`. `.env` gitga tushmaydi.

## 2. Kompyuterda ishga tushirish

Python 3.10+ kerak.

```bash
cd edinbur-bot
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m bot
```

Bir token bilan faqat **bitta** bot nusxasi ishlashi mumkin — serverga qo'ygach, kompyuterdagisini to'xtating.

## 3. Railway'ga joylash

1. Kodni GitHub'ga qo'ying (bu repo). [railway.com](https://railway.com) → New Project → Deploy from GitHub
   repo → shu repo.
2. Servis **Settings**:
   - **Root Directory:** `/edinbur-bot`
   - **Start Command:** `python -m bot`
3. **Variables** bo'limiga `.env` dagi qiymatlarni qo'shing: `TELEGRAM_BOT_TOKEN`, `GROUP_CHAT_ID`,
   `ANTHROPIC_API_KEY`, hamda:
   - `DATABASE_PATH` = `/data/bot.db`
   - `LOG_FILE` = `/data/bot.log`
4. **Volume qo'shing** (servis ustida o'ng tugma → Attach Volume), Mount path: `/data`.
   Bu muhim: volume bo'lmasa, har deploy'da suhbatlar bazasi o'chib ketadi.
5. Deploy. Loglarda `Bot ishga tushdi: @...` chiqsa — tayyor.

Bot "long polling" bilan ishlaydi: domen, port yoki webhook kerak emas. Railway'ning eng arzon (Hobby)
tarifi yetadi.

## 4. Oddiy VPS'ga joylash (Ubuntu)

```bash
sudo apt install -y python3 python3-venv git
git clone https://github.com/tohirbekhaydaraliev/Tohirbek.git
cd Tohirbek/edinbur-bot
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && nano .env        # uchta kalitni yozing

# doim ishlab tursin (server qayta yonsa ham):
nano deploy/edinbur-bot.service           # User va yo'llarni moslang
sudo cp deploy/edinbur-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now edinbur-bot
journalctl -u edinbur-bot -f              # loglarni ko'rish
```

Baza `data/bot.db` da, log `data/bot.log` da saqlanadi.

## 5. knowledge.md ni yangilash

`knowledge.md` — oddiy matn fayl. Kurs qo'shing, manzil yoki ish vaqtini o'zgartiring, narx/jadval
ma'lum bo'lsa yozing. Bilmagan joyingizga `[TO'LDIRING]` deb qoldiring — bot u haqida so'rashsa
"Buni operatorimiz aniq aytib beradi" deydi.

- **VPS:** `nano knowledge.md` → saqlang. Bot keyingi xabardanoq yangi ma'lumotni ishlatadi, qayta
  ishga tushirish shart emas.
- **Railway:** GitHub'da `edinbur-bot/knowledge.md` faylini oching → ✏️ (Edit) → o'zgartiring →
  **Commit changes**. Railway o'zi qayta deploy qiladi (1–2 daqiqa). Suhbatlar volume'da saqlanadi,
  yo'qolmaydi.

AI ning xulq-atvor qoidalari (qisqa yozish, narx to'qimaslik va h.k.) `bot/prompt.py` da.

## 6. Operator rejimi

Mijoz norozi bo'lsa, "odam bilan gaplashaman" desa yoki murakkab savol bersa (pul qaytarish, o'qituvchi
bilan muammo…):

1. Guruhga `🚨 OPERATOR KERAK` xabari ketadi: sabab va ma'lum ma'lumotlar.
2. Bot mijozga operator bog'lanishini aytadi (raqami bo'lmasa, raqam qoldirishni so'raydi).
3. Keyingi **24 soat** AI bu mijozga javob bermaydi. Mijozning yangi xabarlari guruhga
   (operator xabariga javob qilib) uzatiladi. Mijoz raqam yozsa, u saqlanadi va mijozga qisqa
   tasdiq yuboriladi.
4. 24 soatdan keyin (`HANDOFF_HOURS`) yoki mijoz `/start` bosganda AI yana suhbatni davom ettiradi.

## 7. Sinov

```bash
pip install -r requirements-dev.txt
pytest                                  # avtomatik testlar (Claude'siz, tez)
python scripts/simulate.py              # 5 ta sinov suhbati haqiqiy Claude bilan
python scripts/simulate.py --chat       # terminalda o'zingiz bot bilan yozishing
```

`simulate.py` uchun faqat `ANTHROPIC_API_KEY` kerak. U Telegram'ga ham, guruhga ham hech narsa
yubormaydi. Guruhga nima ketishini ekranga chiqaradi va natijani `sinov_natijalari.md` ga yozadi.
Botni Telegram'da guruhga yubormasdan sinash uchun `.env` ga `DRY_RUN=1` qo'shing: arizalar
faqat logga yoziladi.

## 8. Model va narx

Standart model — `claude-haiku-5-5` (eng arzon va tez). Xarajat taxminan: bitta xabarga 0.1 sentdan
kam, 1000 ta suhbatga bir necha dollar. `.env` da o'zgartirish mumkin:

- `ANTHROPIC_MODEL=claude-sonnet-5-5` — aqlliroq, qimmatroq
- `ANTHROPIC_EFFORT=low | medium | high` — qancha "o'ylashi" (standart `medium`)

## 9. Keyinroq: Instagram'ni ulash

Agent mantig'i (`bot/agent.py`) kanalga bog'liq emas. Instagram (Meta API) qo'shish uchun faqat yangi
`bot/channels/instagram.py` yoziladi:

1. Meta Developer'da ilova, Instagram Business akkaunt (@edinbur_school_shahrixon) va
   `instagram_manage_messages` ruxsati.
2. HTTPS webhook (masalan aiohttp server) Meta'dan kelgan xabarni qabul qiladi va
   `IncomingMessage(channel="instagram", user_id=<IGSID>, text=..., client_ref='<a href="https://instagram.com/USERNAME">@USERNAME</a>')`
   ko'rinishida `agent.handle()` ga beradi.
3. Qaytgan javob matni Graph API (`/me/messages`) orqali mijozga yuboriladi.

Arizalar xuddi shu Telegram guruhiga "🆕 Yangi ariza — Instagram" sarlavhasi bilan tushadi.
