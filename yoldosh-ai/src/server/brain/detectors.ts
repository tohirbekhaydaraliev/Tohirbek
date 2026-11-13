import type { Finding } from '../../shared/types';
import * as q from '../metrics/queries';
import { comparisonRanges, fmtMinutes, fmtMoney, newId, pctChange, round, safeDiv } from '../lib/util';
import { targetFor, type BrainContext } from './context';
import { scoreChurn } from './scoring';

/**
 * Detektorlar — biznes holatini doimiy kuzatib, muammolarni (findings) aniqlaydi.
 * Biznes qoidalari (IF ... THEN ...) shu detektorlar ustiga quriladi.
 */

export interface DetectedFinding {
  detector: string;
  dedupeKey: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  summary: string;
  metrics: Record<string, unknown>;
  entityType: string | null;
  entityIds: string[];
  /** Taxminiy pul ta'siri (so'm) — ustuvorlik uchun */
  impact: number;
  /** Qoidalar uchun batafsil elementlar */
  items: Array<Record<string, any>>;
}

export interface DetectorParam {
  key: string;
  label: string;
  default: number;
  unit?: string;
}

export interface DetectorDefinition {
  key: string;
  label: string;
  description: string;
  params: DetectorParam[];
  actions: string[];
  run(ctx: BrainContext, params: Record<string, number>): Promise<DetectedFinding[]>;
}

function p(params: Record<string, number>, def: DetectorDefinition, key: string): number {
  const v = params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return def.params.find((x) => x.key === key)?.default ?? 0;
}

/** Tez javob berilgan leadlar konversiyasi va o'rtacha birinchi to'lov — "yo'qotilgan imkoniyat" bahosi uchun */
async function opportunityValue(ctx: BrainContext) {
  const buckets = await q.conversionByResponseBucket(ctx.db, ctx.businessId, ctx.at);
  const fast = buckets.find((b) => b.ord === 1);
  const rev = await q.revenueSummary(ctx.db, ctx.businessId, comparisonRanges(60, ctx.at).current);
  return { fastConversion: fast?.conversion ?? 0.12, avgFirstPayment: rev.avgNewPayment || 1_000_000 };
}

const leadUnanswered: DetectorDefinition = {
  key: 'lead_unanswered',
  label: 'Javobsiz leadlar',
  description: 'Belgilangan soatdan ortiq birinchi javob olmagan leadlar.',
  params: [{ key: 'hours', label: 'Soat', default: 2, unit: 'soat' }],
  actions: ['create_task', 'reassign_leads', 'notify_employee'],
  async run(ctx, params) {
    const hours = p(params, this, 'hours');
    const leads = await q.unansweredLeads(ctx.db, ctx.businessId, hours, ctx.at);
    if (leads.length === 0) return [];
    const { fastConversion, avgFirstPayment } = await opportunityValue(ctx);
    const byManager = new Map<string, { id: string | null; name: string; count: number }>();
    const bySegment = new Map<string, number>();
    for (const l of leads) {
      const key = l.assigned_to ?? '-';
      const m = byManager.get(key) ?? { id: l.assigned_to, name: l.manager_name ?? 'Biriktirilmagan', count: 0 };
      m.count++;
      byManager.set(key, m);
      bySegment.set(l.segment ?? 'Boshqa', (bySegment.get(l.segment ?? 'Boshqa') ?? 0) + 1);
    }
    const lostSales = leads.length * fastConversion;
    const managers = [...byManager.values()].sort((a, b) => b.count - a.count);
    const segs = [...bySegment.entries()].sort((a, b) => b[1] - a[1]);
    return [
      {
        detector: this.key,
        dedupeKey: `lead_unanswered`,
        severity: leads.length >= 20 ? 'critical' : leads.length >= 5 ? 'warning' : 'info',
        title: `${leads.length} ta lead ${hours}+ soat javobsiz`,
        summary: `Eng ko'p: ${managers
          .slice(0, 2)
          .map((m) => `${m.name} — ${m.count}`)
          .join(', ')}. Segmentlar: ${segs.map(([s, n]) => `${s} ${n}`).join(', ')}. Taxminiy yo'qotilayotgan imkoniyat: ~${round(lostSales, 0)} ta sotuv (${fmtMoney(lostSales * avgFirstPayment)}).`,
        metrics: {
          count: leads.length,
          byManager: managers,
          bySegment: Object.fromEntries(segs),
          estimatedLostSales: round(lostSales, 1),
          oldestWaitingMinutes: Math.round(Math.max(...leads.map((l) => l.waiting_minutes))),
        },
        entityType: 'lead',
        entityIds: leads.map((l) => l.id),
        impact: lostSales * avgFirstPayment,
        items: leads.map((l) => ({ ...l })),
      },
    ];
  },
};

