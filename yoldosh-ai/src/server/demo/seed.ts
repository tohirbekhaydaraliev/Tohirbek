import type { Db } from '../db';
import { insertMany, json } from '../db';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { addDays, addMinutes, DAY, HOUR, isoDate, newId, now as clockNow } from '../lib/util';
import { Rng } from './random';

/**
 * Demo biznes: "Edinburg" o'quv markazi (ta'lim vertikali).
 *
 * Simulyatsiya qilingan manbalar: Meta Ads / Telegram Ads / Google Ads (reklama),
 * amoCRM (leadlar, menejerlar), Payme/Click (to'lovlar), davomat tizimi.
 *
 * Ichiga "yashirilgan" biznes hikoyasi (AI topishi kerak):
 *  1. ~28 kun oldin IELTS leadlari asosan Aziz'ga tusha boshladi va u ortiqcha yuklandi:
 *     birinchi javob vaqti ~12 daq → ~47 daq, ko'p leadlar umuman javobsiz qoldi.
 *     Javob tezligi konversiyaga sababiy ta'sir qiladi → IELTS sotuvlari, daromad tushdi.
 *  2. #17 Kids English kampaniyasi byudjeti 20 kun oldin +30% oshirildi, auditoriya
 *     to'yingani uchun CPL/CAC keskin oshdi.
 *  3. ~12 talaba davomati keskin tushgan (churn xavfi), ba'zilarida to'lov kechikkan.
 *  4. So'nggi oyda to'lovlar kechikishi ko'paygan (moliya signali).
 */

export const DEMO_BUSINESS_ID = 'biz_edinburg';

const TZ_OFFSET_HOURS = 5; // Asia/Tashkent (DST yo'q)
const UZS_PER_USD = 12_800;
const HISTORY_DAYS = 120;
const DEGRADE_START_DAY = -28; // IELTS javob vaqti yomonlashgan kun
const BUDGET_BUMP_DAY = -20; // #17 byudjeti oshirilgan kun

const MALE = ['Ali', 'Aziz', 'Bekzod', 'Bobur', 'Doniyor', 'Eldor', 'Farrux', 'Jahongir', 'Javohir', 'Jamshid', 'Kamron', 'Laziz', 'Mirjalol', 'Nodir', 'Otabek', 'Rustam', 'Sardor', 'Sherzod', 'Temur', "Ulug'bek", 'Xurshid', 'Yusuf', 'Zafar', 'Abdulloh', 'Muhammadali', 'Asadbek', 'Islom', 'Shohruh'];
const FEMALE = ['Aziza', 'Barno', 'Dildora', 'Feruza', 'Gulnora', 'Hilola', 'Kamola', 'Laylo', 'Malika', 'Mohira', 'Munisa', 'Nargiza', 'Nilufar', 'Oydin', 'Robiya', 'Sabina', 'Sevara', 'Shahzoda', 'Shoira', 'Yulduz', 'Zarina', 'Zilola', 'Mohinur', 'Sitora', 'Durdona', 'Charos'];
const SURNAMES = ['Karimov', 'Rahimov', 'Toshmatov', 'Yusupov', 'Azimov', 'Qodirov', 'Aliyev', 'Ismoilov', 'Ergashev', 'Saidov', 'Nazarov', 'Xolmatov', 'Sobirov', 'Abdullayev', 'Mirzayev', 'Hasanov', 'Usmonov', "Jo'rayev", 'Tursunov', 'Umarov', 'Normatov', 'Sultonov', 'Rasulov', 'Fayziyev'];
const LOST_REASONS = ['Narx qimmat', "Vaqt to'g'ri kelmadi", 'Boshqa markazni tanladi', 'Shunchaki qiziqdi', 'Manzil uzoq'];

type Segment = 'IELTS' | 'General English' | 'Kids English';

interface CampaignSpec {
  key: string;
  source: string;
  externalId: string;
  name: string;
  segment: Segment;
  leadsPerDay: number;
  cplUsd: number;
  activeFrom: number;
  activeTo: number;
  status: string;
}

const CAMPAIGNS: CampaignSpec[] = [
  { key: 'c12', source: 'meta_ads', externalId: '120211000000012', name: '#12 IELTS September', segment: 'IELTS', leadsPerDay: 8, cplUsd: 0.5, activeFrom: -HISTORY_DAYS, activeTo: 0, status: 'active' },
  { key: 'c13', source: 'meta_ads', externalId: '120211000000013', name: '#13 IELTS — keng auditoriya', segment: 'IELTS', leadsPerDay: 3, cplUsd: 1.4, activeFrom: -HISTORY_DAYS, activeTo: -70, status: 'paused' },
  { key: 'c14', source: 'telegram_ads', externalId: 'tg-ads-14', name: '#14 IELTS — Telegram Ads', segment: 'IELTS', leadsPerDay: 3, cplUsd: 0.8, activeFrom: -HISTORY_DAYS, activeTo: 0, status: 'active' },
  { key: 'c15', source: 'meta_ads', externalId: '120211000000015', name: '#15 General English Autumn', segment: 'General English', leadsPerDay: 6, cplUsd: 0.55, activeFrom: -HISTORY_DAYS, activeTo: 0, status: 'active' },
  { key: 'c17', source: 'meta_ads', externalId: '120211000000017', name: '#17 Kids English — Instagram', segment: 'Kids English', leadsPerDay: 4, cplUsd: 0.6, activeFrom: -HISTORY_DAYS, activeTo: 0, status: 'active' },
  { key: 'c18', source: 'google_ads', externalId: 'g-18', name: '#18 Google Search — IELTS', segment: 'IELTS', leadsPerDay: 2, cplUsd: 0.9, activeFrom: -HISTORY_DAYS, activeTo: 0, status: 'active' },
];

const ORGANIC_SOURCES: Array<readonly [string, number]> = [
  ['website', 1.2],
  ['referral', 1.0],
  ['instagram', 0.8],
];

