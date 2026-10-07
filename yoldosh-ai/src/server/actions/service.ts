import type { Db } from '../db';
import type { ActionStatus, ActionView, OutcomeView, RiskLevel } from '../../shared/types';
import { getBusiness } from '../context/business';
import { scheduleOutcome } from '../feedback/outcomes';
import { errorMessage, newId, now } from '../lib/util';
import { decidePolicy } from './policy';
import { ACTIONS, actionLabel, assessRisk } from './registry';

/**
 * Action Layer xizmati: Insight → Decision → Action.
 * propose → (siyosat: auto | approval) → approve/reject/ignore → execute → outcome
 */

export class ActionValidationError extends Error {}

export type ActionSource = 'rule' | 'diagnosis' | 'agent' | 'user';

export interface ProposeInput {
  type: string;
  params: Record<string, unknown>;
  title?: string;
  source: ActionSource;
  rationale?: string;
  expectedImpact?: string;
  confidence?: number;
  findingId?: string | null;
  diagnosisId?: string | null;
  ruleId?: string | null;
  dedupeKey?: string | null;
  context?: Record<string, unknown>;
}

export interface ProposeResult {
  action: ActionView;
  created: boolean;
  policy: 'auto' | 'approval';
}

function toView(r: any, outcome?: any): ActionView {
  return {
    id: r.id,
    type: r.type,
    typeLabel: actionLabel(r.type),
    title: r.title,
    params: r.params,
    risk: r.risk,
    status: r.status,
    source: r.source,
    rationale: r.rationale,
    expectedImpact: r.expected_impact,
    confidence: r.confidence,
    createdAt: new Date(r.created_at).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decidedBy: r.decided_by,
    executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
    result: r.result,
    error: r.error,
    outcome: outcome?.id
      ? ({
          id: outcome.id,
          actionId: outcome.action_id,
          metric: outcome.metric,
          label: outcome.label,
          direction: outcome.direction,
          unit: outcome.unit,
          baseline: outcome.baseline,
          observed: outcome.observed,
          evaluateAt: new Date(outcome.evaluate_at).toISOString(),
          evaluatedAt: outcome.evaluated_at ? new Date(outcome.evaluated_at).toISOString() : null,
          verdict: outcome.verdict,
        } as OutcomeView)
      : null,
  };
}

export async function getAction(db: Db, businessId: string, id: string): Promise<ActionView | null> {
  const r = await db.one('SELECT * FROM actions WHERE business_id = $1 AND id = $2', [businessId, id]);
  if (!r) return null;
  const o = await db.one('SELECT * FROM outcomes WHERE action_id = $1 ORDER BY evaluate_at DESC LIMIT 1', [id]);
  return toView(r, o);
}

export async function listActions(
  db: Db,
  businessId: string,
  opts: { status?: ActionStatus | 'pending' | 'history'; limit?: number; ids?: string[] } = {},
): Promise<ActionView[]> {
  const statusFilter =
    opts.status === 'pending'
      ? `AND a.status = 'proposed'`
      : opts.status === 'history'
        ? `AND a.status <> 'proposed'`
        : opts.status
          ? `AND a.status = $3`
          : '';
  const params: unknown[] = [businessId, opts.limit ?? 100];
  if (opts.status && opts.status !== 'pending' && opts.status !== 'history') params.push(opts.status);
  let idFilter = '';
  if (opts.ids) {
    params.push(opts.ids);
    idFilter = `AND a.id = ANY($${params.length})`;
  }
  const rows = await db.query<any>(
    `SELECT a.*, row_to_json(o.*) AS outcome FROM actions a
       LEFT JOIN LATERAL (SELECT * FROM outcomes WHERE action_id = a.id ORDER BY evaluate_at DESC LIMIT 1) o ON true
      WHERE a.business_id = $1 ${statusFilter} ${idFilter}
      ORDER BY a.created_at DESC LIMIT $2`,
    params,
  );
  return rows.map((r) => toView(r, r.outcome));
}

