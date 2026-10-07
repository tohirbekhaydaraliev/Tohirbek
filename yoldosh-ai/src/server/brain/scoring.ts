import type { BrainContext } from './context';
import { round, safeDiv } from '../lib/util';

/**
 * Tushuntiriladigan (interpretable) skoring modellari.
 * Feedback loop yig'gan natijalar ko'paygach, og'irliklarni biznesning o'z tarixiga
 * moslab o'qitish mumkin — hozircha ekspert og'irliklari.
 */

export interface ChurnScore {
  customerId: string;
  name: string | null;
  phone: string | null;
  segment: string | null;
  groupName: string | null;
  subscriptionId: string;
  monthlyPrice: number;
  tenureMonths: number;
  attendance14: number | null;
  attendancePrev: number | null;
  daysSinceLastPresent: number | null;
  overdueDays: number | null;
  probability: number;
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

const W = {
  intercept: -3.0,
  absence: 3.2, // (1 - davomat14)
  inactiveDay: 0.2, // har bir faol bo'lmagan kun (max 21)
  overdue: 1.1,
  drop: 1.5, // davomat pasayishi (oldingi davrga nisbatan)
  tenure: -0.08, // har oy (max 12) — sodiqlik
};

export function churnProbability(f: {
  attendance14: number | null;
  attendancePrev: number | null;
  daysSinceLastPresent: number | null;
  overdueDays: number | null;
  tenureMonths: number;
}): { probability: number; reasons: string[] } {
  const reasons: Array<[number, string]> = [];
  let z = W.intercept;
  if (f.attendance14 !== null) {
    const c = W.absence * (1 - f.attendance14);
    z += c;
    if (f.attendance14 < 0.6) reasons.push([c, `So'nggi 14 kunda davomat ${Math.round(f.attendance14 * 100)}%`]);
  }
  if (f.daysSinceLastPresent !== null) {
    const c = W.inactiveDay * Math.min(f.daysSinceLastPresent, 21);
    z += c;
    if (f.daysSinceLastPresent >= 5) reasons.push([c, `${f.daysSinceLastPresent} kundan beri darsga kelmagan`]);
  }
  if (f.overdueDays !== null && f.overdueDays > 0) {
    z += W.overdue;
    reasons.push([W.overdue, `To'lov ${f.overdueDays} kun kechikkan`]);
  }
  if (f.attendance14 !== null && f.attendancePrev !== null && f.attendancePrev > f.attendance14) {
    const c = W.drop * (f.attendancePrev - f.attendance14);
    z += c;
    if (f.attendancePrev - f.attendance14 >= 0.25) {
      reasons.push([c, `Davomat ${Math.round(f.attendancePrev * 100)}% → ${Math.round(f.attendance14 * 100)}% ga tushgan`]);
    }
  }
  z += W.tenure * Math.min(f.tenureMonths, 12);
  const probability = 1 / (1 + Math.exp(-z));
  return { probability, reasons: reasons.sort((a, b) => b[0] - a[0]).map(([, r]) => r) };
}

export function churnLevel(p: number, threshold: number): 'low' | 'medium' | 'high' {
  if (p >= threshold) return 'high';
  if (p >= threshold * 0.55) return 'medium';
  return 'low';
}

/** Faol mijozlar uchun churn ehtimoli (davomat + to'lov + sodiqlik). */
export async function scoreChurn(ctx: BrainContext, opts: { customerId?: string } = {}): Promise<ChurnScore[]> {
  const tz = ctx.business.timezone;
  const rows = await ctx.db.query<any>(
    `WITH today AS (SELECT ($2::timestamptz AT TIME ZONE $3)::date AS d),
     act AS (
        SELECT DISTINCT ON (s.customer_id) s.customer_id, s.id AS sub_id, s.started_at, s.group_id, s.price, pr.segment
          FROM subscriptions s LEFT JOIN products pr ON pr.id = s.product_id
         WHERE s.business_id = $1 AND s.status = 'active' AND ($4::text IS NULL OR s.customer_id = $4)
         ORDER BY s.customer_id, s.started_at DESC
     ), a AS (
        SELECT customer_id,
               count(*) FILTER (WHERE date > (SELECT d FROM today) - 14) AS l14,
               count(*) FILTER (WHERE date > (SELECT d FROM today) - 14 AND present) AS p14,
               count(*) FILTER (WHERE date <= (SELECT d FROM today) - 14) AS lp,
               count(*) FILTER (WHERE date <= (SELECT d FROM today) - 14 AND present) AS pp,
               max(date) FILTER (WHERE present) AS last_present
          FROM attendance WHERE business_id = $1 AND date > (SELECT d FROM today) - 42
         GROUP BY 1
     ), o AS (
        SELECT customer_id, max((SELECT d FROM today) - due_date) AS overdue_days
          FROM payments WHERE business_id = $1 AND status IN ('pending', 'overdue') AND due_date < (SELECT d FROM today)
         GROUP BY 1
     )
     SELECT act.customer_id, act.sub_id, act.price, act.segment, g.name AS group_name, c.full_name, c.phone,
            extract(epoch FROM $2::timestamptz - act.started_at) / 86400 / 30.4 AS tenure_months,
            a.l14, a.p14, a.lp, a.pp,
            CASE WHEN a.last_present IS NULL THEN NULL ELSE (SELECT d FROM today) - a.last_present END AS days_since,
            (SELECT d FROM today) - (act.started_at AT TIME ZONE $3)::date AS days_enrolled,
            o.overdue_days
       FROM act
       JOIN customers c ON c.id = act.customer_id
       LEFT JOIN groups g ON g.id = act.group_id
       LEFT JOIN a ON a.customer_id = act.customer_id
       LEFT JOIN o ON o.customer_id = act.customer_id`,
    [ctx.businessId, ctx.at, tz, opts.customerId ?? null],
  );
  const threshold = ctx.business.settings.churnThreshold;
  return rows.map((r) => {
    const attendance14 = r.l14 > 0 ? safeDiv(r.p14, r.l14) : null;
    const attendancePrev = r.lp > 0 ? safeDiv(r.pp, r.lp) : null;
    // Davomat yozuvi bo'lmasa, yozilgan kundan beri o'tgan vaqt olinadi
    const daysSince = r.days_since ?? (r.l14 > 0 ? Math.min(r.days_enrolled, 42) : null);
    const f = {
      attendance14,
      attendancePrev,
      daysSinceLastPresent: daysSince,
      overdueDays: r.overdue_days,
      tenureMonths: r.tenure_months,
    };
    const { probability, reasons } = churnProbability(f);
    return {
      customerId: r.customer_id,
      name: r.full_name,
      phone: r.phone,
      segment: r.segment,
      groupName: r.group_name,
      subscriptionId: r.sub_id,
      monthlyPrice: r.price,
      ...f,
      tenureMonths: round(r.tenure_months, 1),
      probability: round(probability, 3),
      level: churnLevel(probability, threshold),
      reasons,
    };
  });
}

export interface LeadScore {
  leadId: string;
  customerId: string;
  name: string | null;
  phone: string | null;
  segment: string | null;
  status: string;
  source: string;
  campaign: string | null;
  manager: string | null;
  createdAt: Date;
  ageHours: number;
  responded: boolean;
  score: number;
  label: 'hot' | 'warm' | 'cold';
  reason: string;
}

/** Ochiq leadlar ustuvorligi: segment/manba tarixiy konversiyasi × bosqich × yangilik. */
export async function scoreOpenLeads(ctx: BrainContext, limit = 50): Promise<LeadScore[]> {
  const [rates, open] = await Promise.all([
    ctx.db.query<{ segment: string | null; source: string; leads: number; won: number }>(
      `SELECT segment, source, count(*) AS leads, count(won_at) AS won FROM leads
        WHERE business_id = $1 AND created_at > $2::timestamptz - interval '120 days' AND created_at < $2::timestamptz - interval '10 days'
        GROUP BY 1, 2`,
      [ctx.businessId, ctx.at],
    ),
    ctx.db.query<any>(
      `SELECT l.id, l.customer_id, c.full_name, c.phone, l.segment, l.status, l.source, cm.name AS campaign, e.name AS manager,
              l.created_at, l.first_response_at, extract(epoch FROM $2::timestamptz - l.created_at) / 3600 AS age_hours,
              (SELECT count(*) FROM interactions i WHERE i.lead_id = l.id AND i.direction = 'in') AS inbound
         FROM leads l JOIN customers c ON c.id = l.customer_id
         LEFT JOIN campaigns cm ON cm.id = l.campaign_id
         LEFT JOIN employees e ON e.id = l.assigned_to
        WHERE l.business_id = $1 AND l.status IN ('new', 'contacted', 'trial') AND l.created_at > $2::timestamptz - interval '14 days'`,
      [ctx.businessId, ctx.at],
    ),
  ]);
  const segRate = new Map<string, { leads: number; won: number }>();
  const srcRate = new Map<string, number>();
  for (const r of rates) {
    const s = segRate.get(r.segment ?? '') ?? { leads: 0, won: 0 };
    s.leads += r.leads;
    s.won += r.won;
    segRate.set(r.segment ?? '', s);
    srcRate.set(`${r.segment}:${r.source}`, (r.won + 1) / (r.leads + 8));
  }
  const scored = open.map((l): LeadScore => {
    const seg = segRate.get(l.segment ?? '') ?? { leads: 1, won: 0 };
    const base = srcRate.get(`${l.segment}:${l.source}`) ?? (seg.won + 1) / (seg.leads + 8);
    const stage = l.status === 'trial' ? 3.2 : l.status === 'contacted' ? 1 : 1.3;
    const recency = Math.exp(-l.age_hours / 96);
    const engagement = 1 + Math.min(l.inbound, 3) * 0.25;
    const raw = base * stage * recency * engagement;
    const score = Math.round(Math.min(99, raw * 380));
    const label = score >= 55 ? 'hot' : score >= 25 ? 'warm' : 'cold';
    const reason =
      l.status === 'trial'
        ? "Sinov darsida bo'lgan — sotuvga eng yaqin"
        : !l.first_response_at
          ? `${Math.round(l.age_hours)} soatdan beri javob kutmoqda`
          : `Segment konversiyasi ${Math.round(base * 100)}%`;
    return {
      leadId: l.id,
      customerId: l.customer_id,
      name: l.full_name,
      phone: l.phone,
      segment: l.segment,
      status: l.status,
      source: l.source,
      campaign: l.campaign,
      manager: l.manager,
      createdAt: l.created_at,
      ageHours: round(l.age_hours, 1),
      responded: !!l.first_response_at,
      score,
      label,
      reason,
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
