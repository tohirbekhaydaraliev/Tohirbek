import type { Db } from '../db';
import { newId } from '../lib/util';

/**
 * Biznes maqsadlari va KPI chegaralari.
 * kind: 'goal' (strategik maqsad), 'kpi' (KPI chegarasi), 'constraint' (cheklov).
 */
export interface Target {
  id: string;
  kind: 'goal' | 'kpi' | 'constraint';
  metric: string;
  label: string;
  target: number;
  comparator: 'gte' | 'lte';
  segment: string | null;
  priority: number;
}

/** Tizim tushunadigan metrikalar katalogi (UI va AI uchun). */
export const METRIC_CATALOG: Record<string, { label: string; unit: string; defaultComparator: 'gte' | 'lte' }> = {
  active_customers: { label: 'Faol mijozlar (talabalar)', unit: 'count', defaultComparator: 'gte' },
  revenue: { label: 'Daromad (oylik)', unit: 'money', defaultComparator: 'gte' },
  cac: { label: 'CAC (mijoz jalb qilish narxi)', unit: 'money', defaultComparator: 'lte' },
  cpl: { label: 'CPL (lead narxi)', unit: 'money', defaultComparator: 'lte' },
  conversion_rate: { label: 'Lead → sotuv konversiyasi', unit: 'ratio', defaultComparator: 'gte' },
  response_time_minutes: { label: 'Birinchi javob vaqti (median)', unit: 'minutes', defaultComparator: 'lte' },
  retention_months: { label: "O'rtacha qolish muddati (oy)", unit: 'months', defaultComparator: 'gte' },
  max_group_size: { label: 'Maksimal guruh hajmi', unit: 'count', defaultComparator: 'lte' },
  churn_rate: { label: 'Oylik churn', unit: 'ratio', defaultComparator: 'lte' },
  attendance_rate: { label: 'Davomat', unit: 'ratio', defaultComparator: 'gte' },
};

export async function listTargets(db: Db, businessId: string): Promise<Target[]> {
  return db.query<Target>(
    `SELECT id, kind, metric, label, target, comparator, segment, priority
       FROM targets WHERE business_id = $1 ORDER BY priority, created_at`,
    [businessId],
  );
}

export async function getTargetValue(db: Db, businessId: string, metric: string, segment?: string | null) {
  const rows = await db.query<Target>(
    `SELECT * FROM targets WHERE business_id = $1 AND metric = $2 AND (segment IS NULL OR segment = $3)
      ORDER BY segment NULLS LAST LIMIT 1`,
    [businessId, metric, segment ?? null],
  );
  return rows[0] ?? null;
}

export async function upsertTarget(
  db: Db,
  businessId: string,
  input: Partial<Target> & { metric: string; target: number },
): Promise<Target> {
  const catalog = METRIC_CATALOG[input.metric];
  const id = input.id ?? newId('tgt');
  await db.query(
    `INSERT INTO targets (id, business_id, kind, metric, label, target, comparator, segment, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, metric = EXCLUDED.metric, label = EXCLUDED.label,
       target = EXCLUDED.target, comparator = EXCLUDED.comparator, segment = EXCLUDED.segment, priority = EXCLUDED.priority`,
    [
      id,
      businessId,
      input.kind ?? 'kpi',
      input.metric,
      input.label ?? catalog?.label ?? input.metric,
      input.target,
      input.comparator ?? catalog?.defaultComparator ?? 'gte',
      input.segment ?? null,
      input.priority ?? 2,
    ],
  );
  const row = await db.one<Target>('SELECT id, kind, metric, label, target, comparator, segment, priority FROM targets WHERE id = $1', [id]);
  return row!;
}

export async function deleteTarget(db: Db, businessId: string, id: string): Promise<void> {
  await db.query('DELETE FROM targets WHERE business_id = $1 AND id = $2', [businessId, id]);
}
