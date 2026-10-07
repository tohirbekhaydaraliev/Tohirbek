import type { Db } from '../db';
import { safeDiv, type DateRange } from '../lib/util';

/**
 * Metrikalar qatlami — barcha KPI'lar yagona data modeldan SQL orqali hisoblanadi.
 * Konversiya "davr nisbati" sifatida: davrdagi sotuvlar / davrdagi leadlar
 * (yetilmagan kogortalar sababli yuzaga keladigan siljishni kamaytiradi).
 */

export interface RevenueSummary {
  total: number;
  newRevenue: number;
  renewal: number;
  other: number;
  newPayments: number;
  renewalPayments: number;
  avgNewPayment: number;
  avgRenewalPayment: number;
}

export async function revenueSummary(db: Db, businessId: string, r: DateRange): Promise<RevenueSummary> {
  const row = await db.one<any>(
    `SELECT COALESCE(sum(amount), 0) AS total,
            COALESCE(sum(amount) FILTER (WHERE kind = 'new'), 0) AS new_revenue,
            COALESCE(sum(amount) FILTER (WHERE kind = 'renewal'), 0) AS renewal,
            COALESCE(sum(amount) FILTER (WHERE kind NOT IN ('new','renewal')), 0) AS other,
            count(*) FILTER (WHERE kind = 'new') AS new_payments,
            count(*) FILTER (WHERE kind = 'renewal') AS renewal_payments
       FROM payments
      WHERE business_id = $1 AND status = 'paid' AND paid_at >= $2 AND paid_at < $3`,
    [businessId, r.start, r.end],
  );
  return {
    total: row.total,
    newRevenue: row.new_revenue,
    renewal: row.renewal,
    other: row.other,
    newPayments: row.new_payments,
    renewalPayments: row.renewal_payments,
    avgNewPayment: safeDiv(row.new_revenue, row.new_payments),
    avgRenewalPayment: safeDiv(row.renewal, row.renewal_payments),
  };
}

export async function revenueBySegment(db: Db, businessId: string, r: DateRange) {
  return db.query<{ segment: string; kind: string; amount: number; payments: number }>(
    `SELECT COALESCE(pr.segment, 'Boshqa') AS segment, p.kind, sum(p.amount) AS amount, count(*) AS payments
       FROM payments p
       LEFT JOIN subscriptions s ON s.id = p.subscription_id
       LEFT JOIN products pr ON pr.id = s.product_id
      WHERE p.business_id = $1 AND p.status = 'paid' AND p.paid_at >= $2 AND p.paid_at < $3
      GROUP BY 1, 2 ORDER BY 3 DESC`,
    [businessId, r.start, r.end],
  );
}

export interface FunnelRow {
  segment: string;
  leads: number;
  responded: number;
  trials: number;
  won: number;
  lost: number;
  conversion: number;
  trialRate: number;
}

export async function funnelBySegment(db: Db, businessId: string, r: DateRange): Promise<FunnelRow[]> {
  const rows = await db.query<any>(
    `WITH l AS (
        SELECT COALESCE(segment, 'Boshqa') AS segment, count(*) AS leads, count(first_response_at) AS responded,
               count(trial_at) AS trials, count(lost_at) AS lost
          FROM leads WHERE business_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1
     ), w AS (
        SELECT COALESCE(segment, 'Boshqa') AS segment, count(*) AS won
          FROM leads WHERE business_id = $1 AND won_at >= $2 AND won_at < $3 GROUP BY 1
     )
     SELECT COALESCE(l.segment, w.segment) AS segment, COALESCE(l.leads, 0) AS leads, COALESCE(l.responded, 0) AS responded,
            COALESCE(l.trials, 0) AS trials, COALESCE(l.lost, 0) AS lost, COALESCE(w.won, 0) AS won
       FROM l FULL OUTER JOIN w ON w.segment = l.segment
      ORDER BY 2 DESC`,
    [businessId, r.start, r.end],
  );
  return rows.map((x) => ({
    ...x,
    conversion: safeDiv(x.won, x.leads),
    trialRate: safeDiv(x.trials, x.leads),
  }));
}

