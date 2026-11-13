# Yo'ldosh AI — arxitektura

Bu hujjat tizimning ichki ishlashini tushuntiradi: ma'lumot qanday yig'iladi, diagnostika engine qanday sabab topadi, AI agentlar qanday ishlaydi, harakatlar qanday xavfsiz bajariladi va tizim qanday o'rganadi.

## 1. Asosiy oqim

```
Connector (API pull / webhook push / CSV)
   → normallashtirilgan yozuvlar (NormalizedRecord)
   → ingest + identity resolution → yagona model (PostgreSQL)
   → metrikalar (SQL) → detektorlar (findings) → KPI daraxti → root cause → tavsiyalar
   → Action Layer (xavf → siyosat → auto | tasdiq) → kanallar (CRM, Telegram, Ads)
   → outcome (baseline → observed → verdict) → o'rganish statistikasi → ishonchlilik
```

Rejalashtiruvchi (`scheduler.ts`): har 15 daqiqada sync, har 10 daqiqada detektorlar + qoidalar, har soatda natijalarni baholash va kunlik diagnostika vaqtini tekshirish (biznes vaqt mintaqasida, standart 08:00).

## 2. Data Layer

`db/migrations/001_init.ts` — yagona biznes modeli. Barcha jadvallarda `business_id` bor (multi-tenant uchun tayyor).