const responseTimeSla: DetectorDefinition = {
  key: 'response_time_sla',
  label: 'Javob vaqti SLA buzilishi',
  description: "Segment bo'yicha so'nggi 7 kunlik median birinchi javob vaqti SLA'dan oshsa.",
  params: [{ key: 'minutes', label: 'SLA (daqiqa)', default: 15, unit: 'daq' }],
  actions: ['create_task', 'notify_employee', 'update_sla'],
  async run(ctx, params) {
    const sla = params.minutes ?? ctx.business.settings.responseSlaMinutes;
    const { current, previous } = comparisonRanges(7, ctx.at);
    const [cur, prev] = await Promise.all([
      q.responseTimes(ctx.db, ctx.businessId, current, 'segment', sla),
      q.responseTimes(ctx.db, ctx.businessId, previous, 'segment', sla),
    ]);
    const out: DetectedFinding[] = [];
    for (const r of cur) {
      if (r.medianMinutes === null || r.medianMinutes <= sla || r.leads < 5) continue;
      const pr = prev.find((x) => x.key === r.key);
      out.push({
        detector: this.key,
        dedupeKey: `response_time_sla:${r.key}`,
        severity: r.medianMinutes > sla * 2.5 ? 'critical' : 'warning',
        title: `${r.label}: birinchi javob ${fmtMinutes(r.medianMinutes)} (SLA ${sla} daq)`,
        summary: `So'nggi 7 kunda ${r.leads} lead, SLA ichida javob — ${Math.round(r.withinSlaShare * 100)}%. Oldingi hafta median: ${fmtMinutes(pr?.medianMinutes ?? null)}.`,
        metrics: { segment: r.key, median: r.medianMinutes, prevMedian: pr?.medianMinutes ?? null, withinSlaShare: r.withinSlaShare, leads: r.leads },
        entityType: 'segment',
        entityIds: [r.key],
        impact: 0,
        items: [],
      });
    }
    return out;
  },
};

const customerInactive: DetectorDefinition = {
  key: 'customer_inactive',
  label: 'Faol bo‘lmagan mijozlar',
  description: "Faol obunasi bor, lekin belgilangan kundan ortiq darsga kelmagan / faol bo'lmagan mijozlar.",
  params: [{ key: 'days', label: 'Kun', default: 7, unit: 'kun' }],
  actions: ['retention_outreach', 'notify_employee', 'create_task'],
  async run(ctx, params) {
    const days = p(params, this, 'days');
    const scores = await scoreChurn(ctx);
    const inactive = scores.filter((s) => s.daysSinceLastPresent !== null && s.daysSinceLastPresent > days);
    if (inactive.length === 0) return [];
    const revenueAtRisk = inactive.reduce((a, s) => a + s.monthlyPrice, 0);
    return [
      {
        detector: this.key,
        dedupeKey: 'customer_inactive',
        severity: inactive.length >= 10 ? 'critical' : 'warning',
        title: `${inactive.length} ta mijoz ${days}+ kundan beri faol emas`,
        summary: `Oylik ${fmtMoney(revenueAtRisk)} daromad xavf ostida. ${inactive
          .slice(0, 3)
          .map((s) => `${s.name} (${s.daysSinceLastPresent} kun)`)
          .join(', ')}${inactive.length > 3 ? '...' : ''}`,
        metrics: { count: inactive.length, revenueAtRisk },
        entityType: 'customer',
        entityIds: inactive.map((s) => s.customerId),
        impact: revenueAtRisk,
        items: inactive.map((s) => ({ ...s })),
      },
    ];
  },
};