export function totalFunnel(rows: FunnelRow[]): FunnelRow {
  const t = rows.reduce(
    (acc, r) => ({
      leads: acc.leads + r.leads,
      responded: acc.responded + r.responded,
      trials: acc.trials + r.trials,
      won: acc.won + r.won,
      lost: acc.lost + r.lost,
    }),
    { leads: 0, responded: 0, trials: 0, won: 0, lost: 0 },
  );
  return { segment: 'Jami', ...t, conversion: safeDiv(t.won, t.leads), trialRate: safeDiv(t.trials, t.leads) };
}

export interface ResponseRow {
  key: string;
  label: string;
  leads: number;
  responded: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  withinSla: number;
  withinSlaShare: number;
}

export async function responseTimes(
  db: Db,
  businessId: string,
  r: DateRange,
  groupBy: 'segment' | 'manager' | 'total',
  slaMinutes: number,
  segment?: string | null,
): Promise<ResponseRow[]> {
  const keyExpr =
    groupBy === 'segment' ? `COALESCE(l.segment, 'Boshqa')` : groupBy === 'manager' ? `COALESCE(l.assigned_to, '-')` : `'total'`;
  const labelExpr =
    groupBy === 'manager' ? `COALESCE(max(e.name), 'Biriktirilmagan')` : groupBy === 'segment' ? keyExpr : `'Jami'`;
  const rows = await db.query<any>(
    `SELECT ${keyExpr} AS key, ${labelExpr} AS label, count(*) AS leads, count(l.first_response_at) AS responded,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM l.first_response_at - l.created_at) / 60)
              FILTER (WHERE l.first_response_at IS NOT NULL) AS median_minutes,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM l.first_response_at - l.created_at) / 60)
              FILTER (WHERE l.first_response_at IS NOT NULL) AS p90_minutes,
            count(*) FILTER (WHERE l.first_response_at IS NOT NULL
              AND l.first_response_at - l.created_at <= make_interval(mins => $4)) AS within_sla
       FROM leads l LEFT JOIN employees e ON e.id = l.assigned_to
      WHERE l.business_id = $1 AND l.created_at >= $2 AND l.created_at < $3
        AND ($5::text IS NULL OR l.segment = $5)
      GROUP BY 1 ORDER BY 3 DESC`,
    [businessId, r.start, r.end, slaMinutes, segment ?? null],
  );
  return rows.map((x) => ({
    key: x.key,
    label: x.label,
    leads: x.leads,
    responded: x.responded,
    medianMinutes: x.median_minutes,
    p90Minutes: x.p90_minutes,
    withinSla: x.within_sla,
    withinSlaShare: safeDiv(x.within_sla, x.leads),
  }));
}

export interface UnansweredLead {
  id: string;
  customer_id: string;
  customer_name: string | null;
  phone: string | null;
  segment: string | null;
  assigned_to: string | null;
  manager_name: string | null;
  campaign_name: string | null;
  created_at: Date;
  waiting_minutes: number;
}

export async function unansweredLeads(db: Db, businessId: string, olderThanHours: number, at: Date, maxAgeDays = 14) {
  return db.query<UnansweredLead>(
    `SELECT l.id, l.customer_id, c.full_name AS customer_name, c.phone, l.segment, l.assigned_to, e.name AS manager_name,
            cm.name AS campaign_name, l.created_at,
            extract(epoch FROM $3::timestamptz - l.created_at) / 60 AS waiting_minutes
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       LEFT JOIN employees e ON e.id = l.assigned_to
       LEFT JOIN campaigns cm ON cm.id = l.campaign_id
      WHERE l.business_id = $1 AND l.first_response_at IS NULL AND l.status IN ('new')
        AND l.created_at < $3::timestamptz - make_interval(hours => $2)
        AND l.created_at > $3::timestamptz - make_interval(days => $4)
      ORDER BY l.created_at`,
    [businessId, olderThanHours, at, maxAgeDays],
  );
}