// IELTS ko'pincha 3 oylik paket sifatida oldindan to'lanadi (10% chegirma), qolganlar — oylik.
const PRODUCTS: Array<{ key: Segment; name: string; price: number; keywords: string[]; groups: number; monthlyChurn: number; baseStudents: number; packageShare: number }> = [
  { key: 'IELTS', name: 'IELTS', price: 1_800_000, keywords: ['ielts', 'band'], groups: 10, monthlyChurn: 0.25, baseStudents: 190, packageShare: 0.85 },
  { key: 'General English', name: 'General English', price: 1_200_000, keywords: ['general', 'ingliz tili'], groups: 11, monthlyChurn: 0.1, baseStudents: 225, packageShare: 0 },
  { key: 'Kids English', name: 'Kids English', price: 900_000, keywords: ['kids', 'bolalar'], groups: 9, monthlyChurn: 0.08, baseStudents: 190, packageShare: 0 },
];
const PACKAGE_MONTHS = 3;
const PACKAGE_DISCOUNT = 0.1;

// Segment bo'yicha bazaviy konversiya
const BASE_TRIAL: Record<Segment, number> = { IELTS: 0.3, 'General English': 0.27, 'Kids English': 0.3 };
const WIN_GIVEN_TRIAL: Record<Segment, number> = { IELTS: 0.55, 'General English': 0.5, 'Kids English': 0.58 };

/** Javob tezligining sotuvga ta'siri (simulyatsiyadagi "haqiqiy" sababiy mexanizm) */
function speedFactor(minutes: number | null): number {
  if (minutes === null) return 0;
  if (minutes <= 15) return 1;
  if (minutes <= 60) return 0.62;
  if (minutes <= 240) return 0.38;
  return 0.2;
}

interface SimLead {
  id: string;
  customerId: string;
  campaignKey: string | null;
  source: string;
  segment: Segment;
  managerKey: string;
  createdAt: Date;
  firstResponseAt: Date | null;
  trialAt: Date | null;
  wonAt: Date | null;
  lostAt: Date | null;
  lostReason: string | null;
  status: string;
}

interface SimSub {
  id: string;
  customerId: string;
  segment: Segment;
  groupId: string;
  leadId: string | null;
  soldBy: string | null;
  price: number;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
  endReason: string | null;
  propensity: number;
  atRisk: boolean;
}

export interface SeedOptions {
  businessId?: string;
  now?: Date;
  seed?: number;
}