| Guruh | Jadvallar |
|---|---|
| Connector qatlami | `connectors`, `sync_runs`, `raw_events` (webhook inbox, idempotentlik: `UNIQUE(business_id, source, external_id)`) |
| Biznes obyektlari | `branches`, `employees`, `products`, `groups` (sig'im birligi), `campaigns`, `ad_metrics_daily` |
| Mijoz | `customers` (**universal Customer ID**), `customer_identities` (telefon, email, telegram, `meta_lead`, `amocrm_contact`...) |
| Hayot sikli | `leads`, `interactions`, `subscriptions` (sotuv = obuna/kursga yozilish), `payments`, `attendance`, `tasks`, `notifications` |
| Kontekst | `targets` (goal / kpi / constraint), `business_rules` |
| Brain | `findings`, `diagnoses` (KPI'lar, daraxt, root cause, tavsiyalar, matn) |
| Harakat va o'rganish | `actions`, `outcomes` |
| AI suhbatlar | `conversations`, `messages` (`content` — API'ga aynan qayta yuboriladigan JSON **matn**; jsonb kalitlar tartibini o'zgartiradi) |

`db/client.ts` ikki drayverni bir xil interfeysga keltiradi: **PGlite** (WASM'dagi to'liq PostgreSQL, o'rnatishsiz) va **node-postgres** (`DATABASE_URL`). Ikkalasi bir xil SQL ishlatadi; testlar PGlite'da, production — haqiqiy PostgreSQL'da (PostgreSQL 16 da tekshirilgan).

### Identity resolution

`ingest/identity.ts`: har bir kontakt kalitlarga aylantiriladi (telefon E.164 ga normallashtiriladi: `90 123 45 67` → `+998901234567`). Kalitlardan biri mavjud mijozga mos kelsa — o'sha mijoz; bir nechta mijozga mos kelsa — eng eskisiga **birlashtiriladi** (barcha bog'liq jadvallar ko'chiriladi). Shu tufayli Meta lead, amoCRM kontakt va Payme to'lovi bitta Customer 360 ga tushadi.

## 3. Metrikalar va detektorlar

`metrics/queries.ts` — barcha KPI'lar SQL orqali: daromad (yangi / takroriy), segment voronkasi, javob vaqti (median, p90, SLA ulushi), kampaniyalar (CPL, CAC, ROAS), faol mijozlar, churn, kechikkan to'lovlar, davomat, menejerlar, sig'im, kunlik qatorlar.

Konversiya **davr nisbati** sifatida hisoblanadi (davrdagi sotuvlar / davrdagi leadlar) — yetilmagan kogortalar keltiradigan siljishni kamaytiradi. Sababiy dalil uchun esa **yetilgan kogorta** ishlatiladi (`conversionByResponseBucket`: 10 kundan eski leadlar, javob tezligi bo'yicha).

`brain/detectors.ts` — 7 ta detektor (`lead_unanswered`, `response_time_sla`, `customer_inactive`, `churn_risk`, `cac_above_target`, `group_capacity`, `payment_overdue`). Har biri parametrli, natijasi `findings` jadvaliga yoziladi (ochiq/yopilgan hayot sikli bilan) va taxminiy pul ta'siri (`impact`) hisoblanadi.

`cac_above_target` CAC o'sishining **sababini ajratadi**: agar shu segmentda javob vaqti keskin oshgan va CPL barqaror bo'lsa — sabab *sotuv bo'limida* (byudjetni kesish tavsiya qilinmaydi); CPL o'sgan yoki lead sifati tushgan bo'lsa — sabab *reklamada*.

`brain/scoring.ts` — tushuntiriladigan modellar: churn ehtimoli (davomat, faol bo'lmagan kunlar, to'lov kechikishi, davomat pasayishi, sodiqlik — logistik funksiya, sabablar ro'yxati bilan) va ochiq leadlar skoringi.

## 4. Diagnostika engine (Detect → Diagnose → Recommend)

`brain/diagnosis.ts`

### KPI daraxti

```
Daromad (yig'indi)
├─ Yangi mijozlar daromadi = Yangi to'lovchilar × O'rtacha birinchi to'lov   (ko'paytma)
│   └─ Sotuvlar (drayver) = Leadlar × Konversiya                           (ko'paytma)
│       ├─ Leadlar = Σ manbalar (kampaniyalar, organik)                     (yig'indi)
│       └─ Konversiya = Σ segment stavka effektlari + miks effekti
│           └─ Segment → drayverlar: javob vaqti, SLA ulushi, javobsizlar ulushi, sinov ulushi
│                      + dalillar: javob tezligi bo'yicha konversiya
└─ Takroriy to'lovlar = soni × o'rtacha summa
    └─ drayverlar: faol mijozlar, churn, kechikkan to'lovlar
```

Ko'paytma munosabatlarida o'zgarish **logarifmik dekompozitsiya** bilan taqsimlanadi:

```
hissa_i = Δ × ln(x_i1 / x_i0) / ln(V1 / V0)
```

Bu usul tartibga bog'liq emas va hissalar yig'indisi aynan Δ ga teng (testlar har bir tugunda buni tekshiradi). Nol qiymatlarda ketma-ket almashtirish usuliga o'tiladi.

### Root cause tanlash

1. Daromad ≥3% tushgan bo'lsa — ildizdan boshlab har qadamda **eng katta salbiy hissali** bolaga tushiladi (ulushi ≥25% bo'lsa).
2. Daromad tushmagan bo'lsa — eng yomon o'zgargan asosiy KPI (konversiya, leadlar, takroriy to'lovlar, AOV) dan boshlanadi.
3. Segmentga yetganda — **yuqori oqimdagi** drayver tanlanadi (javob vaqti → javobsizlar → SLA → sinov): javob sekinlashgani sinovlarning kamayishiga sabab bo'ladi, aksincha emas.
4. Dalillar yig'iladi: tez vs sekin javob konversiyasi, menejerlar konsentratsiyasi, leadlar barqarorligi, daromad pasayishidagi ulush. Ishonch darajasi dalillar kuchiga qarab oshadi.

### Tavsiyalar

Root cause va findings asosida: javobsiz leadlarni qayta taqsimlash (ortiqcha yuklangan menejer chiqarib tashlanadi), taqsimotni muvozanatlash vazifasi, retention, byudjetni qaytarish (qaror tarixidagi oldingi o'zgarish va uning natijasi hisobga olinadi), to'lov eslatmasi, lead routing. Har bir tavsiyaning ishonchi **o'rganish statistikasidan** hisoblanadi (Laplace silliqlash bilan). Tavsiyalar darhol Action Layer'ga taklif sifatida yuboriladi.

## 5. AI agentlar (Claude)

`agents/llm.ts` — qo'lda yozilgan agent sikli (Messages API, beta namespace):

- `client.beta.messages.stream()` + `finalMessage()`; CEO javobi UI'ga real vaqtda (SSE) uzatiladi;
- `thinking: { type: "adaptive" }`, `output_config.effort` (CEO — `high`, mutaxassislar — `medium`, matn yozish — `low`);
- `fallbacks: "default"` + `server-side-fallback-2026-07-01` — xavfsizlik klassifikatori rad etsa server boshqa modelda qayta ishlaydi; `refusal` holati alohida qayta ishlanadi;
- toollar `eager_input_streaming: true`, kirishlar zod bilan tekshiriladi, xato → `is_error` tool_result;
- bir javobdagi barcha tool chaqiruvlari parallel bajariladi va **bitta** user xabarida qaytariladi;
- system prompt statik (sana user xabariga qo'shiladi), tarix faqat qo'shib boriladi — prompt cache ishlaydi va thinking bloklari keyingi so'rovlarda o'zgarishsiz qayta yuboriladi.

`agents/specialists.ts` — Marketing, Sales, Finance, Customer, Operations agentlari, har biri o'z domen toollari bilan (`agents/tools.ts`, faqat o'qish, metrikalar qatlami orqali).

`agents/ceo.ts` — CEO Agent: `get_business_context`, `get_kpi_summary`, `get_decision_history`, `get_open_findings`, `get_pending_actions`, `run_diagnosis`, `consult_specialist` (mutaxassislar parallel), `propose_action`. CEO harakatni faqat taklif qiladi — bajarilishini Action Layer siyosati hal qiladi.

`agents/offline.ts` — AI kaliti bo'lmaganda engine asosidagi javoblar (ilova to'liq ishlaydi).

## 6. Action Layer

`actions/registry.ts` — 13 ta harakat: `create_task`, `notify_employee`, `reassign_leads`, `retention_outreach`, `send_payment_reminder`, `change_campaign_budget`, `pause_campaign`, `route_leads`, `update_lead_status`, `send_customer_message`, `issue_refund`, `analyze_campaign`, `update_sla`. Har birida: zod sxemasi, bazaviy (yoki dinamik) xavf, bajaruvchi va natijani o'lchash spetsifikatsiyasi.

`actions/policy.ts` — `high` har doim tasdiq; `low`/`medium` — biznes sozlamasiga ko'ra; agent taklif qilgan past xavfli harakatlar alohida sozlama bilan.

`actions/service.ts` — `propose → (auto | proposed) → approve/reject/ignore → executing → executed | failed`. Holat o'tishlari shartli `UPDATE ... WHERE status = ...` bilan (ikki marta tasdiqlab bo'lmaydi), `dedupe_key` uchun qisman unique indeks.

`actions/channels.ts` — kanallar: amoCRM (vazifa, mas'ul), Meta (byudjet, status), Telegram (xodim, mijoz, rahbar). Integratsiya ulanmagan bo'lsa — ichki tizimda bajariladi va `simulated: true` deb belgilanadi.

`context/rules.ts` — biznes qoidalari: detektor + parametrlar + harakat. Takrorlanishni oldini olish: obyektlar (lead/mijoz/to'lov) yaqinda qamrab olingan bo'lsa chiqarib tashlanadi, kalit — obyektlar to'plamining xeshi.

## 7. Feedback Loop

`feedback/outcomes.ts`: harakat bajarilganda `baseline` o'lchanadi va `evaluate_at` belgilanadi (masalan leadlar uchun 24 soat, davomat uchun 7 kun, CAC uchun 7 kun). Muddati kelganda `observed` o'lchanadi va verdikt chiqariladi (`improved` / `no_change` / `worsened`; ulushlar uchun 5 p.p., boshqalar uchun 5% chegarasi). `learningStats` har bir harakat turi samaradorligini beradi; diagnostika va agentlar uni ishlatadi.

## 8. Xavfsizlik

- `YOLDOSH_API_TOKEN` — API uchun Bearer token (vaqt bo'yicha xavfsiz taqqoslash);
- connector maxfiy maydonlari AES-256-GCM bilan shifrlanadi (`YOLDOSH_SECRET_KEY`), API'da maskalanadi;
- webhooklar: Meta `X-Hub-Signature-256`, to'lovlar `X-Yoldosh-Signature` (HMAC-SHA256), Telegram `secret_token`; inbox orqali idempotent;
- AI faqat o'qish toollari + `propose_action`; o'rta/yuqori xavfli harakatlar inson tasdig'isiz bajarilmaydi; CRM matnlari ma'lumot sifatida ko'rsatiladi (prompt injection'dan himoya);
- UI'da markdown faqat React elementlari orqali chiziladi (`innerHTML` yo'q).

## 9. Demo simulyatsiya

`demo/seed.ts` — deterministik (seed 2026) 120 kunlik simulyatsiya: ~3200 lead, ~600 faol talaba, oylik/paket to'lovlar, davomat, reklama metrikalari, qaror tarixi. Javob tezligining konversiyaga ta'siri simulyatsiyaga "haqiqiy" sababiy mexanizm sifatida kiritilgan — engine uni ma'lumotdan qayta topadi. `scripts/seed-search.ts` va `scripts/try-diagnosis.ts` — kalibrlash va natijani konsolda ko'rish uchun.