export interface CampaignPerf {
  campaign_id: string;
  name: string;
  source: string;
  segment: string | null;
  status: string;
  daily_budget: number | null;
  spend: number;
  impressions: number;
  clicks: number;
  platform_leads: number;
  crm_leads: number;
  won: number;
  revenue: number;
  cpl: number;
  cac: number | null;
  roas: number | null;
  ctr: number;
}

export async function campaignPerformance(db: Db, businessId: string, r: DateRange): Promise<CampaignPerf[]> {
  const rows = await db.query<any>(
    `WITH m AS (
        SELECT campaign_id, sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks, sum(leads) AS leads
          FROM ad_metrics_daily WHERE business_id = $1 AND date >= ($2::timestamptz)::date AND date < ($3::timestamptz)::date
          GROUP BY 1
     ), l AS (
        SELECT campaign_id, count(*) AS crm_leads FROM leads
         WHERE business_id = $1 AND created_at >= $2 AND created_at < $3 AND campaign_id IS NOT NULL GROUP BY 1
     ), w AS (
        SELECT campaign_id, count(*) AS won FROM leads
         WHERE business_id = $1 AND won_at >= $2 AND won_at < $3 AND campaign_id IS NOT NULL GROUP BY 1
     ), rv AS (
        SELECT c.first_campaign_id AS campaign_id, sum(p.amount) AS revenue
          FROM payments p JOIN customers c ON c.id = p.customer_id
         WHERE p.business_id = $1 AND p.status = 'paid' AND p.paid_at >= $2 AND p.paid_at < $3 AND c.first_campaign_id IS NOT NULL
         GROUP BY 1
     )
     SELECT c.id AS campaign_id, c.name, c.source, c.segment, c.status, c.daily_budget,
            COALESCE(m.spend, 0) AS spend, COALESCE(m.impressions, 0) AS impressions, COALESCE(m.clicks, 0) AS clicks,
            COALESCE(m.leads, 0) AS platform_leads, COALESCE(l.crm_leads, 0) AS crm_leads, COALESCE(w.won, 0) AS won,
            COALESCE(rv.revenue, 0) AS revenue
       FROM campaigns c
       LEFT JOIN m ON m.campaign_id = c.id
       LEFT JOIN l ON l.campaign_id = c.id
       LEFT JOIN w ON w.campaign_id = c.id
       LEFT JOIN rv ON rv.campaign_id = c.id
      WHERE c.business_id = $1 AND (m.spend IS NOT NULL OR l.crm_leads IS NOT NULL OR w.won IS NOT NULL)
      ORDER BY spend DESC, crm_leads DESC`,
    [businessId, r.start, r.end],
  );
  return rows.map((x) => {
    const leads = x.platform_leads || x.crm_leads;
    return {
      ...x,
      cpl: safeDiv(x.spend, leads),
      cac: x.won > 0 ? x.spend / x.won : x.spend > 0 ? null : 0,
      roas: x.spend > 0 ? x.revenue / x.spend : null,
      ctr: safeDiv(x.clicks, x.impressions),
    };
  });
}