const churnRisk: DetectorDefinition = {
  key: 'churn_risk',
  label: 'Churn xavfi',
  description: 'Churn ehtimoli chegaradan yuqori bo‘lgan mijozlar (davomat, to‘lov, sodiqlik asosida).',
  params: [{ key: 'threshold', label: 'Ehtimol chegarasi', default: 0.6 }],
  actions: ['notify_employee', 'retention_outreach', 'create_task'],
  async run(ctx, params) {
    const threshold = params.threshold ?? ctx.business.settings.churnThreshold;
    const scores = (await scoreChurn(ctx)).filter((s) => s.probability >= threshold).sort((a, b) => b.probability - a.probability);
    if (scores.length === 0) return [];
    // Qolgan kutilgan muddat ~ 3 oy deb baholanadi
    const impact = scores.reduce((a, s) => a + s.monthlyPrice * 3 * s.probability, 0);
    return [
      {
        detector: this.key,
        dedupeKey: 'churn_risk',
        severity: scores.length >= 10 ? 'critical' : 'warning',
        title: `${scores.length} ta mijoz churn xavfida`,
        summary: `${scores
          .slice(0, 3)
          .map((s) => `${s.name} — ${Math.round(s.probability * 100)}% (${s.reasons[0] ?? ''})`)
          .join('; ')}. Kutilayotgan yo'qotish: ~${fmtMoney(impact)}.`,
        metrics: { count: scores.length, threshold, expectedLoss: impact },
        entityType: 'customer',
        entityIds: scores.map((s) => s.customerId),
        impact,
        items: scores.map((s) => ({ ...s })),
      },
    ];
  },
};

const cacAboveTarget: DetectorDefinition = {
  key: 'cac_above_target',
  label: 'CAC maqsaddan yuqori',
  description: "Kampaniya CAC maqsaddan oshsa yoki oldingi davrga nisbatan keskin o'ssa (so'nggi 14 kun).",
  params: [{ key: 'growthPct', label: "O'sish chegarasi (%)", default: 20, unit: '%' }],
  actions: ['analyze_campaign', 'change_campaign_budget', 'pause_campaign'],
  async run(ctx, params) {
    const growth = p(params, this, 'growthPct') / 100;
    const target = targetFor(ctx, 'cac')?.target ?? null;
    const { current, previous } = comparisonRanges(30, ctx.at);
    const sla = ctx.business.settings.responseSlaMinutes;
    const [cur, prev, rtCur, rtPrev] = await Promise.all([
      q.campaignPerformance(ctx.db, ctx.businessId, current),
      q.campaignPerformance(ctx.db, ctx.businessId, previous),
      q.responseTimes(ctx.db, ctx.businessId, current, 'segment', sla),
      q.responseTimes(ctx.db, ctx.businessId, previous, 'segment', sla),
    ]);
    const out: DetectedFinding[] = [];
    for (const c of cur) {
      if (c.spend <= 0 || c.status !== 'active') continue;
      const pc = prev.find((x) => x.campaign_id === c.campaign_id);
      const cac = c.cac ?? c.spend; // sotuv yo'q bo'lsa — butun xarajat
      const change = pc?.cac ? pctChange(cac, pc.cac) : null;
      const overTarget = target !== null && cac > target;
      const rising = change !== null && change > growth;
      if (!overTarget && !rising) continue;
      // Sabab: reklama (CPL / lead sifati) yoki sotuv bo'limi (segmentda javob vaqti keskin yomonlashgan)
      const cplChange = pc?.cpl ? pctChange(c.cpl, pc.cpl) : null;
      const leadsCur = c.platform_leads || c.crm_leads;
      const leadsPrev = pc ? pc.platform_leads || pc.crm_leads : 0;
      const convChange = pc && leadsPrev > 0 && pc.won > 0 ? pctChange(safeDiv(c.won, leadsCur), safeDiv(pc.won, leadsPrev)) : null;
      const segRtCur = rtCur.find((r) => r.key === c.segment)?.medianMinutes ?? null;
      const segRtPrev = rtPrev.find((r) => r.key === c.segment)?.medianMinutes ?? null;
      const salesSlowdown = segRtCur !== null && segRtPrev !== null && segRtPrev > 0 && segRtCur > segRtPrev * 1.5;
      const cause: 'marketing' | 'sales' | 'mixed' =
        salesSlowdown && (cplChange ?? 0) < 0.15 ? 'sales' : salesSlowdown ? 'mixed' : 'marketing';
      const causeText =
        cause === 'sales'
          ? `Sabab sotuv bo'limida: ${c.segment} leadlariga javob vaqti ${fmtMinutes(segRtPrev)} → ${fmtMinutes(segRtCur)}, konversiya ${convChange !== null ? `${Math.round(convChange * 100)}%` : 'tushgan'}; CPL deyarli o'zgarmagan.`
          : `Sabab reklamada: CPL ${cplChange !== null ? `${cplChange > 0 ? '+' : ''}${Math.round(cplChange * 100)}%` : '—'}${convChange !== null && convChange < -0.1 ? `, lead sifati (konversiya) ${Math.round(convChange * 100)}%` : ''}.`;
      const excess = target !== null ? Math.max(0, c.spend - target * c.won) : 0;
      const extraSpend = change !== null && change > 0 ? (c.spend * change) / (1 + change) : 0;
      out.push({
        detector: this.key,
        dedupeKey: `cac_above_target:${c.campaign_id}`,
        severity: (target !== null && cac > target * 1.5) || (change ?? 0) > 0.5 ? 'critical' : 'warning',
        title: `${c.name}: CAC ${fmtMoney(cac)}${change !== null ? ` (${change > 0 ? '+' : ''}${Math.round(change * 100)}%)` : ''}`,
        summary: `Xarajat ${fmtMoney(c.spend)}, ${c.won} ta sotuv, CPL ${fmtMoney(c.cpl)}${
          target !== null ? `, maqsad CAC ${fmtMoney(target)}` : ''
        }. Oldingi davr CAC: ${pc?.cac ? fmtMoney(pc.cac) : '—'}. ${causeText}`,
        metrics: {
          cause,
          cplChange,
          convChange,
          campaignId: c.campaign_id,
          name: c.name,
          spend: c.spend,
          won: c.won,
          cac,
          prevCac: pc?.cac ?? null,
          change,
          cpl: c.cpl,
          prevCpl: pc?.cpl ?? null,
          target,
          dailyBudget: c.daily_budget,
        },
        entityType: 'campaign',
        entityIds: [c.campaign_id],
        impact: Math.max(excess, extraSpend) * (cause === 'sales' ? 0.5 : 1),
        items: [{ ...c, prevCac: pc?.cac ?? null, change }],
      });
    }
    return out;
  },
};