export async function seedDemo(db: Db, opts: SeedOptions = {}): Promise<string> {
  const businessId = opts.businessId ?? DEMO_BUSINESS_ID;
  const rng = new Rng(opts.seed ?? 2026);
  const now = opts.now ?? clockNow();

  // Bugungi mahalliy kun boshi (UTC'da)
  const localNow = new Date(now.getTime() + TZ_OFFSET_HOURS * HOUR);
  const todayStart = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - TZ_OFFSET_HOURS * HOUR);
  const dayStart = (d: number) => addDays(todayStart, d);
  const dayOf = (t: Date) => Math.floor((t.getTime() - todayStart.getTime()) / DAY);

  const usedPhones = new Set<string>();
  const randomPhone = () => {
    for (;;) {
      const op = rng.pick(['90', '91', '93', '94', '95', '97', '98', '99', '33', '88']);
      const phone = `+998${op}${String(rng.int(0, 9_999_999)).padStart(7, '0')}`;
      if (!usedPhones.has(phone)) {
        usedPhones.add(phone);
        return phone;
      }
    }
  };
  const randomName = () => {
    const female = rng.chance(0.5);
    const first = rng.pick(female ? FEMALE : MALE);
    const last = rng.pick(SURNAMES);
    return `${first} ${female ? `${last}a` : last}`;
  };

  // ---------- Biznes ----------
  await db.query(
    `INSERT INTO businesses (id, name, vertical, currency, timezone, strategy, priorities, settings, created_at)
     VALUES ($1,$2,'education','UZS','Asia/Tashkent',$3,$4,$5,$6)`,
    [
      businessId,
      "Edinburg o'quv markazi",
      "Toshkentdagi ingliz tili markazi. 2026-yil oxirigacha 1500 faol talabaga chiqish. Asosiy daromad — IELTS va General English. Sifatli o'qituvchilar va tez xizmat orqali o'sish; reklamada CAC'ni 80 000 so'mdan oshirmaslik.",
      json(['IELTS', 'General English']),
      DEFAULT_SETTINGS,
      addDays(now, -HISTORY_DAYS - 300),
    ],
  );

  await insertMany(
    db,
    'targets',
    ['id', 'business_id', 'kind', 'metric', 'label', 'target', 'comparator', 'segment', 'priority'],
    [
      [newId('tgt'), businessId, 'goal', 'active_customers', 'Faol talabalar soni', 1500, 'gte', null, 1],
      [newId('tgt'), businessId, 'goal', 'revenue', 'Oylik daromad', 1_000_000_000, 'gte', null, 1],
      [newId('tgt'), businessId, 'kpi', 'cac', 'Maqsad CAC', 80_000, 'lte', null, 1],
      [newId('tgt'), businessId, 'kpi', 'conversion_rate', 'Lead → sotuv konversiyasi', 0.12, 'gte', null, 1],
      [newId('tgt'), businessId, 'kpi', 'response_time_minutes', 'Leadga birinchi javob (SLA)', 15, 'lte', null, 1],
      [newId('tgt'), businessId, 'kpi', 'retention_months', "O'rtacha qolish muddati", 8, 'gte', null, 2],
      [newId('tgt'), businessId, 'kpi', 'attendance_rate', 'Davomat', 0.85, 'gte', null, 2],
      [newId('tgt'), businessId, 'constraint', 'max_group_size', 'Maksimal guruh hajmi', 25, 'lte', null, 2],
    ],
  );

  // ---------- Filiallar, xodimlar ----------
  const branches = { chilonzor: newId('brn'), yunusobod: newId('brn') };
  await insertMany(db, 'branches', ['id', 'business_id', 'name', 'city'], [
    [branches.chilonzor, businessId, 'Chilonzor', 'Toshkent'],
    [branches.yunusobod, businessId, 'Yunusobod', 'Toshkent'],
  ]);

  const emp: Record<string, string> = {};
  const employees: Array<[string, string, string, string]> = [
    ['aziz', 'Aziz Karimov', 'sales_manager', branches.chilonzor],
    ['dilnoza', 'Dilnoza Rahimova', 'sales_manager', branches.chilonzor],
    ['jasur', 'Jasur Toshmatov', 'sales_manager', branches.yunusobod],
    ['madina', 'Madina Yusupova', 'sales_manager', branches.yunusobod],
    ['nodira', 'Nodira Azimova', 'retention_manager', branches.chilonzor],
    ['sardor', 'Sardor Qodirov', 'finance', branches.chilonzor],
    ['owner', 'Rahbar (CEO)', 'owner', branches.chilonzor],
    ['t1', 'Kamola Ergasheva', 'teacher', branches.chilonzor],
    ['t2', 'Javohir Saidov', 'teacher', branches.chilonzor],
    ['t3', 'Nilufar Nazarova', 'teacher', branches.yunusobod],
    ['t4', 'Otabek Sobirov', 'teacher', branches.yunusobod],
    ['t5', 'Malika Hasanova', 'teacher', branches.chilonzor],
    ['t6', 'Temur Usmonov', 'teacher', branches.yunusobod],
  ];
  await insertMany(
    db,
    'employees',
    ['id', 'business_id', 'name', 'role', 'branch_id', 'source', 'external_id'],
    employees.map(([key, name, role, branch]) => {
      emp[key] = newId('emp');
      return [emp[key], businessId, name, role, branch, 'amocrm', `user-${key}`];
    }),
  );

  // ---------- Mahsulotlar va guruhlar ----------
  const productId: Record<string, string> = {};
  await insertMany(
    db,
    'products',
    ['id', 'business_id', 'name', 'segment', 'price', 'billing', 'keywords'],
    PRODUCTS.map((p) => {
      productId[p.key] = newId('prd');
      return [productId[p.key], businessId, p.name, p.key, p.price, 'monthly', p.keywords];
    }),
  );

  const groupsBySegment: Record<string, Array<{ id: string; capacity: number; ends: number[] }>> = {};
  const groupRows: unknown[][] = [];
  const teachers = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const slots = ['08:00', '10:00', '14:00', '16:00', '18:00', '19:30'];
  for (const p of PRODUCTS) {
    groupsBySegment[p.key] = [];
    for (let i = 1; i <= p.groups; i++) {
      const id = newId('grp');
      const branch = i % 2 === 1 ? branches.chilonzor : branches.yunusobod;
      const capacity = 25;
      groupsBySegment[p.key].push({ id, capacity, ends: [] });
      groupRows.push([
        id,
        businessId,
        productId[p.key],
        branch,
        emp[teachers[(i + p.groups) % teachers.length]],
        `${p.key === 'General English' ? 'GE' : p.key === 'Kids English' ? 'Kids' : 'IELTS'}-${i} (${i % 2 === 1 ? 'Chilonzor' : 'Yunusobod'}, ${slots[i % slots.length]})`,
        capacity,
        i % 2 === 1 ? 'Du-Chor-Ju' : 'Se-Pay-Sha',
      ]);
    }
  }
  await insertMany(db, 'groups', ['id', 'business_id', 'product_id', 'branch_id', 'teacher_id', 'name', 'capacity', 'schedule'], groupRows);

  // ---------- Kampaniyalar ----------
  const campaignId: Record<string, string> = {};
  await insertMany(
    db,
    'campaigns',
    ['id', 'business_id', 'source', 'external_id', 'name', 'segment', 'status', 'daily_budget', 'started_at'],
    CAMPAIGNS.map((c) => {
      campaignId[c.key] = newId('cmp');
      const budget = Math.round(c.leadsPerDay * c.cplUsd * UZS_PER_USD * (c.key === 'c17' ? 1.3 : 1));
      return [campaignId[c.key], businessId, c.source, c.externalId, c.name, c.segment, c.status, budget, dayStart(c.activeFrom)];
    }),
  );

  // ---------- Leadlar ----------
  const customers: unknown[][] = [];
  const identities: unknown[][] = [];
  const leads: SimLead[] = [];
  const interactions: unknown[][] = [];
  const campaignLeadsPerDay = new Map<string, number>();

  const addCustomer = (name: string, phone: string, source: string, firstSeen: Date, campaignKey: string | null, extra: { telegram?: string | null; email?: string | null } = {}) => {
    const id = newId('cus');
    customers.push([id, businessId, name, phone, extra.email ?? null, extra.telegram ?? null, source, campaignKey ? campaignId[campaignKey] : null, firstSeen, firstSeen]);
    identities.push([newId('cid'), businessId, id, 'phone', phone, source]);
    if (extra.telegram) identities.push([newId('cid'), businessId, id, 'telegram', extra.telegram, source]);
    return id;
  };

  const assignManager = (segment: Segment, day: number): string => {
    const degraded = day >= DEGRADE_START_DAY;
    if (segment === 'IELTS') {
      return degraded ? rng.weighted([['aziz', 0.88], ['dilnoza', 0.12]] as const) : rng.weighted([['aziz', 0.6], ['dilnoza', 0.4]] as const);
    }
    if (segment === 'General English') {
      return degraded
        ? rng.weighted([['jasur', 0.4], ['madina', 0.3], ['dilnoza', 0.3]] as const)
        : rng.weighted([['jasur', 0.5], ['madina', 0.35], ['dilnoza', 0.15]] as const);
    }
    return rng.weighted([['madina', 0.6], ['jasur', 0.4]] as const);
  };

  const responseMinutes = (manager: string, day: number): number | null => {
    const degraded = day >= DEGRADE_START_DAY;
    if (manager === 'aziz' && degraded) {
      // Ortiqcha yuklama: sekin javob va ko'p leadlar umuman javobsiz
      if (day >= -14 && rng.chance(0.16)) return null;
      if (rng.chance(0.04)) return null;
      return rng.lognormal(60, 0.9);
    }
    if (rng.chance(0.012)) return null;
    const median = { aziz: 11, dilnoza: 12, jasur: 13, madina: 10 }[manager] ?? 12;
    return rng.lognormal(median, 0.75);
  };

  const simulateLead = (segment: Segment, source: string, campaignKey: string | null, createdAt: Date) => {
    const day = dayOf(createdAt);
    const manager = assignManager(segment, day);
    let rt = responseMinutes(manager, day);
    let firstResponseAt = rt === null ? null : addMinutes(createdAt, rt);
    if (firstResponseAt && firstResponseAt > now) {
      firstResponseAt = null; // hali javob berilmagan (yaqinda kelgan)
      rt = null;
    }
    // #17 byudjeti oshirilgach auditoriya kengaydi — leadlar sifati pasaydi
    const quality = campaignKey === 'c17' && day >= BUDGET_BUMP_DAY ? 0.8 : 1;
    const pTrial = BASE_TRIAL[segment] * speedFactor(rt) * quality;
    let trialAt: Date | null = null;
    let wonAt: Date | null = null;
    let lostAt: Date | null = null;
    let lostReason: string | null = null;
    if (firstResponseAt && rng.chance(pTrial)) {
      trialAt = addHours(firstResponseAt, rng.range(20, 96));
      if (rng.chance(WIN_GIVEN_TRIAL[segment])) {
        wonAt = addHours(trialAt, rng.range(4, 72));
      } else {
        lostAt = addHours(trialAt, rng.range(24, 120));
        lostReason = rng.pick(LOST_REASONS);
      }
    } else if (firstResponseAt) {
      lostAt = addHours(firstResponseAt, rng.range(24, 200));
      lostReason = rng.pick(LOST_REASONS);
    } else if (day < -14) {
      // Juda eski javobsiz leadlar yo'qotilgan deb belgilangan
      lostAt = addDays(createdAt, rng.range(3, 6));
      lostReason = 'Javob kutib qoldi';
    }
    if (trialAt && trialAt > now) {
      trialAt = null;
      wonAt = null;
      lostAt = null;
      lostReason = null;
    }
    if (wonAt && wonAt > now) wonAt = null;
    if (lostAt && lostAt > now) {
      lostAt = null;
      lostReason = null;
    }
    const status = wonAt ? 'won' : lostAt ? 'lost' : trialAt ? 'trial' : firstResponseAt ? 'contacted' : 'new';

    const name = randomName();
    const phone = randomPhone();
    const telegram = rng.chance(0.35) ? `${name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '')}_${rng.int(10, 9999)}` : null;
    const customerId = addCustomer(name, phone, source, createdAt, campaignKey, { telegram });
    const lead: SimLead = {
      id: newId('led'),
      customerId,
      campaignKey,
      source,
      segment,
      managerKey: manager,
      createdAt,
      firstResponseAt,
      trialAt,
      wonAt,
      lostAt,
      lostReason,
      status,
    };
    identities.push([newId('cid'), businessId, customerId, 'amocrm_lead', lead.id, 'amocrm']);
    leads.push(lead);

    if (firstResponseAt) {
      interactions.push([newId('int'), businessId, customerId, lead.id, emp[manager], rng.pick(['call', 'call', 'telegram']), 'out', firstResponseAt, 'Birinchi aloqa: kurs haqida maʼlumot berildi', 'amocrm', null]);
    }
    if (trialAt) {
      interactions.push([newId('int'), businessId, customerId, lead.id, emp[manager], 'visit', 'in', trialAt, 'Sinov darsiga keldi', 'amocrm', null]);
    }
    if (wonAt) {
      interactions.push([newId('int'), businessId, customerId, lead.id, emp[manager], 'visit', 'in', wonAt, "Shartnoma imzolandi, to'lov qilindi", 'amocrm', null]);
    }
    if (campaignKey) {
      const k = `${campaignKey}:${day}`;
      campaignLeadsPerDay.set(k, (campaignLeadsPerDay.get(k) ?? 0) + 1);
    }
    return lead;
  };

  const randomTimeInDay = (d: number): Date | null => {
    // Ish vaqti 08:00–22:00 (mahalliy), ertalab va kechqurun cho'qqi
    const localHour = rng.weighted([[8, 0.5], [9, 0.8], [10, 1], [11, 1], [12, 0.9], [13, 0.8], [14, 0.9], [15, 1], [16, 1], [17, 1], [18, 1.1], [19, 1.2], [20, 1], [21, 0.6]] as const);
    const t = new Date(dayStart(d).getTime() + (localHour + rng.next()) * HOUR);
    return t > now ? null : t;
  };

  for (let d = -HISTORY_DAYS + 1; d <= 0; d++) {
    const weekday = new Date(dayStart(d).getTime() + TZ_OFFSET_HOURS * HOUR).getUTCDay();
    const dowFactor = weekday === 0 ? 0.6 : weekday === 6 ? 0.8 : 1.05;
    for (const c of CAMPAIGNS) {
      if (d < c.activeFrom || d > c.activeTo || (c.status === 'paused' && d > c.activeTo)) continue;
      let lambda = c.leadsPerDay * dowFactor;
      if (c.key === 'c17' && d >= BUDGET_BUMP_DAY) lambda *= 1.05; // byudjet +30%, leadlar deyarli o'smadi
      const n = rng.poisson(lambda);
      for (let i = 0; i < n; i++) {
        const t = randomTimeInDay(d);
        if (t) simulateLead(c.segment, c.source, c.key, t);
      }
    }
    for (const [source, lambda] of ORGANIC_SOURCES) {
      const n = rng.poisson(lambda * dowFactor);
      for (let i = 0; i < n; i++) {
        const t = randomTimeInDay(d);
        if (!t) continue;
        const segment = rng.weighted([['IELTS', 0.4], ['General English', 0.4], ['Kids English', 0.2]] as const);
        simulateLead(segment, source, null, t);
      }
    }
  }

  // Ali Valiyev — Customer 360 namunasi (spetsifikatsiyadagi misol)
  const aliCreated = new Date(dayStart(-27).getTime() + 11.2 * HOUR);
  const aliCustomer = addCustomer('Ali Valiyev', '+998901234567', 'instagram', aliCreated, 'c12', { telegram: 'ali_valiyev' });
  const aliLead: SimLead = {
    id: newId('led'),
    customerId: aliCustomer,
    campaignKey: 'c12',
    source: 'meta_ads',
    segment: 'IELTS',
    managerKey: 'aziz',
    createdAt: aliCreated,
    firstResponseAt: addMinutes(aliCreated, 8),
    trialAt: addDays(aliCreated, 2),
    wonAt: addDays(aliCreated, 4),
    lostAt: null,
    lostReason: null,
    status: 'won',
  };
  leads.push(aliLead);
  identities.push([newId('cid'), businessId, aliCustomer, 'meta_lead', 'lg-ali-0910', 'meta_ads']);
  interactions.push(
    [newId('int'), businessId, aliCustomer, aliLead.id, emp.aziz, 'call', 'out', aliLead.firstResponseAt, "Birinchi qo'ng'iroq: IELTS kursi haqida", 'amocrm', null],
    [newId('int'), businessId, aliCustomer, aliLead.id, emp.aziz, 'visit', 'in', aliLead.trialAt, 'Sinov darsiga keldi', 'amocrm', null],
    [newId('int'), businessId, aliCustomer, aliLead.id, emp.aziz, 'visit', 'in', aliLead.wonAt, "Shartnoma imzolandi, to'lov qilindi", 'amocrm', null],
  );

  // ---------- Obunalar (talabalar) ----------
  const subs: SimSub[] = [];
  const pickGroup = (segment: Segment, start: Date, end: Date | null): string => {
    const groups = groupsBySegment[segment];
    const activeAt = (g: (typeof groups)[number]) => g.ends.filter((e) => e > start.getTime()).length;
    let chosen = groups[0];
    if (rng.chance(0.45) && activeAt(groups[0]) < groups[0].capacity) {
      chosen = groups[0]; // mashhur vaqt — birinchi guruh tez to'ladi
    } else {
      chosen = groups.reduce((best, g) => (activeAt(g) < activeAt(best) ? g : best), groups[0]);
    }
    chosen.ends.push(end ? end.getTime() : Number.MAX_SAFE_INTEGER);
    return chosen.id;
  };

  const productBySegment = Object.fromEntries(PRODUCTS.map((p) => [p.key, p]));
  const payments: unknown[][] = [];

  const simulateSubscription = (opts: {
    customerId: string;
    segment: Segment;
    startedAt: Date;
    leadId: string | null;
    soldBy: string | null;
    isNew: boolean;
    forceMonthly?: boolean;
    churnFrom?: Date;
  }) => {
    const product = productBySegment[opts.segment];
    const isPackage = !opts.forceMonthly && rng.chance(product.packageShare);
    const cycleMonths = isPackage ? PACKAGE_MONTHS : 1;
    const amount = isPackage ? Math.round(product.price * PACKAGE_MONTHS * (1 - PACKAGE_DISCOUNT)) : product.price;
    const price = Math.round(amount / cycleMonths); // oylik ekvivalent
    const propensity = Math.min(0.98, Math.max(0.55, rng.normal(0.88, 0.07)));
    // Har to'lov davri oxirida yangilanish; har yangilanishda churn ehtimoli
    let endedAt: Date | null = null;
    let endReason: string | null = null;
    let status = 'active';
    const paymentsForSub: Array<{ due: Date; kind: string }> = [];
    if (opts.isNew) paymentsForSub.push({ due: opts.startedAt, kind: 'new' });
    for (let k = 1; k < 40; k++) {
      const due = addDays(opts.startedAt, 30 * cycleMonths * k);
      if (due > now) break;
      const monthly = product.monthlyChurn * (propensity < 0.75 ? 1.8 : 1);
      const churnP = 1 - (1 - monthly) ** cycleMonths;
      // Boshlang'ich baza: simulyatsiya boshlanguncha "tirik" deb qabul qilinadi (barqaror holat)
      const churnApplies = !opts.churnFrom || due >= opts.churnFrom;
      if (churnApplies && rng.chance(churnP)) {
        endedAt = due;
        const completed = opts.segment === 'IELTS' && rng.chance(0.45);
        status = completed ? 'completed' : 'churned';
        endReason = completed ? 'Kurs yakunlandi' : rng.pick(["Vaqt yo'q", 'Narx', "Natijadan qoniqmadi", "Ko'chib ketdi", "Boshqa markazga o'tdi"]);
        break;
      }
      paymentsForSub.push({ due, kind: 'renewal' });
    }
    const groupId = pickGroup(opts.segment, opts.startedAt, endedAt);
    const sub: SimSub = {
      id: newId('sub'),
      customerId: opts.customerId,
      segment: opts.segment,
      groupId,
      leadId: opts.leadId,
      soldBy: opts.soldBy,
      price,
      startedAt: opts.startedAt,
      endedAt,
      status,
      endReason,
      propensity,
      atRisk: false,
    };
    subs.push(sub);

    for (const p of paymentsForSub) {
      if (p.due < dayStart(-HISTORY_DAYS)) continue;
      const recent = dayOf(p.due) >= -30;
      let paidAt: Date | null;
      if (p.kind === 'new') {
        paidAt = p.due;
      } else {
        // So'nggi oyda to'lov intizomi yomonlashgan (moliya signali)
        const lagDays = rng.weighted(
          recent
            ? ([[0, 0.4], [2, 0.27], [6, 0.17], [11, 0.09], [-1, 0.07]] as const)
            : ([[0, 0.5], [2, 0.3], [6, 0.14], [11, 0.05], [-1, 0.01]] as const),
        );
        paidAt = lagDays < 0 ? null : addHours(p.due, lagDays * 24 + rng.range(1, 30));
        if (paidAt && paidAt > now) paidAt = null;
      }
      const dueDate = isoDate(new Date(p.due.getTime() + TZ_OFFSET_HOURS * HOUR));
      const status = paidAt ? 'paid' : dayOf(p.due) < 0 ? 'overdue' : 'pending';
      payments.push([
        newId('pay'),
        businessId,
        opts.customerId,
        sub.id,
        amount,
        rng.weighted([['payme', 0.4], ['click', 0.35], ['cash', 0.15], ['uzum', 0.1]] as const),
        status,
        p.kind,
        dueDate,
        paidAt,
        rng.chance(0.5) ? 'payme' : 'click',
        newId('ext'),
      ]);
    }
    return sub;
  };

  // Boshlang'ich talabalar bazasi (simulyatsiya boshlanishidan oldin yozilganlar)
  // Yoshi barqaror holat taqsimotidan olinadi (eksponensial, o'rtacha = 1/churn oy)
  for (const p of PRODUCTS) {
    for (let i = 0; i < p.baseStudents; i++) {
      // Juda uzoq muddatlilar modulo bilan yoyiladi (bir kunga to'planib qolmasligi uchun)
      const ageDays = 5 + ((-Math.log(1 - rng.next()) * (30 / p.monthlyChurn)) % 325);
      const startedAt = addDays(dayStart(-HISTORY_DAYS), -ageDays);
      const name = randomName();
      const customerId = addCustomer(name, randomPhone(), rng.pick(['referral', 'website', 'instagram', 'walk_in']), startedAt, null);
      simulateSubscription({ customerId, segment: p.key, startedAt, leadId: null, soldBy: null, isNew: false, churnFrom: dayStart(-HISTORY_DAYS) });
    }
  }
  // Yangi sotuvlar (yutilgan leadlar)
  for (const l of [...leads].sort((a, b) => (a.wonAt?.getTime() ?? 0) - (b.wonAt?.getTime() ?? 0))) {
    if (!l.wonAt) continue;
    simulateSubscription({
      customerId: l.customerId,
      segment: l.segment,
      startedAt: l.wonAt,
      leadId: l.id,
      soldBy: emp[l.managerKey],
      isNew: true,
      forceMonthly: l.customerId === aliCustomer,
    });
  }

  // Churn xavfidagi ~12 talaba: davomati keskin tushgan
  const aliSub = subs.find((s) => s.customerId === aliCustomer)!;
  const eligible = subs.filter(
    (s) => s.status === 'active' && s.startedAt < addDays(now, -45) && s.customerId !== aliCustomer,
  );
  const atRisk = rng.shuffle(eligible).slice(0, 11);
  for (const s of atRisk) s.atRisk = true;
  aliSub.atRisk = true;

  // ---------- Davomat (so'nggi 60 kun) ----------
  const attendance: unknown[][] = [];
  const attendanceStart = -60;
  const groupDays = new Map<string, number[]>();
  for (const [seg, groups] of Object.entries(groupsBySegment)) {
    groups.forEach((g, i) => groupDays.set(g.id, (i + seg.length) % 2 === 0 ? [1, 3, 5] : [2, 4, 6]));
  }
  for (const s of subs) {
    const days = groupDays.get(s.groupId)!;
    const lastSeenGap = s.atRisk ? (s.customerId === aliCustomer ? 5 : rng.int(6, 12)) : 0;
    for (let d = attendanceStart; d <= 0; d++) {
      const date = dayStart(d);
      const lessonTime = new Date(date.getTime() + 14 * HOUR);
      if (lessonTime > now) continue;
      if (lessonTime < s.startedAt) continue;
      if (s.endedAt && lessonTime >= s.endedAt) continue;
      const weekday = new Date(date.getTime() + TZ_OFFSET_HOURS * HOUR).getUTCDay();
      if (!days.includes(weekday)) continue;
      let p = s.propensity;
      // Ketishidan oldingi 3 hafta davomida davomat pasayadi
      if (s.endedAt) {
        const daysToEnd = (s.endedAt.getTime() - lessonTime.getTime()) / DAY;
        if (daysToEnd < 21) p *= 0.45 + (daysToEnd / 21) * 0.5;
      }
      if (s.atRisk) {
        if (d > -lastSeenGap) p = 0;
        else if (d > -21) p = 0.3;
      }
      if (s.customerId === aliCustomer) p = d > -lastSeenGap ? 0 : d > -12 ? 0.5 : 0.92;
      attendance.push([businessId, s.customerId, s.groupId, isoDate(new Date(date.getTime() + TZ_OFFSET_HOURS * HOUR)), rng.chance(p)]);
    }
  }

  // Xavfdagi talabalarning bir qismida oxirgi to'lov kechikkan
  const riskOverdue = new Set(atRisk.slice(0, 5).map((s) => s.id));
  for (const row of payments) {
    const subId = row[3] as string;
    if (riskOverdue.has(subId) && row[7] === 'renewal') {
      const due = row[8] as string;
      if (due >= isoDate(addDays(now, -20))) {
        row[6] = due < isoDate(now) ? 'overdue' : 'pending';
        row[9] = null;
      }
    }
  }

  // ---------- Bazaga yozish ----------
  await insertMany(db, 'customers', ['id', 'business_id', 'full_name', 'phone', 'email', 'telegram', 'source', 'first_campaign_id', 'first_seen_at', 'created_at'], customers);
  await insertMany(db, 'customer_identities', ['id', 'business_id', 'customer_id', 'kind', 'value', 'source'], identities, {
    onConflict: 'ON CONFLICT DO NOTHING',
  });
  await insertMany(
    db,
    'leads',
    ['id', 'business_id', 'customer_id', 'campaign_id', 'product_id', 'segment', 'source', 'external_id', 'status', 'assigned_to', 'created_at', 'first_response_at', 'trial_at', 'won_at', 'lost_at', 'lost_reason', 'value', 'updated_at'],
    leads.map((l) => [
      l.id,
      businessId,
      l.customerId,
      l.campaignKey ? campaignId[l.campaignKey] : null,
      productId[l.segment],
      l.segment,
      'amocrm',
      `amo-${l.id.slice(4)}`,
      l.status,
      emp[l.managerKey],
      l.createdAt,
      l.firstResponseAt,
      l.trialAt,
      l.wonAt,
      l.lostAt,
      l.lostReason,
      productBySegment[l.segment].price,
      l.wonAt ?? l.lostAt ?? l.trialAt ?? l.firstResponseAt ?? l.createdAt,
    ]),
  );
  await insertMany(db, 'interactions', ['id', 'business_id', 'customer_id', 'lead_id', 'employee_id', 'channel', 'direction', 'occurred_at', 'summary', 'source', 'external_id'], interactions);
  await insertMany(
    db,
    'subscriptions',
    ['id', 'business_id', 'customer_id', 'product_id', 'group_id', 'lead_id', 'sold_by', 'status', 'price', 'started_at', 'ended_at', 'end_reason'],
    subs.map((s) => [s.id, businessId, s.customerId, productId[s.segment], s.groupId, s.leadId, s.soldBy, s.status, s.price, s.startedAt, s.endedAt, s.endReason]),
  );
  await insertMany(db, 'payments', ['id', 'business_id', 'customer_id', 'subscription_id', 'amount', 'method', 'status', 'kind', 'due_date', 'paid_at', 'source', 'external_id'], payments);
  await insertMany(db, 'attendance', ['business_id', 'customer_id', 'group_id', 'date', 'present'], attendance, {
    onConflict: 'ON CONFLICT DO NOTHING',
  });

  // ---------- Reklama metrikalari ----------
  const adRows: unknown[][] = [];
  for (const c of CAMPAIGNS) {
    for (let d = Math.max(c.activeFrom, -HISTORY_DAYS + 1); d <= Math.min(c.activeTo, -1); d++) {
      const crmLeads = campaignLeadsPerDay.get(`${c.key}:${d}`) ?? 0;
      let cpl = c.cplUsd;
      if (c.key === 'c17' && d >= BUDGET_BUMP_DAY) cpl *= 1.25; // auditoriya to'yingan
      const platformLeads = Math.round(crmLeads * rng.range(1.0, 1.12));
      const spendUsd = Math.max(0, (platformLeads || c.leadsPerDay * 0.4) * cpl * rng.range(0.9, 1.1));
      const impressions = Math.round(spendUsd * rng.range(380, 520));
      const clicks = Math.round(impressions * rng.range(0.011, 0.019));
      const date = isoDate(new Date(dayStart(d).getTime() + TZ_OFFSET_HOURS * HOUR));
      adRows.push([campaignId[c.key], businessId, date, Math.round(spendUsd * UZS_PER_USD), impressions, clicks, platformLeads]);
    }
  }
  await insertMany(db, 'ad_metrics_daily', ['campaign_id', 'business_id', 'date', 'spend', 'impressions', 'clicks', 'leads'], adRows);

  // ---------- Kontekst: biznes qoidalari ----------
  await insertMany(
    db,
    'business_rules',
    ['id', 'business_id', 'name', 'description', 'detector', 'params', 'action_type', 'action_params', 'enabled'],
    [
      [newId('rul'), businessId, 'Javobsiz lead → menejerga vazifa', '2 soatdan ortiq javobsiz qolgan leadlar uchun mas’ul menejerga vazifa yaratiladi.', 'lead_unanswered', { hours: 2 }, 'create_task', {}, true],
      [newId('rul'), businessId, "Guruh to'lishi > 90% → leadlarni boshqa guruhga", "Guruh sig'imi 90% dan oshsa, yangi leadlar shu segmentdagi bo'sh guruhga yo'naltiriladi.", 'group_capacity', { threshold: 0.9 }, 'route_leads', {}, true],
      [newId('rul'), businessId, 'Talaba 7 kun faol emas → retention alert', "7 kundan ortiq darsga kelmagan faol talabalar bo'yicha retention menejerga vazifa.", 'customer_inactive', { days: 7 }, 'retention_outreach', {}, true],
      [newId('rul'), businessId, 'CAC > maqsad → kampaniyani tahlil qilish', 'Kampaniya CAC maqsaddan oshsa yoki keskin o‘ssa, avtomatik tahlil tayyorlanadi.', 'cac_above_target', { growthPct: 20 }, 'analyze_campaign', {}, true],
      [newId('rul'), businessId, 'Churn xavfi → retention menejerni ogohlantirish', 'Churn ehtimoli chegaradan yuqori talabalar ro‘yxati retention menejerga yuboriladi.', 'churn_risk', { threshold: 0.6 }, 'notify_employee', { role: 'retention_manager' }, true],
      [newId('rul'), businessId, "To'lov 3 kundan ortiq kechiksa → eslatma", "Muddati o'tgan to'lovlar bo'yicha mijozga eslatma (tasdiq bilan).", 'payment_overdue', { days: 3 }, 'send_payment_reminder', {}, true],
    ],
  );

  // ---------- Connectorlar (demo manbalar) ----------
  await insertMany(
    db,
    'connectors',
    ['id', 'business_id', 'type', 'name', 'status', 'config', 'last_sync_at'],
    [
      [newId('con'), businessId, 'demo', 'Meta Ads + Telegram Ads + Google Ads (demo)', 'active', { simulates: 'meta_ads' }, now],
      [newId('con'), businessId, 'demo', 'amoCRM — leadlar va menejerlar (demo)', 'active', { simulates: 'amocrm' }, now],
      [newId('con'), businessId, 'demo', "Payme / Click — to'lovlar (demo)", 'active', { simulates: 'payments' }, now],
      [newId('con'), businessId, 'demo', 'Davomat tizimi (demo)', 'active', { simulates: 'attendance' }, now],
    ],
  );

  // ---------- Qaror tarixi (Decision → Action → Outcome) ----------
  await seedDecisionHistory(db, businessId, now, { campaignId, emp });

  // Ochiq va bajarilgan vazifalar
  await insertMany(
    db,
    'tasks',
    ['id', 'business_id', 'title', 'assignee_id', 'status', 'priority', 'created_by', 'due_at', 'created_at', 'completed_at'],
    [
      [newId('tsk'), businessId, "Yangi IELTS guruhi uchun o'qituvchi topish", emp.owner, 'open', 'high', 'human', addDays(now, 5), addDays(now, -6), null],
      [newId('tsk'), businessId, 'Oktabr oyi kassa hisobotini tayyorlash', emp.sardor, 'open', 'normal', 'human', addDays(now, 3), addDays(now, -2), null],
      [newId('tsk'), businessId, "Kids guruhlari ota-onalari bilan yig'ilish", emp.nodira, 'done', 'normal', 'human', addDays(now, -10), addDays(now, -15), addDays(now, -9)],
    ],
  );

  return businessId;
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * HOUR);
}