export async function marketingTotals(db: Db, businessId: string, r: DateRange) {
  const row = await db.one<any>(
    `SELECT COALESCE(sum(spend), 0) AS spend, COALESCE(sum(leads), 0) AS platform_leads,
            COALESCE(sum(clicks), 0) AS clicks, COALESCE(sum(impressions), 0) AS impressions
       FROM ad_metrics_daily WHERE business_id = $1 AND date >= ($2::timestamptz)::date AND date < ($3::timestamptz)::date`,
    [businessId, r.start, r.end],
  );
  const paidWon = await db.one<{ n: number }>(
    `SELECT count(*) AS n FROM leads l JOIN campaigns c ON c.id = l.campaign_id
      WHERE l.business_id = $1 AND l.won_at >= $2 AND l.won_at < $3
        AND EXISTS (SELECT 1 FROM ad_metrics_daily m WHERE m.campaign_id = c.id AND m.spend > 0)`,
    [businessId, r.start, r.end],
  );
  return {
    spend: row.spend as number,
    platformLeads: row.platform_leads as number,
    clicks: row.clicks as number,
    impressions: row.impressions as number,
    paidWon: paidWon?.n ?? 0,
    cac: paidWon && paidWon.n > 0 ? row.spend / paidWon.n : null,
  };
}

export async function activeCustomers(db: Db, businessId: string, at: Date): Promise<number> {
  const row = await db.one<{ n: number }>(
    `SELECT count(DISTINCT customer_id) AS n FROM subscriptions
      WHERE business_id = $1 AND started_at <= $2 AND (ended_at IS NULL OR ended_at > $2)`,
    [businessId, at],
  );
  return row?.n ?? 0;
}

export async function churnStats(db: Db, businessId: string, r: DateRange) {
  const activeAtStart = await activeCustomers(db, businessId, r.start);
  const row = await db.one<any>(
    `SELECT count(*) FILTER (WHERE status = 'churned') AS churned,
            count(*) FILTER (WHERE status = 'completed') AS completed
       FROM subscriptions WHERE business_id = $1 AND ended_at >= $2 AND ended_at < $3`,
    [businessId, r.start, r.end],
  );
  const days = (r.end.getTime() - r.start.getTime()) / 86_400_000;
  const churnRate = safeDiv(row.churned, activeAtStart);
  return {
    activeAtStart,
    churned: row.churned as number,
    completed: row.completed as number,
    churnRate,
    monthlyChurnRate: days > 0 ? churnRate * (30 / days) : 0,
  };
}

export async function overduePayments(db: Db, businessId: string, at: Date, minDaysOverdue = 0) {
  return db.query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    phone: string | null;
    amount: number;
    due_date: string;
    days_overdue: number;
    telegram_chat_id: string | null;
  }>(
    `SELECT p.id, p.customer_id, c.full_name AS customer_name, c.phone, p.amount, p.due_date,
            (($3::timestamptz)::date - p.due_date) AS days_overdue, c.telegram_chat_id
       FROM payments p JOIN customers c ON c.id = p.customer_id
      WHERE p.business_id = $1 AND p.status IN ('pending', 'overdue') AND p.due_date IS NOT NULL
        AND p.due_date <= ($3::timestamptz)::date - $2::int
      ORDER BY p.due_date`,
    [businessId, minDaysOverdue, at],
  );
}

export async function attendanceRate(db: Db, businessId: string, r: DateRange): Promise<number | null> {
  const row = await db.one<{ rate: number | null }>(
    `SELECT avg(CASE WHEN present THEN 1.0 ELSE 0.0 END)::float8 AS rate FROM attendance
      WHERE business_id = $1 AND date >= ($2::timestamptz)::date AND date < ($3::timestamptz)::date`,
    [businessId, r.start, r.end],
  );
  return row?.rate ?? null;
}

/** Tenure (oy) — tugagan obunalar bo'yicha o'rtacha qolish muddati. */
export async function avgTenureMonths(db: Db, businessId: string, at: Date, lookbackDays = 180): Promise<number | null> {
  const row = await db.one<{ months: number | null }>(
    `SELECT avg(extract(epoch FROM ended_at - started_at) / 86400 / 30.4)::float8 AS months FROM subscriptions
      WHERE business_id = $1 AND ended_at IS NOT NULL AND ended_at > $2::timestamptz - make_interval(days => $3) AND ended_at <= $2`,
    [businessId, at, lookbackDays],
  );
  return row?.months ?? null;
}