const groupCapacity: DetectorDefinition = {
  key: 'group_capacity',
  label: "Guruh sig'imi to'lmoqda",
  description: "Guruh to'lishi chegaradan oshsa — yangi leadlarni boshqa guruhga yo'naltirish kerak.",
  params: [{ key: 'threshold', label: "To'lish chegarasi", default: 0.9 }],
  actions: ['route_leads', 'notify_employee'],
  async run(ctx, params) {
    const threshold = p(params, this, 'threshold');
    const groups = await q.groupCapacity(ctx.db, ctx.businessId);
    const out: DetectedFinding[] = [];
    for (const g of groups) {
      if ((g.utilization ?? 0) < threshold) continue;
      const alternatives = groups
        .filter((x) => x.segment === g.segment && x.group_id !== g.group_id && (x.utilization ?? 0) < 0.8)
        .sort((a, b) => (a.utilization ?? 0) - (b.utilization ?? 0));
      out.push({
        detector: this.key,
        dedupeKey: `group_capacity:${g.group_id}`,
        severity: (g.utilization ?? 0) >= 1 ? 'critical' : 'warning',
        title: `${g.name}: ${g.active}/${g.capacity} (${Math.round((g.utilization ?? 0) * 100)}%)`,
        summary: alternatives.length
          ? `Bo'sh joy bor: ${alternatives
              .slice(0, 2)
              .map((a) => `${a.name} (${a.active}/${a.capacity})`)
              .join(', ')}.`
          : `${g.segment} segmentida bo'sh guruh yo'q — yangi guruh ochish kerak.`,
        metrics: { groupId: g.group_id, segment: g.segment, utilization: g.utilization, alternativeGroupId: alternatives[0]?.group_id ?? null },
        entityType: 'group',
        entityIds: [g.group_id],
        impact: 0,
        items: [{ ...g, alternativeGroupId: alternatives[0]?.group_id ?? null, alternativeName: alternatives[0]?.name ?? null }],
      });
    }
    return out;
  },
};