async function seedDecisionHistory(
  db: Db,
  businessId: string,
  now: Date,
  refs: { campaignId: Record<string, string>; emp: Record<string, string> },
) {
  const history: Array<{
    daysAgo: number;
    type: string;
    title: string;
    params: Record<string, unknown>;
    risk: string;
    source: string;
    rationale: string;
    expected: string;
    outcome: { metric: string; label: string; direction: string; unit: string; baseline: number; observed: number; verdict: string; windowDays: number };
  }> = [
    {
      daysAgo: 70,
      type: 'pause_campaign',
      title: "#13 IELTS — keng auditoriya kampaniyasini to'xtatish",
      params: { campaignId: refs.campaignId.c13 },
      risk: 'medium',
      source: 'diagnosis',
      rationale: "CAC maqsaddan 2,4 baravar yuqori (190 000 so'm), sifatsiz leadlar.",
      expected: "Umumiy CAC ~10% pasayadi, byudjet #12 ga o'tadi",
      outcome: { metric: 'blended_cac', label: 'Umumiy CAC', direction: 'decrease', unit: 'money', baseline: 92_000, observed: 78_500, verdict: 'improved', windowDays: 14 },
    },
    {
      daysAgo: 62,
      type: 'reassign_leads',
      title: '14 ta javobsiz IELTS leadni qayta taqsimlash',
      params: { leadIds: [], strategy: 'least_loaded' },
      risk: 'medium',
      source: 'rule',
      rationale: "Aziz Karimovda 14 ta lead 3 soatdan ortiq javobsiz turibdi.",
      expected: "24 soat ichida leadlarning 90%+ iga javob beriladi",
      outcome: { metric: 'reassigned_response_rate', label: 'Qayta taqsimlangan leadlarga javob ulushi', direction: 'increase', unit: 'ratio', baseline: 0, observed: 0.93, verdict: 'improved', windowDays: 1 },
    },
    {
      daysAgo: 45,
      type: 'change_campaign_budget',
      title: '#12 IELTS September byudjetini +25% oshirish',
      params: { campaignId: refs.campaignId.c12, newDailyBudget: 64_000, previousDailyBudget: 51_200 },
      risk: 'medium',
      source: 'agent',
      rationale: "Kampaniya CAC 68 000 so'm (maqsaddan past), ROAS eng yuqori.",
      expected: "Oyiga +8–10 ta qo'shimcha IELTS sotuvi",
      outcome: { metric: 'campaign_cac', label: 'Kampaniya CAC', direction: 'decrease', unit: 'money', baseline: 71_000, observed: 66_800, verdict: 'improved', windowDays: 7 },
    },
    {
      daysAgo: 30,
      type: 'retention_outreach',
      title: "9 ta davomati tushgan talaba bilan bog'lanish",
      params: { customerIds: [], assigneeId: refs.emp.nodira },
      risk: 'low',
      source: 'rule',
      rationale: "9 talaba 7 kundan ortiq darsga kelmagan.",
      expected: 'Kamida yarmi darsga qaytadi',
      outcome: { metric: 'customers_attendance_rate', label: "Talabalar davomati (keyingi 7 kun)", direction: 'increase', unit: 'ratio', baseline: 0.42, observed: 0.68, verdict: 'improved', windowDays: 7 },
    },
    {
      daysAgo: 26,
      type: 'send_payment_reminder',
      title: "7 ta kechikkan to'lov bo'yicha eslatma",
      params: { paymentIds: [] },
      risk: 'medium',
      source: 'rule',
      rationale: "7 ta to'lov 3+ kun kechikkan, jami 9,6 mln so'm.",
      expected: "5 kun ichida to'lovlarning yarmidan ko'pi undiriladi",
      outcome: { metric: 'payments_paid_share', label: "To'langan ulush (5 kun)", direction: 'increase', unit: 'ratio', baseline: 0, observed: 0.57, verdict: 'improved', windowDays: 5 },
    },
    {
      daysAgo: 20,
      type: 'change_campaign_budget',
      title: '#17 Kids English — Instagram byudjetini +30% oshirish',
      params: { campaignId: refs.campaignId.c17, newDailyBudget: 39_900, previousDailyBudget: 30_700 },
      risk: 'medium',
      source: 'agent',
      rationale: "Kids segmentida talab bor, kampaniya CAC maqsad atrofida edi.",
      expected: "Oyiga +5 ta qo'shimcha Kids sotuvi",
      outcome: { metric: 'campaign_cac', label: 'Kampaniya CAC', direction: 'decrease', unit: 'money', baseline: 64_000, observed: 82_000, verdict: 'worsened', windowDays: 7 },
    },
  ];

  for (const h of history) {
    const created = addDays(now, -h.daysAgo);
    const actionId = newId('act');
    await db.query(
      `INSERT INTO actions (id, business_id, type, title, params, risk, status, source, rationale, expected_impact, confidence,
          context, created_at, decided_at, decided_by, executed_at, result)
       VALUES ($1,$2,$3,$4,$5,$6,'executed',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        actionId,
        businessId,
        h.type,
        h.title,
        h.params,
        h.risk,
        h.source,
        h.rationale,
        h.expected,
        0.6,
        { demo: true },
        created,
        h.risk === 'low' ? null : addHours(created, 1.5),
        h.risk === 'low' ? 'policy:auto' : 'Rahbar (CEO)',
        addHours(created, h.risk === 'low' ? 0 : 1.6),
        { ok: true, simulated: true, summary: 'Demo tarix' },
      ],
    );
    await db.query(
      `INSERT INTO outcomes (id, business_id, action_id, metric, label, direction, unit, baseline, observed, evaluate_at, evaluated_at, verdict, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12)`,
      [
        newId('out'),
        businessId,
        actionId,
        h.outcome.metric,
        h.outcome.label,
        h.outcome.direction,
        h.outcome.unit,
        h.outcome.baseline,
        h.outcome.observed,
        addDays(created, h.outcome.windowDays),
        h.outcome.verdict,
        { demo: true },
      ],
    );
  }
}

/** Demo biznesni to'liq o'chiradi (qayta seed qilish uchun). */
export async function resetDemo(db: Db, businessId = DEMO_BUSINESS_ID): Promise<void> {
  await db.query('DELETE FROM businesses WHERE id = $1', [businessId]);
}