export async function avgMonthlyPrice(db: Db, businessId: string): Promise<number> {
  const row = await db.one<{ p: number | null }>(
    `SELECT avg(price)::float8 AS p FROM subscriptions WHERE business_id = $1 AND status = 'active'`,
    [businessId],
  );
  return row?.p ?? 0;
}

export type SeriesMetric = 'revenue' | 'leads' | 'won' | 'spend' | 'new_revenue';

/** Kunlik qatorlar (sparkline) — biznes vaqt mintaqasida. */
export async function dailySeries(
  db: Db,
  businessId: string,
  metric: SeriesMetric,
  r: DateRange,
  timezone: string,
): Promise<Array<{ date: string; value: number }>> {
  const source: Record<SeriesMetric, string> = {
    revenue: `SELECT (paid_at AT TIME ZONE $4)::date AS d, sum(amount) AS v FROM payments
               WHERE business_id = $1 AND status = 'paid' AND paid_at >= $2 AND paid_at < $3 GROUP BY 1`,
    new_revenue: `SELECT (paid_at AT TIME ZONE $4)::date AS d, sum(amount) AS v FROM payments
               WHERE business_id = $1 AND status = 'paid' AND kind = 'new' AND paid_at >= $2 AND paid_at < $3 GROUP BY 1`,
    leads: `SELECT (created_at AT TIME ZONE $4)::date AS d, count(*) AS v FROM leads
               WHERE business_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`,
    won: `SELECT (won_at AT TIME ZONE $4)::date AS d, count(*) AS v FROM leads
               WHERE business_id = $1 AND won_at >= $2 AND won_at < $3 GROUP BY 1`,
    spend: `SELECT date AS d, sum(spend) AS v FROM ad_metrics_daily
               WHERE business_id = $1 AND date >= ($2::timestamptz AT TIME ZONE $4)::date AND date < ($3::timestamptz AT TIME ZONE $4)::date GROUP BY 1`,
  };
  const rows = await db.query<{ date: string; value: number }>(
    `WITH days AS (
        SELECT generate_series(($2::timestamptz AT TIME ZONE $4)::date, (($3::timestamptz AT TIME ZONE $4)::date - 1), interval '1 day')::date AS d
     ), src AS (${source[metric]})
     SELECT to_char(days.d, 'YYYY-MM-DD') AS date, COALESCE(src.v, 0)::float8 AS value
       FROM days LEFT JOIN src ON src.d = days.d ORDER BY days.d`,
    [businessId, r.start, r.end, timezone],
  );
  return rows;
}

/**
 * Sababiy dalil: birinchi javob tezligi bo'yicha kogorta konversiyasi.
 * Faqat "yetilgan" leadlar (maturityDays dan oldin yaratilgan) hisobga olinadi.
 */
export async function conversionByResponseBucket(
  db: Db,
  businessId: string,
  at: Date,
  opts: { segment?: string | null; lookbackDays?: number; maturityDays?: number } = {},
) {
  const rows = await db.query<{ bucket: string; ord: number; leads: number; won: number }>(
    `SELECT CASE
              WHEN first_response_at IS NULL THEN 'Javob berilmagan'
              WHEN first_response_at - created_at <= interval '15 minutes' THEN '≤ 15 daq'
              WHEN first_response_at - created_at <= interval '60 minutes' THEN '15–60 daq'
              WHEN first_response_at - created_at <= interval '4 hours' THEN '1–4 soat'
              ELSE '> 4 soat' END AS bucket,
            CASE
              WHEN first_response_at IS NULL THEN 5
              WHEN first_response_at - created_at <= interval '15 minutes' THEN 1
              WHEN first_response_at - created_at <= interval '60 minutes' THEN 2
              WHEN first_response_at - created_at <= interval '4 hours' THEN 3
              ELSE 4 END AS ord,
            count(*) AS leads, count(won_at) AS won
       FROM leads
      WHERE business_id = $1 AND ($4::text IS NULL OR segment = $4)
        AND created_at >= $2::timestamptz - make_interval(days => $3)
        AND created_at < $2::timestamptz - make_interval(days => $5)
      GROUP BY 1, 2 ORDER BY 2`,
    [businessId, at, opts.lookbackDays ?? 90, opts.segment ?? null, opts.maturityDays ?? 10],
  );
  return rows.map((r) => ({ ...r, conversion: safeDiv(r.won, r.leads) }));
}