const paymentOverdue: DetectorDefinition = {
  key: 'payment_overdue',
  label: "Kechikkan to'lovlar",
  description: "Muddati belgilangan kundan ortiq o'tgan to'lanmagan to'lovlar.",
  params: [{ key: 'days', label: 'Kun', default: 3, unit: 'kun' }],
  actions: ['send_payment_reminder', 'create_task'],
  async run(ctx, params) {
    const days = p(params, this, 'days');
    const rows = await q.overduePayments(ctx.db, ctx.businessId, ctx.at, days);
    if (rows.length === 0) return [];
    const total = rows.reduce((a, r) => a + r.amount, 0);
    return [
      {
        detector: this.key,
        dedupeKey: 'payment_overdue',
        severity: total > 30_000_000 ? 'critical' : 'warning',
        title: `${rows.length} ta to'lov ${days}+ kun kechikkan (${fmtMoney(total)})`,
        summary: `Eng eskisi ${Math.max(...rows.map((r) => r.days_overdue))} kun. O'rtacha summa ${fmtMoney(safeDiv(total, rows.length))}.`,
        metrics: { count: rows.length, total },
        entityType: 'payment',
        entityIds: rows.map((r) => r.id),
        impact: total,
        items: rows.map((r) => ({ ...r })),
      },
    ];
  },
};

export const DETECTORS: Record<string, DetectorDefinition> = Object.fromEntries(
  [leadUnanswered, responseTimeSla, customerInactive, churnRisk, cacAboveTarget, groupCapacity, paymentOverdue].map((d) => [d.key, d]),
);

export function detectorCatalog() {
  return Object.values(DETECTORS).map(({ key, label, description, params, actions }) => ({ key, label, description, params, actions }));
}

/** Detektorlarni ishga tushiradi (qoidalardagi parametrlar bilan) va natijani findings jadvaliga yozadi. */
export async function refreshFindings(ctx: BrainContext): Promise<Finding[]> {
  const rules = await ctx.db.query<{ detector: string; params: Record<string, number> }>(
    `SELECT detector, params FROM business_rules WHERE business_id = $1 AND enabled ORDER BY created_at`,
    [ctx.businessId],
  );
  const paramsFor = (key: string) => rules.find((r) => r.detector === key)?.params ?? {};
  const detected: DetectedFinding[] = [];
  for (const det of Object.values(DETECTORS)) {
    detected.push(...(await det.run(ctx, paramsFor(det.key))));
  }
  const keys = detected.map((d) => d.dedupeKey);
  for (const f of detected) {
    await ctx.db.query(
      `INSERT INTO findings (id, business_id, detector, severity, title, summary, metrics, entity_type, entity_ids, impact, dedupe_key, status, first_detected_at, last_detected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$12)
       ON CONFLICT (business_id, dedupe_key) DO UPDATE SET
         severity = EXCLUDED.severity, title = EXCLUDED.title, summary = EXCLUDED.summary, metrics = EXCLUDED.metrics,
         entity_ids = EXCLUDED.entity_ids, impact = EXCLUDED.impact, last_detected_at = EXCLUDED.last_detected_at,
         status = 'open', resolved_at = NULL,
         first_detected_at = CASE WHEN findings.status = 'resolved' THEN EXCLUDED.first_detected_at ELSE findings.first_detected_at END`,
      [newId('fnd'), ctx.businessId, f.detector, f.severity, f.title, f.summary, f.metrics, f.entityType, f.entityIds, f.impact, f.dedupeKey, ctx.at],
    );
  }
  await ctx.db.query(
    `UPDATE findings SET status = 'resolved', resolved_at = $3
      WHERE business_id = $1 AND status = 'open' AND NOT (dedupe_key = ANY($2::text[]))`,
    [ctx.businessId, keys, ctx.at],
  );
  return listFindings(ctx, 'open');
}

export async function listFindings(ctx: Pick<BrainContext, 'db' | 'businessId'>, status: 'open' | 'resolved' | 'all' = 'open'): Promise<Finding[]> {
  const rows = await ctx.db.query<any>(
    `SELECT * FROM findings WHERE business_id = $1 AND ($2 = 'all' OR status = $2)
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, impact DESC, last_detected_at DESC`,
    [ctx.businessId, status],
  );
  return rows.map((r) => ({
    id: r.id,
    detector: r.detector,
    severity: r.severity,
    title: r.title,
    summary: r.summary,
    metrics: r.metrics,
    entityType: r.entity_type,
    entityIds: r.entity_ids,
    impact: r.impact,
    status: r.status,
    firstDetectedAt: new Date(r.first_detected_at).toISOString(),
    lastDetectedAt: new Date(r.last_detected_at).toISOString(),
  }));
}
