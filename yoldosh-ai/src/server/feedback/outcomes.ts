import type { Db } from '../db';
import type { OutcomeView, Unit } from '../../shared/types';
import { ACTIONS, actionLabel, type OutcomeSpec } from '../actions/registry';
import { addHours, errorMessage, newId, now } from '../lib/util';

/**
 * Feedback Loop — har bir bajarilgan harakatning natijasi o'lchanadi:
 *   Decision + Context + Action + Outcome
 * Bu tarix tavsiyalar ishonchliligini (confidence) va AI xotirasini shakllantiradi.
 */

export function verdictFor(
  baseline: number | null,
  observed: number | null,
  direction: 'increase' | 'decrease',
  unit: Unit,
): OutcomeView['verdict'] {
  if (baseline === null || observed === null || !Number.isFinite(baseline) || !Number.isFinite(observed)) return 'unknown';
  const diff = observed - baseline;
  // Ulush (ratio) uchun absolyut 5 p.p., boshqalar uchun nisbiy 5%
  const significant = unit === 'ratio' ? Math.abs(diff) >= 0.05 : Math.abs(diff) >= Math.abs(baseline) * 0.05 && Math.abs(diff) > 0;
  if (!significant) return 'no_change';
  const good = direction === 'increase' ? diff > 0 : diff < 0;
  return good ? 'improved' : 'worsened';
}

export async function scheduleOutcome(
  db: Db,
  businessId: string,
  action: { id: string; type: string; params: unknown },
  executedAt: Date,
): Promise<void> {
  const def = ACTIONS[action.type];
  const spec: OutcomeSpec | null | undefined = def?.outcome?.(action.params);
  if (!spec) return;
  let baseline: number | null = null;
  try {
    baseline = await spec.measure({ db, businessId }, 'baseline', executedAt);
  } catch {
    baseline = null;
  }
  await db.query(
    `INSERT INTO outcomes (id, business_id, action_id, metric, label, direction, unit, baseline, evaluate_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId('out'), businessId, action.id, spec.metric, spec.label, spec.direction, spec.unit, baseline, addHours(executedAt, spec.windowHours)],
  );
}

/** Muddati kelgan natijalarni baholaydi. */
export async function evaluateDueOutcomes(db: Db, businessId?: string, at: Date = now()) {
  const due = await db.query<any>(
    `SELECT o.*, a.type, a.params, a.executed_at FROM outcomes o JOIN actions a ON a.id = o.action_id
      WHERE o.verdict = 'pending' AND o.evaluate_at <= $1 AND ($2::text IS NULL OR o.business_id = $2)`,
    [at, businessId ?? null],
  );
  const results: Array<{ id: string; verdict: string }> = [];
  for (const o of due) {
    const spec = ACTIONS[o.type]?.outcome?.(o.params);
    let observed: number | null = null;
    let error: string | undefined;
    try {
      observed = spec ? await spec.measure({ db, businessId: o.business_id }, 'observed', new Date(o.executed_at)) : null;
    } catch (err) {
      error = errorMessage(err);
    }
    const verdict = verdictFor(o.baseline, observed, o.direction, o.unit);
    await db.query(`UPDATE outcomes SET observed = $2, verdict = $3, evaluated_at = $4, details = $5 WHERE id = $1`, [
      o.id,
      observed,
      verdict,
      at,
      error ? { error } : {},
    ]);
    results.push({ id: o.id, verdict });
  }
  return results;
}

export interface LearningStat {
  type: string;
  label: string;
  executed: number;
  evaluated: number;
  improved: number;
  worsened: number;
  noChange: number;
  successRate: number | null;
}

export async function learningStats(db: Db, businessId: string): Promise<LearningStat[]> {
  const rows = await db.query<any>(
    `SELECT a.type,
            count(DISTINCT a.id) AS executed,
            count(o.id) FILTER (WHERE o.verdict IN ('improved','worsened','no_change')) AS evaluated,
            count(o.id) FILTER (WHERE o.verdict = 'improved') AS improved,
            count(o.id) FILTER (WHERE o.verdict = 'worsened') AS worsened,
            count(o.id) FILTER (WHERE o.verdict = 'no_change') AS no_change
       FROM actions a LEFT JOIN outcomes o ON o.action_id = a.id
      WHERE a.business_id = $1 AND a.status = 'executed'
      GROUP BY a.type ORDER BY executed DESC`,
    [businessId],
  );
  return rows.map((r) => ({
    type: r.type,
    label: actionLabel(r.type),
    executed: r.executed,
    evaluated: r.evaluated,
    improved: r.improved,
    worsened: r.worsened,
    noChange: r.no_change,
    successRate: r.evaluated > 0 ? r.improved / r.evaluated : null,
  }));
}

/** Tavsiya ishonchliligi: bazaviy qiymat + shu turdagi harakatlarning tarixiy muvaffaqiyati (Laplace silliqlash). */
export function confidenceFrom(stats: LearningStat[], type: string, base = 0.6): number {
  const s = stats.find((x) => x.type === type);
  if (!s || s.evaluated === 0) return base;
  const rate = (s.improved + 1) / (s.evaluated + 2);
  const weight = Math.min(1, s.evaluated / 5);
  return Math.round((base * (1 - weight) + rate * weight) * 100) / 100;
}

export async function decisionHistory(db: Db, businessId: string, opts: { type?: string; limit?: number } = {}) {
  const rows = await db.query<any>(
    `SELECT a.id, a.type, a.title, a.params, a.risk, a.source, a.rationale, a.expected_impact, a.status, a.created_at, a.executed_at,
            a.decided_by, a.result, o.metric, o.label AS outcome_label, o.direction, o.unit, o.baseline, o.observed, o.verdict, o.evaluated_at
       FROM actions a LEFT JOIN outcomes o ON o.action_id = a.id
      WHERE a.business_id = $1 AND a.status IN ('executed','rejected','ignored') AND ($2::text IS NULL OR a.type = $2)
      ORDER BY a.created_at DESC LIMIT $3`,
    [businessId, opts.type ?? null, opts.limit ?? 30],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    typeLabel: actionLabel(r.type),
    title: r.title,
    risk: r.risk,
    source: r.source,
    status: r.status,
    rationale: r.rationale,
    expectedImpact: r.expected_impact,
    decidedBy: r.decided_by,
    createdAt: new Date(r.created_at).toISOString(),
    executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
    resultSummary: r.result?.summary ?? null,
    outcome: r.metric
      ? { metric: r.metric, label: r.outcome_label, direction: r.direction, unit: r.unit, baseline: r.baseline, observed: r.observed, verdict: r.verdict }
      : null,
  }));
}