export interface ManagerPerf {
  employee_id: string;
  name: string;
  leads: number;
  responded: number;
  won: number;
  conversion: number;
  median_minutes: number | null;
  open_unanswered: number;
  open_tasks: number;
}

export async function managerPerformance(
  db: Db,
  businessId: string,
  r: DateRange,
  segment?: string | null,
): Promise<ManagerPerf[]> {
  const rows = await db.query<any>(
    `WITH l AS (
        SELECT assigned_to, count(*) AS leads, count(first_response_at) AS responded,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at - created_at) / 60)
                 FILTER (WHERE first_response_at IS NOT NULL) AS median_minutes
          FROM leads WHERE business_id = $1 AND created_at >= $2 AND created_at < $3 AND ($4::text IS NULL OR segment = $4)
          GROUP BY 1
     ), w AS (
        SELECT assigned_to, count(*) AS won FROM leads
         WHERE business_id = $1 AND won_at >= $2 AND won_at < $3 AND ($4::text IS NULL OR segment = $4) GROUP BY 1
     ), o AS (
        SELECT assigned_to, count(*) AS open_unanswered FROM leads
         WHERE business_id = $1 AND status = 'new' AND first_response_at IS NULL AND created_at > $3::timestamptz - interval '14 days'
         GROUP BY 1
     ), t AS (
        SELECT assignee_id, count(*) AS open_tasks FROM tasks WHERE business_id = $1 AND status = 'open' GROUP BY 1
     )
     SELECT e.id AS employee_id, e.name, COALESCE(l.leads, 0) AS leads, COALESCE(l.responded, 0) AS responded,
            COALESCE(w.won, 0) AS won, l.median_minutes, COALESCE(o.open_unanswered, 0) AS open_unanswered,
            COALESCE(t.open_tasks, 0) AS open_tasks
       FROM employees e
       LEFT JOIN l ON l.assigned_to = e.id
       LEFT JOIN w ON w.assigned_to = e.id
       LEFT JOIN o ON o.assigned_to = e.id
       LEFT JOIN t ON t.assignee_id = e.id
      WHERE e.business_id = $1 AND e.role = 'sales_manager' AND e.active
      ORDER BY leads DESC`,
    [businessId, r.start, r.end, segment ?? null],
  );
  return rows.map((x) => ({ ...x, conversion: safeDiv(x.won, x.leads) }));
}

export async function groupCapacity(db: Db, businessId: string) {
  return db.query<{
    group_id: string;
    name: string;
    segment: string | null;
    branch: string | null;
    capacity: number;
    active: number;
    utilization: number;
  }>(
    `SELECT g.id AS group_id, g.name, pr.segment, b.name AS branch, g.capacity,
            count(s.id) FILTER (WHERE s.status = 'active') AS active,
            (count(s.id) FILTER (WHERE s.status = 'active'))::float8 / NULLIF(g.capacity, 0) AS utilization
       FROM groups g
       LEFT JOIN products pr ON pr.id = g.product_id
       LEFT JOIN branches b ON b.id = g.branch_id
       LEFT JOIN subscriptions s ON s.group_id = g.id
      WHERE g.business_id = $1 AND g.status = 'active'
      GROUP BY g.id, g.name, pr.segment, b.name, g.capacity
      ORDER BY utilization DESC NULLS LAST`,
    [businessId],
  );
}