export async function proposeAction(db: Db, businessId: string, input: ProposeInput): Promise<ProposeResult> {
  const def = ACTIONS[input.type];
  if (!def) throw new ActionValidationError(`Noma'lum harakat turi: ${input.type}`);
  const parsed = def.schema.safeParse(input.params);
  if (!parsed.success) {
    throw new ActionValidationError(
      `Parametrlar noto'g'ri (${input.type}): ${parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
    );
  }
  const business = await getBusiness(db, businessId);
  const risk: RiskLevel = await assessRisk({ db, businessId, settings: business.settings }, input.type, parsed.data);
  const policy = decidePolicy(risk, business.settings, input.source);

  if (input.dedupeKey) {
    const existing = await db.one(`SELECT id FROM actions WHERE business_id = $1 AND dedupe_key = $2 AND status <> 'failed'`, [businessId, input.dedupeKey]);
    if (existing) return { action: (await getAction(db, businessId, existing.id))!, created: false, policy };
  }

  const id = newId('act');
  try {
    await db.query(
      `INSERT INTO actions (id, business_id, type, title, params, risk, status, source, rationale, expected_impact, confidence,
          finding_id, diagnosis_id, rule_id, dedupe_key, context, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        businessId,
        input.type,
        input.title ?? def.label,
        parsed.data,
        risk,
        input.source,
        input.rationale ?? null,
        input.expectedImpact ?? null,
        input.confidence ?? null,
        input.findingId ?? null,
        input.diagnosisId ?? null,
        input.ruleId ?? null,
        input.dedupeKey ?? null,
        input.context ?? {},
        now(),
      ],
    );
  } catch (err) {
    // Parallel takroriy taklif (unique dedupe_key) — mavjudini qaytaramiz
    if (input.dedupeKey) {
      const existing = await db.one(`SELECT id FROM actions WHERE business_id = $1 AND dedupe_key = $2 AND status <> 'failed'`, [businessId, input.dedupeKey]);
      if (existing) return { action: (await getAction(db, businessId, existing.id))!, created: false, policy };
    }
    throw err;
  }

  if (policy === 'auto') {
    const executed = await executeAction(db, businessId, id, input.source === 'user' ? 'user' : 'policy:auto');
    return { action: executed, created: true, policy };
  }
  return { action: (await getAction(db, businessId, id))!, created: true, policy };
}

/** Harakatni bajarish (faqat 'proposed' yoki 'approved' holatdan). */
export async function executeAction(db: Db, businessId: string, id: string, decidedBy?: string): Promise<ActionView> {
  const claimed = await db.query<any>(
    `UPDATE actions SET status = 'executing', decided_at = COALESCE(decided_at, $3), decided_by = COALESCE(decided_by, $4)
      WHERE business_id = $1 AND id = $2 AND status IN ('proposed', 'approved') RETURNING *`,
    [businessId, id, now(), decidedBy ?? null],
  );
  if (claimed.length === 0) {
    const current = await getAction(db, businessId, id);
    if (!current) throw new ActionValidationError('Harakat topilmadi');
    return current;
  }
  const row = claimed[0];
  const def = ACTIONS[row.type];
  const business = await getBusiness(db, businessId);
  const at = now();
  try {
    const result = await def.execute({ db, businessId, business, actionId: id, at }, row.params);
    await db.query(`UPDATE actions SET status = 'executed', executed_at = $2, result = $3, error = NULL WHERE id = $1`, [id, at, result]);
    await scheduleOutcome(db, businessId, { id, type: row.type, params: row.params }, at);
  } catch (err) {
    await db.query(`UPDATE actions SET status = 'failed', error = $2, executed_at = $3 WHERE id = $1`, [id, errorMessage(err), at]);
  }
  return (await getAction(db, businessId, id))!;
}

export async function approveAction(db: Db, businessId: string, id: string, by: string, note?: string): Promise<ActionView> {
  const rows = await db.query(
    `UPDATE actions SET status = 'approved', decided_at = $3, decided_by = $4, decision_note = $5
      WHERE business_id = $1 AND id = $2 AND status = 'proposed' RETURNING id`,
    [businessId, id, now(), by, note ?? null],
  );
  if (rows.length === 0) {
    const current = await getAction(db, businessId, id);
    if (!current) throw new ActionValidationError('Harakat topilmadi');
    throw new ActionValidationError(`Harakat allaqachon "${current.status}" holatida`);
  }
  return executeAction(db, businessId, id, by);
}

async function decide(db: Db, businessId: string, id: string, status: 'rejected' | 'ignored', by: string, note?: string) {
  const rows = await db.query(
    `UPDATE actions SET status = $3, decided_at = $4, decided_by = $5, decision_note = $6
      WHERE business_id = $1 AND id = $2 AND status = 'proposed' RETURNING id`,
    [businessId, id, status, now(), by, note ?? null],
  );
  if (rows.length === 0) throw new ActionValidationError('Harakat topilmadi yoki allaqachon hal qilingan');
  return (await getAction(db, businessId, id))!;
}

export const rejectAction = (db: Db, businessId: string, id: string, by: string, note?: string) => decide(db, businessId, id, 'rejected', by, note);
export const ignoreAction = (db: Db, businessId: string, id: string, by: string, note?: string) => decide(db, businessId, id, 'ignored', by, note);
