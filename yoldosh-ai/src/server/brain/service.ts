import type { Db } from '../db';
import type { Diagnosis, Recommendation } from '../../shared/types';
import { proposeAction } from '../actions/service';
import { aiEnabled } from '../agents/llm';
import { config } from '../config';
import { errorMessage, isoDate, newId, now } from '../lib/util';
import { loadBrainContext } from './context';
import { refreshFindings } from './detectors';
import { computeDiagnosis, engineNarrative } from './diagnosis';
import { narrateDiagnosis } from './narrate';

/**
 * Kunlik biznes diagnostikasi (Daily Business Diagnosis):
 * detektorlar → KPI daraxti → root cause → ustuvorliklar → tavsiyalar → harakat takliflari → (AI) matn.
 */
export async function runDiagnosis(
  db: Db,
  businessId: string,
  opts: { kind?: 'daily' | 'adhoc'; windowDays?: number; narrate?: boolean; propose?: boolean } = {},
): Promise<Diagnosis> {
  const ctx = await loadBrainContext(db, businessId);
  const findings = await refreshFindings(ctx);
  const draft = await computeDiagnosis(ctx, findings, opts.windowDays);
  const id = newId('dgn');

  // Tavsiyalarni Action Layer'ga taklif sifatida yuborish (siyosat bo'yicha auto yoki tasdiq)
  const recommendations: Recommendation[] = [];
  for (const rec of draft.recommendations) {
    if (opts.propose === false) {
      recommendations.push(rec);
      continue;
    }
    try {
      const res = await proposeAction(db, businessId, {
        type: rec.actionType,
        params: rec.params,
        title: rec.title,
        source: 'diagnosis',
        rationale: rec.rationale,
        expectedImpact: rec.expectedImpact,
        confidence: rec.confidence,
        diagnosisId: id,
        dedupeKey: `diag:${rec.actionType}:${isoDate(ctx.at)}:${String(rec.params.campaignId ?? rec.params.segment ?? rec.params.toGroupId ?? '')}`,
        context: { rootCause: draft.rootCause?.headline ?? null },
      });
      recommendations.push({ ...rec, actionId: res.action.id, actionStatus: res.action.status });
    } catch (err) {
      recommendations.push({ ...rec, rationale: `${rec.rationale} (taklif xatosi: ${errorMessage(err)})` });
    }
  }

  let narrative = engineNarrative({ ...draft, recommendations });
  let generatedBy: 'engine' | 'ai' = 'engine';
  if (opts.narrate !== false && aiEnabled()) {
    try {
      narrative = await narrateDiagnosis({ ...draft, recommendations }, ctx.business.name);
      generatedBy = 'ai';
    } catch (err) {
      console.warn('[diagnosis] AI matn yozilmadi:', errorMessage(err));
    }
  }

  await db.query(
    `INSERT INTO diagnoses (id, business_id, kind, window_days, period_start, period_end, kpis, tree, root_cause, priorities, recommendations, narrative, generated_by, model, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      businessId,
      opts.kind ?? 'adhoc',
      draft.windowDays,
      draft.periodStart,
      draft.periodEnd,
      JSON.stringify(draft.kpis),
      draft.tree,
      draft.rootCause,
      JSON.stringify(draft.priorities),
      JSON.stringify(recommendations),
      narrative,
      generatedBy,
      generatedBy === 'ai' ? config.model : null,
      now(),
    ],
  );
  return (await getDiagnosis(db, businessId, id))!;
}

function toDiagnosis(r: any): Diagnosis {
  return {
    id: r.id,
    kind: r.kind,
    windowDays: r.window_days,
    periodStart: new Date(r.period_start).toISOString(),
    periodEnd: new Date(r.period_end).toISOString(),
    kpis: r.kpis,
    tree: r.tree,
    rootCause: r.root_cause,
    priorities: r.priorities,
    recommendations: r.recommendations,
    narrative: r.narrative,
    generatedBy: r.generated_by,
    model: r.model,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Tavsiyalardagi harakatlar holatini yangilab qaytaradi (tasdiqlangan/bajarilgan). */
async function refreshRecommendationStatus(db: Db, d: Diagnosis): Promise<Diagnosis> {
  const ids = d.recommendations.map((r) => r.actionId).filter((x): x is string => !!x);
  if (!ids.length) return d;
  const rows = await db.query<{ id: string; status: any }>('SELECT id, status FROM actions WHERE id = ANY($1)', [ids]);
  const status = new Map(rows.map((r) => [r.id, r.status]));
  return { ...d, recommendations: d.recommendations.map((r) => (r.actionId ? { ...r, actionStatus: status.get(r.actionId) ?? r.actionStatus } : r)) };
}

export async function getDiagnosis(db: Db, businessId: string, id: string): Promise<Diagnosis | null> {
  const r = await db.one('SELECT * FROM diagnoses WHERE business_id = $1 AND id = $2', [businessId, id]);
  return r ? refreshRecommendationStatus(db, toDiagnosis(r)) : null;
}

export async function latestDiagnosis(db: Db, businessId: string): Promise<Diagnosis | null> {
  const r = await db.one('SELECT * FROM diagnoses WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1', [businessId]);
  return r ? refreshRecommendationStatus(db, toDiagnosis(r)) : null;
}

export async function listDiagnoses(db: Db, businessId: string, limit = 30) {
  const rows = await db.query<any>(
    `SELECT id, kind, window_days, created_at, generated_by, root_cause->>'headline' AS headline,
            (SELECT x->>'change' FROM jsonb_array_elements(kpis) x WHERE x->>'key' = 'revenue') AS revenue_change
       FROM diagnoses WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [businessId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    windowDays: r.window_days,
    createdAt: new Date(r.created_at).toISOString(),
    generatedBy: r.generated_by,
    headline: r.headline,
    revenueChange: r.revenue_change === null ? null : Number(r.revenue_change),
  }));
}

/** Bugun uchun kunlik diagnostika bormi? */
export async function hasDailyDiagnosisToday(db: Db, businessId: string): Promise<boolean> {
  const r = await db.one(
    `SELECT 1 FROM diagnoses WHERE business_id = $1 AND kind = 'daily' AND created_at > now() - interval '20 hours' LIMIT 1`,
    [businessId],
  );
  return !!r;
}
