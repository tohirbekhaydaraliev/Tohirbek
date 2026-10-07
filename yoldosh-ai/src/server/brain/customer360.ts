import type { Db } from '../db';
import type { Customer360 } from '../../shared/types';
import { safeDiv } from '../lib/util';
import { loadBrainContext } from './context';
import { churnLevel, scoreChurn } from './scoring';

/**
 * Customer 360 — bir mijozning marketingdan daromadgacha bo'lgan butun hayot sikli:
 * manba → kampaniya → birinchi aloqa → menejer → sinov → xarid → to'lovlar → davomat → churn xavfi.
 */
export async function getCustomer360(db: Db, businessId: string, customerId: string): Promise<Customer360 | null> {
  const c = await db.one<any>('SELECT * FROM customers WHERE business_id = $1 AND id = $2', [businessId, customerId]);
  if (!c) return null;
  const [lead, sub, revenue, attendance, lastActivity, identities, interactions, payments, tasks] = await Promise.all([
    db.one<any>(
      `SELECT l.*, cm.name AS campaign_name, e.name AS manager_name FROM leads l
         LEFT JOIN campaigns cm ON cm.id = l.campaign_id LEFT JOIN employees e ON e.id = l.assigned_to
        WHERE l.customer_id = $1 ORDER BY l.created_at LIMIT 1`,
      [customerId],
    ),
    db.one<any>(
      `SELECT s.*, p.name AS product_name, p.segment, g.name AS group_name FROM subscriptions s
         LEFT JOIN products p ON p.id = s.product_id LEFT JOIN groups g ON g.id = s.group_id
        WHERE s.customer_id = $1 ORDER BY (s.status = 'active') DESC, s.started_at DESC LIMIT 1`,
      [customerId],
    ),
    db.one<{ total: number }>(`SELECT COALESCE(sum(amount), 0) AS total FROM payments WHERE customer_id = $1 AND status = 'paid'`, [customerId]),
    db.one<{ lessons: number; present: number; last_present: string | null }>(
      `SELECT count(*) AS lessons, count(*) FILTER (WHERE present) AS present, max(date) FILTER (WHERE present) AS last_present
         FROM attendance WHERE customer_id = $1`,
      [customerId],
    ),
    db.one<{ at: Date | null }>(`SELECT max(occurred_at) AS at FROM interactions WHERE customer_id = $1`, [customerId]),
    db.query<any>('SELECT kind, value, source FROM customer_identities WHERE customer_id = $1 ORDER BY created_at', [customerId]),
    db.query<any>(
      `SELECT i.occurred_at, i.channel, i.direction, i.summary, e.name AS employee FROM interactions i
         LEFT JOIN employees e ON e.id = i.employee_id WHERE i.customer_id = $1 ORDER BY i.occurred_at DESC LIMIT 30`,
      [customerId],
    ),
    db.query<any>(`SELECT amount, status, kind, paid_at, due_date, method FROM payments WHERE customer_id = $1 ORDER BY COALESCE(paid_at, due_date::timestamptz) DESC LIMIT 24`, [customerId]),
    db.query<any>(`SELECT id, title, due_at FROM tasks WHERE customer_id = $1 AND status = 'open' ORDER BY due_at`, [customerId]),
  ]);

  const ctx = await loadBrainContext(db, businessId);
  const churn = sub?.status === 'active' ? (await scoreChurn(ctx, { customerId }))[0] : undefined;
  const lastPresent = attendance?.last_present ? new Date(`${attendance.last_present}T14:00:00+05:00`) : null;
  const lastActivityAt = [lastPresent, lastActivity?.at ? new Date(lastActivity.at) : null]
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const timeline: Customer360['timeline'] = [];
  if (lead) {
    timeline.push({ at: new Date(lead.created_at).toISOString(), kind: 'lead', title: 'Lead keldi', detail: lead.campaign_name ?? c.source ?? lead.source });
    if (lead.first_response_at) {
      const min = Math.round((new Date(lead.first_response_at).getTime() - new Date(lead.created_at).getTime()) / 60000);
      timeline.push({ at: new Date(lead.first_response_at).toISOString(), kind: 'contact', title: 'Birinchi aloqa', detail: `${lead.manager_name ?? ''}, ${min} daqiqada` });
    }
    if (lead.trial_at) timeline.push({ at: new Date(lead.trial_at).toISOString(), kind: 'trial', title: 'Sinov darsi' });
    if (lead.won_at) timeline.push({ at: new Date(lead.won_at).toISOString(), kind: 'purchase', title: 'Xarid', detail: sub?.product_name ?? undefined });
    if (lead.lost_at) timeline.push({ at: new Date(lead.lost_at).toISOString(), kind: 'lost', title: "Yo'qotildi", detail: lead.lost_reason ?? undefined });
  }
  for (const p of payments) {
    if (p.status === 'paid' && p.paid_at) timeline.push({ at: new Date(p.paid_at).toISOString(), kind: 'payment', title: `To'lov: ${p.amount.toLocaleString('ru-RU')} so'm`, detail: p.method ?? undefined });
    else if (p.status === 'overdue' || p.status === 'pending') {
      timeline.push({ at: new Date(`${p.due_date}T09:00:00+05:00`).toISOString(), kind: 'overdue', title: `To'lov kutilmoqda: ${p.amount.toLocaleString('ru-RU')} so'm`, detail: p.status === 'overdue' ? "Muddati o'tgan" : undefined });
    }
  }
  // Lead bosqichlari bilan bir vaqtdagi muloqotlar takrorlanmasin
  const milestones = new Set(
    [lead?.first_response_at, lead?.trial_at, lead?.won_at].filter(Boolean).map((d: Date) => new Date(d).getTime()),
  );
  for (const i of interactions) {
    if (milestones.has(new Date(i.occurred_at).getTime())) continue;
    timeline.push({ at: new Date(i.occurred_at).toISOString(), kind: 'interaction', title: i.summary ?? i.channel, detail: [i.channel, i.employee].filter(Boolean).join(' · ') });
  }
  if (sub?.ended_at) timeline.push({ at: new Date(sub.ended_at).toISOString(), kind: 'churn', title: sub.status === 'completed' ? 'Kurs yakunlandi' : 'Ketdi', detail: sub.end_reason ?? undefined });
  timeline.sort((a, b) => b.at.localeCompare(a.at));
  // Bir xil vaqtdagi takrorlarni olib tashlash
  const seen = new Set<string>();
  const dedupedTimeline = timeline.filter((t) => {
    const k = `${t.at}:${t.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    id: c.id,
    fullName: c.full_name,
    phone: c.phone,
    email: c.email,
    telegram: c.telegram,
    source: c.source,
    campaign: lead?.campaign_name ?? null,
    firstContactAt: lead ? new Date(lead.created_at).toISOString() : new Date(c.first_seen_at).toISOString(),
    salesManager: lead?.manager_name ?? null,
    product: sub?.product_name ?? null,
    segment: sub?.segment ?? lead?.segment ?? null,
    group: sub?.group_name ?? null,
    trialAt: lead?.trial_at ? new Date(lead.trial_at).toISOString() : null,
    purchaseAt: lead?.won_at ? new Date(lead.won_at).toISOString() : sub ? new Date(sub.started_at).toISOString() : null,
    revenue: revenue?.total ?? 0,
    attendanceRate: attendance && attendance.lessons > 0 ? safeDiv(attendance.present, attendance.lessons) : null,
    lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
    churnProbability: churn?.probability ?? null,
    churnLevel: churn ? churnLevel(churn.probability, ctx.business.settings.churnThreshold) : null,
    churnReasons: churn?.reasons ?? [],
    subscriptionStatus: sub?.status ?? null,
    identities: identities.map((i) => ({ kind: i.kind, value: i.value, source: i.source })),
    timeline: dedupedTimeline.slice(0, 40),
    openTasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: t.due_at ? new Date(t.due_at).toISOString() : null })),
  };
}

export interface CustomerListItem {
  id: string;
  fullName: string | null;
  phone: string | null;
  source: string | null;
  segment: string | null;
  status: string | null;
  revenue: number;
  churnProbability: number | null;
  churnLevel: 'low' | 'medium' | 'high' | null;
  churnReason: string | null;
  firstSeenAt: string;
}

export async function searchCustomers(
  db: Db,
  businessId: string,
  opts: { q?: string; risk?: 'high' | 'medium'; limit?: number } = {},
): Promise<CustomerListItem[]> {
  const ctx = await loadBrainContext(db, businessId);
  const scores = await scoreChurn(ctx);
  const scoreMap = new Map(scores.map((s) => [s.customerId, s]));
  let ids: string[] | null = null;
  if (opts.risk) {
    const threshold = ctx.business.settings.churnThreshold;
    ids = scores
      .filter((s) => (opts.risk === 'high' ? s.probability >= threshold : s.probability >= threshold * 0.55))
      .sort((a, b) => b.probability - a.probability)
      .map((s) => s.customerId);
  }
  const q = opts.q?.trim();
  const digits = q?.replace(/\D/g, '') ?? '';
  const rows = await db.query<any>(
    `SELECT c.id, c.full_name, c.phone, c.source, c.first_seen_at,
            (SELECT p.segment FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.customer_id = c.id ORDER BY s.started_at DESC LIMIT 1) AS segment,
            (SELECT s.status FROM subscriptions s WHERE s.customer_id = c.id ORDER BY (s.status = 'active') DESC, s.started_at DESC LIMIT 1) AS status,
            (SELECT l.segment FROM leads l WHERE l.customer_id = c.id ORDER BY l.created_at DESC LIMIT 1) AS lead_segment,
            (SELECT l.status FROM leads l WHERE l.customer_id = c.id ORDER BY l.created_at DESC LIMIT 1) AS lead_status,
            (SELECT COALESCE(sum(amount), 0) FROM payments p WHERE p.customer_id = c.id AND p.status = 'paid') AS revenue
       FROM customers c
      WHERE c.business_id = $1
        AND ($2::text IS NULL OR c.full_name ILIKE '%' || $2 || '%' OR c.id = $2 OR ($3 <> '' AND c.phone LIKE '%' || $3 || '%'))
        AND ($4::text[] IS NULL OR c.id = ANY($4))
      ORDER BY c.first_seen_at DESC
      LIMIT $5`,
    [businessId, q || null, digits.length >= 4 ? digits : '', ids, opts.limit ?? 50],
  );
  const items = rows.map((r) => {
    const s = scoreMap.get(r.id);
    return {
      id: r.id,
      fullName: r.full_name,
      phone: r.phone,
      source: r.source,
      segment: r.segment ?? r.lead_segment,
      status: r.status ? `talaba: ${r.status}` : r.lead_status ? `lead: ${r.lead_status}` : null,
      revenue: r.revenue,
      churnProbability: s?.probability ?? null,
      churnLevel: s?.level ?? null,
      churnReason: s?.reasons[0] ?? null,
      firstSeenAt: new Date(r.first_seen_at).toISOString(),
    };
  });
  if (ids) items.sort((a, b) => (b.churnProbability ?? 0) - (a.churnProbability ?? 0));
  return items;
}
