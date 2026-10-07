import type { Finding, Kpi, Priority, Recommendation, RootCause, TreeNode } from '../../shared/types';
import { assessRisk, actionLabel } from '../actions/registry';
import { confidenceFrom, learningStats, type LearningStat } from '../feedback/outcomes';
import * as q from '../metrics/queries';
import { fmtMinutes, fmtMoney, fmtPct, round, safeDiv } from '../lib/util';
import type { BrainContext } from './context';
import { kpiSnapshot, type KpiSnapshot } from './kpis';
import { adverseContribution, attachContribution, findNode, makeNode, markPath, productContributions, type Good } from './tree';

/**
 * Decision Engine: Detect → Diagnose → Recommend.
 *
 * Daromad o'zgarishi KPI daraxti bo'ylab parchalanadi:
 *   Daromad = Yangi mijozlar daromadi + Takroriy to'lovlar
 *   Yangi daromad = Yangi to'lovchilar × O'rtacha birinchi to'lov
 *   Sotuvlar = Leadlar × Konversiya → segmentlar → drayverlar (javob vaqti, SLA, sinov)
 * Har qadamda eng katta salbiy hissali tarmoq tanlanadi — shunday qilib
 * "Revenue tushdi" dan aniq operatsion sababgacha bo'lgan yo'l topiladi.
 */

export interface DiagnosisData {
  snapshot: KpiSnapshot;
  leadSources: { cur: Array<{ key: string; leads: number }>; prev: Array<{ key: string; leads: number }> };
  revenueBySegment: { cur: Awaited<ReturnType<typeof q.revenueBySegment>>; prev: Awaited<ReturnType<typeof q.revenueBySegment>> };
  overdue: { count: number; amount: number };
  segmentEvidence: Record<
    string,
    {
      buckets: Awaited<ReturnType<typeof q.conversionByResponseBucket>>;
      managers: q.ManagerPerf[];
    }
  >;
}

async function leadSources(ctx: BrainContext, range: { start: Date; end: Date }) {
  return ctx.db.query<{ key: string; leads: number }>(
    `SELECT COALESCE(c.name, CASE cu.source WHEN 'website' THEN 'Veb-sayt (organik)' WHEN 'referral' THEN 'Tavsiya (referral)'
              WHEN 'instagram' THEN 'Instagram (organik)' ELSE COALESCE(cu.source, l.source) END) AS key, count(*) AS leads
       FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id JOIN customers cu ON cu.id = l.customer_id
      WHERE l.business_id = $1 AND l.created_at >= $2 AND l.created_at < $3
      GROUP BY 1 ORDER BY 2 DESC`,
    [ctx.businessId, range.start, range.end],
  );
}

export async function gatherDiagnosisData(ctx: BrainContext, windowDays?: number): Promise<DiagnosisData> {
  const snapshot = await kpiSnapshot(ctx, windowDays);
  const { current, previous } = snapshot;
  const [lsCur, lsPrev, rsCur, rsPrev, overdue] = await Promise.all([
    leadSources(ctx, current),
    leadSources(ctx, previous),
    q.revenueBySegment(ctx.db, ctx.businessId, current),
    q.revenueBySegment(ctx.db, ctx.businessId, previous),
    q.overduePayments(ctx.db, ctx.businessId, ctx.at, 0),
  ]);
  // Konversiyasi tushgan segmentlar uchun sababiy dalillar
  const segmentEvidence: DiagnosisData['segmentEvidence'] = {};
  for (const seg of snapshot.raw.funnel.cur) {
    const prev = snapshot.raw.funnel.prev.find((p) => p.segment === seg.segment);
    if (!prev || prev.conversion === 0) continue;
    if (seg.conversion < prev.conversion * 0.9) {
      const [buckets, managers] = await Promise.all([
        q.conversionByResponseBucket(ctx.db, ctx.businessId, ctx.at, { segment: seg.segment }),
        q.managerPerformance(ctx.db, ctx.businessId, current, seg.segment),
      ]);
      segmentEvidence[seg.segment] = { buckets, managers };
    }
  }
  return {
    snapshot,
    leadSources: { cur: lsCur, prev: lsPrev },
    revenueBySegment: { cur: rsCur, prev: rsPrev },
    overdue: { count: overdue.length, amount: overdue.reduce((a, r) => a + r.amount, 0) },
    segmentEvidence,
  };
}

// ---------------- Daraxt (sof funksiya) ----------------

export function buildRevenueTree(data: DiagnosisData): TreeNode {
  const { raw } = data.snapshot;
  const rc = raw.revenue.cur;
  const rp = raw.revenue.prev;

  const root = makeNode('revenue', 'Daromad', 'money', rc.total, rp.total, 'root');

  // 1-daraja: yangi vs takroriy
  const newRev = attachContribution(root, makeNode('revenue.new', 'Yangi mijozlar daromadi', 'money', rc.newRevenue, rp.newRevenue, 'sum'), rc.newRevenue - rp.newRevenue);
  const renewal = attachContribution(root, makeNode('revenue.renewal', "Takroriy to'lovlar", 'money', rc.renewal, rp.renewal, 'sum'), rc.renewal - rp.renewal);
  root.children.push(newRev, renewal);
  if (rc.other || rp.other) {
    root.children.push(attachContribution(root, makeNode('revenue.other', 'Boshqa', 'money', rc.other, rp.other, 'sum'), rc.other - rp.other));
  }

  // 2-daraja: yangi daromad = to'lovchilar × o'rtacha to'lov
  const payers = makeNode('new.payers', "Yangi to'lovchi mijozlar", 'count', rc.newPayments, rp.newPayments, 'product');
  const aov = makeNode('new.aov', "O'rtacha birinchi to'lov", 'money', rc.avgNewPayment, rp.avgNewPayment, 'product');
  const [cPayers, cAov] = productContributions(newRev, [payers, aov]);
  newRev.children.push(attachContribution(newRev, payers, cPayers), attachContribution(newRev, aov, cAov));

  // Mahsulot miksi (AOV izohi)
  const segRevenue = (rows: DiagnosisData['revenueBySegment']['cur']) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.kind === 'new') m.set(r.segment, (m.get(r.segment) ?? 0) + r.payments);
    return m;
  };
  const mixCur = segRevenue(data.revenueBySegment.cur);
  const mixPrev = segRevenue(data.revenueBySegment.prev);
  const totalCur = [...mixCur.values()].reduce((a, b) => a + b, 0);
  const totalPrev = [...mixPrev.values()].reduce((a, b) => a + b, 0);
  for (const seg of new Set([...mixCur.keys(), ...mixPrev.keys()])) {
    const shareCur = safeDiv(mixCur.get(seg) ?? 0, totalCur);
    const sharePrev = safeDiv(mixPrev.get(seg) ?? 0, totalPrev);
    aov.children.push(makeNode(`new.aov.mix.${seg}`, `${seg} ulushi (yangi sotuvlarda)`, 'ratio', shareCur, sharePrev, 'driver', 'up', { status: 'ok' }));
  }

  // 3-daraja: sotuv voronkasi (drayver) — Sotuvlar = Leadlar × Konversiya
  const tc = q.totalFunnel(raw.funnel.cur);
  const tp = q.totalFunnel(raw.funnel.prev);
  const sales = makeNode('funnel.sales', 'Sotuvlar (lead → sotuv)', 'count', tc.won, tp.won, 'driver', 'up', {
    note: "Yangi to'lovlar CRM'dagi sotuvlarga tayanadi",
  });
  payers.children.push(sales);
  const leads = makeNode('funnel.leads', 'Leadlar', 'count', tc.leads, tp.leads, 'product');
  const conv = makeNode('funnel.conversion', 'Konversiya (lead → sotuv)', 'ratio', tc.conversion, tp.conversion, 'product');
  const [cLeads, cConv] = productContributions(sales, [leads, conv]);
  sales.children.push(attachContribution(sales, leads, cLeads), attachContribution(sales, conv, cConv));

  // Leadlar manbalar bo'yicha (yig'indi)
  const srcKeys = new Set([...data.leadSources.cur.map((s) => s.key), ...data.leadSources.prev.map((s) => s.key)]);
  const srcNodes = [...srcKeys].map((k) => {
    const cur = data.leadSources.cur.find((s) => s.key === k)?.leads ?? 0;
    const prev = data.leadSources.prev.find((s) => s.key === k)?.leads ?? 0;
    return attachContribution(leads, makeNode(`funnel.leads.${k}`, k, 'count', cur, prev, 'sum'), cur - prev);
  });
  leads.children.push(...srcNodes.sort((a, b) => Math.abs(b.contribution ?? 0) - Math.abs(a.contribution ?? 0)).slice(0, 7));

  // Konversiya segmentlar bo'yicha: stavka effekti (joriy ulush × stavka o'zgarishi) + miks effekti
  let rateEffectSum = 0;
  for (const s of raw.funnel.cur) {
    const p = raw.funnel.prev.find((x) => x.segment === s.segment);
    const wCur = safeDiv(s.leads, tc.leads);
    const rateEffect = wCur * (s.conversion - (p?.conversion ?? s.conversion));
    rateEffectSum += rateEffect;
    const segNode = attachContribution(
      conv,
      makeNode(`funnel.conversion.${s.segment}`, `${s.segment} konversiyasi`, 'ratio', s.conversion, p?.conversion ?? 0, 'sum', 'up', {
        note: `${s.leads} lead → ${s.won} sotuv`,
      }),
      rateEffect,
    );
    conv.children.push(segNode);
    addSegmentDrivers(segNode, s.segment, data);
  }
  const mix = tc.conversion - tp.conversion - rateEffectSum;
  if (Math.abs(mix) > 0.002) {
    conv.children.push(attachContribution(conv, makeNode('funnel.conversion.mix', 'Segment miksi effekti', 'ratio', mix, 0, 'sum', 'up', { status: 'ok' }), mix));
  }
  conv.children.sort((a, b) => (a.contribution ?? 0) - (b.contribution ?? 0));

  // Takroriy to'lovlar = to'lovlar soni × o'rtacha summa
  const renCount = makeNode('renewal.count', "Takroriy to'lovlar soni", 'count', rc.renewalPayments, rp.renewalPayments, 'product');
  const renAvg = makeNode('renewal.avg', "O'rtacha takroriy to'lov", 'money', rc.avgRenewalPayment, rp.avgRenewalPayment, 'product');
  const [cRc, cRa] = productContributions(renewal, [renCount, renAvg]);
  renewal.children.push(attachContribution(renewal, renCount, cRc), attachContribution(renewal, renAvg, cRa));
  renCount.children.push(
    makeNode('renewal.active', 'Faol mijozlar (davr oxirida)', 'count', raw.active.cur, raw.active.prev, 'driver'),
    makeNode('renewal.churn', 'Oylik churn', 'ratio', raw.churn.cur.monthlyChurnRate, raw.churn.prev.monthlyChurnRate, 'driver', 'down'),
    makeNode('renewal.overdue', "Hozir muddati o'tgan to'lovlar", 'count', data.overdue.count, 0, 'driver', 'down', {
      change: null,
      status: data.overdue.count > raw.revenue.cur.renewalPayments * 0.08 ? 'warning' : 'ok',
      note: `${fmtMoney(data.overdue.amount)} undirilmagan`,
    }),
  );
  return root;
}

function addSegmentDrivers(segNode: TreeNode, segment: string, data: DiagnosisData) {
  const { raw } = data.snapshot;
  const rCur = raw.responseBySegment.cur.find((r) => r.key === segment);
  const rPrev = raw.responseBySegment.prev.find((r) => r.key === segment);
  const fCur = raw.funnel.cur.find((f) => f.segment === segment);
  const fPrev = raw.funnel.prev.find((f) => f.segment === segment);
  if (rCur && rPrev && rCur.medianMinutes !== null && rPrev.medianMinutes !== null) {
    segNode.children.push(makeNode(`driver.response_time.${segment}`, 'Birinchi javob vaqti (median)', 'minutes', rCur.medianMinutes, rPrev.medianMinutes, 'driver', 'down'));
  }
  if (rCur && rPrev) {
    segNode.children.push(makeNode(`driver.sla.${segment}`, 'SLA ichida javob ulushi', 'ratio', rCur.withinSlaShare, rPrev.withinSlaShare, 'driver', 'up'));
    const unCur = safeDiv(rCur.leads - rCur.responded, rCur.leads);
    const unPrev = safeDiv(rPrev.leads - rPrev.responded, rPrev.leads);
    segNode.children.push(makeNode(`driver.unanswered.${segment}`, 'Javob berilmagan leadlar ulushi', 'ratio', unCur, unPrev, 'driver', 'down'));
  }
  if (fCur && fPrev) {
    segNode.children.push(makeNode(`driver.trial.${segment}`, 'Sinov darsiga kelish ulushi', 'ratio', fCur.trialRate, fPrev.trialRate, 'driver', 'up'));
  }
  const ev = data.segmentEvidence[segment];
  if (ev) {
    for (const b of ev.buckets) {
      if (b.leads < 5) continue;
      segNode.children.push(
        makeNode(`evidence.bucket.${segment}.${b.ord}`, `Javob ${b.bucket} → konversiya`, 'ratio', b.conversion, b.conversion, 'evidence', 'up', {
          change: null,
          status: 'ok',
          note: `${b.leads} lead, ${b.won} sotuv (so'nggi 90 kun)`,
        }),
      );
    }
  }
}

// ---------------- Root cause (sof funksiya) ----------------

const UPSTREAM_DRIVERS = ['driver.response_time', 'driver.unanswered', 'driver.sla', 'driver.trial'];

function goodOf(node: TreeNode): Good {
  return node.key.startsWith('driver.response_time') || node.key.startsWith('driver.unanswered') || node.key === 'renewal.churn' || node.key === 'renewal.overdue'
    ? 'down'
    : 'up';
}

function adverseChange(node: TreeNode): number {
  if (node.change === null) return 0;
  return goodOf(node) === 'up' ? -node.change : node.change;
}

/** Ota tugundan eng katta salbiy hissali bolaga tushish. */
function descend(start: TreeNode, path: string[]): TreeNode {
  let node = start;
  for (let depth = 0; depth < 8; depth++) {
    const withContribution = node.children.filter((c) => c.contribution !== null && c.relation !== 'evidence' && !c.key.endsWith('.mix'));
    const drivers = node.children.filter((c) => c.relation === 'driver');
    if (withContribution.length) {
      const worst = withContribution.reduce((a, b) => (adverseContribution(b, 'up') > adverseContribution(a, 'up') ? b : a));
      const share = worst.share ?? 0;
      if (adverseContribution(worst, 'up') <= 0 || (share < 0.25 && node.key !== 'funnel.conversion')) break;
      path.push(worst.key);
      node = worst;
      continue;
    }
    // Voronka drayveri (bitta) — ichiga kiramiz
    const funnel = drivers.find((d) => d.key === 'funnel.sales');
    if (funnel) {
      path.push(funnel.key);
      node = funnel;
      continue;
    }
    break;
  }
  return node;
}

function pickMainDriver(segNode: TreeNode): TreeNode | null {
  const drivers = segNode.children.filter((c) => c.relation === 'driver');
  for (const prefix of UPSTREAM_DRIVERS) {
    const d = drivers.find((x) => x.key.startsWith(prefix));
    if (d && adverseChange(d) >= 0.25) return d;
  }
  const worst = drivers.sort((a, b) => adverseChange(b) - adverseChange(a))[0];
  return worst && adverseChange(worst) > 0.1 ? worst : null;
}

function fmtValue(node: TreeNode, v: number): string {
  switch (node.unit) {
    case 'money':
      return fmtMoney(v);
    case 'minutes':
      return fmtMinutes(v);
    case 'ratio':
      return `${round(v * 100, 1)}%`;
    default:
      return String(Math.round(v));
  }
}

export function describeChange(node: TreeNode): string {
  return `${fmtValue(node, node.previous)} → ${fmtValue(node, node.current)}`;
}

export function selectRootCause(tree: TreeNode, data: DiagnosisData): RootCause | null {
  const path: string[] = ['revenue'];
  let end: TreeNode;
  const revChange = tree.change ?? 0;

  if (revChange <= -0.03) {
    end = descend(tree, path);
  } else {
    // Daromad tushmagan — eng yomon o'zgargan asosiy KPI'dan boshlaymiz
    const candidates = ['funnel.conversion', 'funnel.leads', 'renewal.count', 'new.aov']
      .map((k) => findNode(tree, k))
      .filter((n): n is TreeNode => !!n && adverseChange(n) >= 0.08)
      .sort((a, b) => adverseChange(b) - adverseChange(a));
    if (!candidates.length) return null;
    const start = candidates[0];
    path.push(...pathTo(tree, start.key).slice(1));
    end = descend(start, path);
  }

  let segment: string | null = null;
  let main: TreeNode | null = null;
  if (end.key.startsWith('funnel.conversion.')) {
    segment = end.key.slice('funnel.conversion.'.length);
    main = pickMainDriver(end);
    if (main) path.push(main.key);
  }

  const evidence: string[] = [];
  const conv = findNode(tree, 'funnel.conversion');
  const leads = findNode(tree, 'funnel.leads');
  let headline: string;
  let mainFactor: string;
  let confidence = 0.5;

  if (segment) {
    const segNode = end;
    headline = `${segment} sotuv konversiyasi ${fmtPct(segNode.change)}`;
    mainFactor = main ? `${main.label}: ${describeChange(main)}` : `${segment} konversiyasi: ${describeChange(segNode)}`;
    const ev = data.segmentEvidence[segment];
    if (ev) {
      const fast = ev.buckets.find((b) => b.ord === 1);
      const slow = ev.buckets.filter((b) => b.ord >= 2 && b.ord <= 4 && b.leads >= 5);
      const none = ev.buckets.find((b) => b.ord === 5);
      if (fast && slow.length) {
        const slowConv = safeDiv(slow.reduce((a, b) => a + b.won, 0), slow.reduce((a, b) => a + b.leads, 0));
        evidence.push(
          `${segment}: 15 daqiqa ichida javob berilgan leadlar ${round(fast.conversion * 100, 1)}% konvert bo'ladi, kechroq javob berilganlar — ${round(slowConv * 100, 1)}%${none && none.leads >= 5 ? `, javobsizlar — ${round(none.conversion * 100, 1)}%` : ''}.`,
        );
        if (fast.conversion > slowConv * 1.4) confidence += 0.15;
      }
      const top = [...ev.managers].sort((a, b) => b.leads - a.leads)[0];
      const totalLeads = ev.managers.reduce((a, m) => a + m.leads, 0);
      if (top && totalLeads > 0 && top.leads / totalLeads > 0.5) {
        evidence.push(
          `${top.name} ${segment} leadlarining ${Math.round((top.leads / totalLeads) * 100)}% ini oladi; uning median javob vaqti ${fmtMinutes(top.median_minutes)}, hozir ${top.open_unanswered} ta lead javobsiz.`,
        );
        confidence += 0.1;
      }
    }
    if (main && adverseChange(main) >= 0.5) confidence += 0.1;
  } else {
    headline = `${end.label} ${fmtPct(end.change)}`;
    mainFactor = `${end.label}: ${describeChange(end)}`;
  }
  if (leads && Math.abs(leads.change ?? 0) < 0.08) {
    evidence.push(`Leadlar soni barqaror (${describeChange(leads)}) — muammo marketingda emas.`);
    confidence += 0.05;
  }
  const newRev = findNode(tree, 'revenue.new');
  if (revChange <= -0.03 && newRev?.share) {
    evidence.push(`Daromad pasayishining ${Math.round(newRev.share * 100)}% i yangi mijozlar daromadidan.`);
  }

  // Tushuntirish matni
  const parts: string[] = [];
  if (revChange <= -0.03) parts.push(`Daromad ${fmtPct(tree.change)} o'zgardi (${describeChange(tree)}).`);
  if (leads && conv && segment) {
    parts.push(
      `Asosiy sabab marketing lead hajmi emas (leadlar ${fmtPct(leads.change)}), balki lead → sotuv konversiyasi pasaygani (${describeChange(conv)}).`,
    );
    parts.push(`Eng katta pasayish ${segment} segmentida: ${describeChange(end)}.`);
    if (main) parts.push(`${segment} leadlarida ${main.label.toLowerCase()} ${describeChange(main)} ga o'zgargan.`);
  } else {
    parts.push(`Eng katta salbiy o'zgarish: ${end.label} (${describeChange(end)}).`);
  }
  markPath(tree, path);
  return {
    headline,
    mainFactor,
    explanation: parts.join(' '),
    path,
    segment,
    evidence,
    confidence: Math.min(0.95, round(confidence, 2)),
  };
}

function pathTo(root: TreeNode, key: string, acc: string[] = []): string[] {
  const next = [...acc, root.key];
  if (root.key === key) return next;
  for (const c of root.children) {
    const p = pathTo(c, key, next);
    if (p.length && p[p.length - 1] === key) return p;
  }
  return [];
}

// ---------------- Ustuvorliklar va tavsiyalar ----------------

/** Root cause bilan bog'liq muammolar birinchi; keyin jiddiylik va pul ta'siri. */
export function buildPriorities(findings: Finding[], rootCause?: RootCause | null): Priority[] {
  const weight = { critical: 3, warning: 2, info: 1 } as const;
  const responseIssue = rootCause?.path.some((k) => /^driver\.(response_time|unanswered|sla)/.test(k));
  const related = (f: Finding) =>
    (responseIssue && (f.detector === 'lead_unanswered' || f.detector === 'response_time_sla')) ||
    (rootCause?.path.includes('revenue.renewal') && (f.detector === 'payment_overdue' || f.detector === 'churn_risk'));
  // Kechikkan to'lov summasi — undiriladigan pul, yo'qotish emas: ta'sirini kamroq baholaymiz
  const score = (f: Finding) => f.impact * (f.detector === 'payment_overdue' ? 0.25 : 1);
  return [...findings]
    .sort((a, b) => Number(related(b)) - Number(related(a)) || weight[b.severity] - weight[a.severity] || score(b) - score(a))
    .slice(0, 6)
    .map((f, i) => ({
      rank: i + 1,
      title: f.title,
      detail: f.summary ?? '',
      severity: f.severity,
      detector: f.detector,
      findingId: f.id,
      impact: f.impact,
    }));
}

export async function buildRecommendations(
  ctx: BrainContext,
  rootCause: RootCause | null,
  findings: Finding[],
  stats?: LearningStat[],
): Promise<Recommendation[]> {
  const learned = stats ?? (await learningStats(ctx.db, ctx.businessId));
  const recs: Array<Omit<Recommendation, 'risk' | 'confidence'> & { baseConfidence: number }> = [];
  const byDetector = (d: string) => findings.filter((f) => f.detector === d);

  const unanswered = byDetector('lead_unanswered')[0];
  const responseIssue = rootCause?.path.some((k) => k.startsWith('driver.response_time') || k.startsWith('driver.unanswered') || k.startsWith('driver.sla'));
  if (unanswered && (unanswered.entityIds.length >= 3 || responseIssue)) {
    const m = unanswered.metrics as any;
    const overloaded = (m.byManager ?? []).filter((x: any) => x.id && x.count / unanswered.entityIds.length > 0.4).map((x: any) => x.id);
    recs.push({
      title: `${unanswered.entityIds.length} ta javobsiz leadni qayta taqsimlash`,
      actionType: 'reassign_leads',
      params: { leadIds: unanswered.entityIds, ...(overloaded.length ? { excludeEmployeeIds: overloaded } : {}) },
      rationale: responseIssue && rootCause ? `${rootCause.mainFactor}. ${unanswered.summary ?? ''}` : unanswered.summary ?? '',
      expectedImpact: `~${round(m.estimatedLostSales ?? 0, 0)} ta sotuvni qutqarish (${fmtMoney(unanswered.impact)})`,
      baseConfidence: 0.75,
    });
  }
  if (responseIssue && rootCause?.segment) {
    const ev = rootCause.evidence.find((e) => e.includes('leadlarining'));
    recs.push({
      title: `${rootCause.segment} lead taqsimotini muvozanatlash va ${ctx.business.settings.responseSlaMinutes} daqiqalik SLA'ni nazoratga olish`,
      actionType: 'create_task',
      params: {
        title: `${rootCause.segment} leadlari taqsimotini qayta ko'rib chiqish`,
        description: `${rootCause.explanation}\n\n${ev ?? ''}\n\nTavsiya: ${rootCause.segment} leadlarini kamida 2 menejer o'rtasida teng taqsimlang, ${ctx.business.settings.responseSlaMinutes} daqiqalik javob standartini joriy qiling.`,
        priority: 'high',
        dueInHours: 24,
        assigneeId: (await ctx.db.one<{ id: string }>(`SELECT id FROM employees WHERE business_id = $1 AND role = 'owner' LIMIT 1`, [ctx.businessId]))?.id,
      },
      rationale: rootCause.explanation,
      expectedImpact: `${rootCause.segment} konversiyasini oldingi darajaga qaytarish`,
      baseConfidence: 0.65,
    });
  }

  const churn = byDetector('churn_risk')[0];
  if (churn) {
    recs.push({
      title: `${churn.entityIds.length} ta churn xavfidagi mijoz bilan bog'lanish`,
      actionType: 'retention_outreach',
      params: { customerIds: churn.entityIds.slice(0, 40) },
      rationale: churn.summary ?? '',
      expectedImpact: `${fmtMoney(churn.impact)} kutilayotgan yo'qotishni kamaytirish`,
      baseConfidence: 0.6,
    });
  }

  // Sotuv sababli CAC o'sishi root cause bilan hal qilinadi; marketing sababli — byudjet/kreativ bilan
  const cacFindings = byDetector('cac_above_target').filter((f) => (f.metrics as any).cause !== 'sales');
  for (const cac of cacFindings.sort((a, b) => b.impact - a.impact).slice(0, 2)) {
    const m = cac.metrics as any;
    if ((m.change ?? 0) > 0.2 && (m.cplChange ?? 0) > 0.15 && m.dailyBudget) {
      // Qaror tarixi: shu kampaniya byudjeti yaqinda o'zgartirilganmi va natijasi qanday bo'lgan?
      const past = await ctx.db.one<{ executed_at: Date; params: any; verdict: string | null }>(
        `SELECT a.executed_at, a.params, o.verdict FROM actions a LEFT JOIN outcomes o ON o.action_id = a.id
          WHERE a.business_id = $1 AND a.type = 'change_campaign_budget' AND a.status = 'executed' AND a.params->>'campaignId' = $2
          ORDER BY a.executed_at DESC LIMIT 1`,
        [ctx.businessId, m.campaignId],
      );
      const raised = past && past.params?.previousDailyBudget && past.params.newDailyBudget > past.params.previousDailyBudget;
      const target = raised ? past!.params.previousDailyBudget : m.dailyBudget * 0.77;
      const newBudget = Math.round(target / 1000) * 1000;
      const history = past
        ? ` Qaror tarixi: ${Math.round((ctx.at.getTime() - new Date(past.executed_at).getTime()) / 86_400_000)} kun oldin byudjet ${fmtMoney(past.params.previousDailyBudget ?? 0)} → ${fmtMoney(past.params.newDailyBudget ?? 0)} ga o'zgartirilgan${past.verdict === 'worsened' ? ' — natija salbiy bo\'lgan (CAC oshgan)' : ''}.`
        : '';
      recs.push({
        title: `${m.name}: byudjetni ${fmtMoney(m.dailyBudget)} → ${fmtMoney(newBudget)} ga ${raised ? 'qaytarish' : 'kamaytirish'}`,
        actionType: 'change_campaign_budget',
        params: { campaignId: m.campaignId, newDailyBudget: newBudget, reason: `CAC ${fmtPct(m.change)} oshgan` },
        rationale: `${cac.title}. ${cac.summary ?? ''}${history}`,
        expectedImpact: `CAC'ni ${m.target ? fmtMoney(m.target) : 'maqsad'} atrofiga qaytarish, oyiga ~${fmtMoney(m.dailyBudget * 0.23 * 30)} tejash`,
        baseConfidence: 0.55,
      });
    } else {
      recs.push({
        title: `${m.name} kampaniyasini tahlil qilish`,
        actionType: 'analyze_campaign',
        params: { campaignId: m.campaignId },
        rationale: cac.summary ?? cac.title,
        expectedImpact: "CAC oshish sababini aniqlash (CPL, lead sifati, auditoriya)",
        baseConfidence: 0.7,
      });
    }
  }

  const overdue = byDetector('payment_overdue')[0];
  if (overdue) {
    recs.push({
      title: `${overdue.entityIds.length} ta kechikkan to'lov bo'yicha eslatma`,
      actionType: 'send_payment_reminder',
      params: { paymentIds: overdue.entityIds.slice(0, 60) },
      rationale: overdue.title,
      expectedImpact: `${fmtMoney(overdue.impact * 0.5)} gacha undirish`,
      baseConfidence: 0.6,
    });
  }

  for (const cap of byDetector('group_capacity').slice(0, 1)) {
    const m = cap.metrics as any;
    if (m.alternativeGroupId && m.segment) {
      recs.push({
        title: `${m.segment} yangi talabalarini bo'sh guruhga yo'naltirish`,
        actionType: 'route_leads',
        params: { segment: m.segment, fromGroupId: m.groupId, toGroupId: m.alternativeGroupId },
        rationale: `${cap.title}. ${cap.summary ?? ''}`,
        expectedImpact: "Guruhlar sig'imini muvozanatlash, maksimal guruh hajmi cheklovini saqlash",
        baseConfidence: 0.7,
      });
    }
  }

  const out: Recommendation[] = [];
  for (const r of recs) {
    const risk = await assessRisk({ db: ctx.db, businessId: ctx.businessId, settings: ctx.business.settings }, r.actionType, r.params);
    const { baseConfidence, ...rest } = r;
    out.push({ ...rest, risk, confidence: confidenceFrom(learned, r.actionType, baseConfidence) });
  }
  return out;
}

export interface DiagnosisDraft {
  windowDays: number;
  periodStart: Date;
  periodEnd: Date;
  kpis: Kpi[];
  tree: TreeNode;
  rootCause: RootCause | null;
  priorities: Priority[];
  recommendations: Recommendation[];
  data: DiagnosisData;
}

export async function computeDiagnosis(ctx: BrainContext, findings: Finding[], windowDays?: number): Promise<DiagnosisDraft> {
  const data = await gatherDiagnosisData(ctx, windowDays);
  const tree = buildRevenueTree(data);
  const rootCause = selectRootCause(tree, data);
  const priorities = buildPriorities(findings, rootCause);
  const recommendations = await buildRecommendations(ctx, rootCause, findings);
  return {
    windowDays: data.snapshot.windowDays,
    periodStart: data.snapshot.current.start,
    periodEnd: data.snapshot.current.end,
    kpis: data.snapshot.kpis,
    tree,
    rootCause,
    priorities,
    recommendations,
    data,
  };
}

/** AI o'chiq bo'lsa ham tushunarli bo'ladigan shablon matn. */
export function engineNarrative(d: Pick<DiagnosisDraft, 'kpis' | 'rootCause' | 'priorities' | 'recommendations' | 'windowDays'>): string {
  const k = (key: string) => d.kpis.find((x) => x.key === key);
  const lines: string[] = [];
  const kpiLine = ['revenue', 'leads', 'conversion_rate', 'cac']
    .map((key) => k(key))
    .filter((x): x is Kpi => !!x && x.change !== null)
    .map((x) => `${x.label} ${fmtPct(x.change)}`)
    .join(', ');
  lines.push(`So'nggi ${d.windowDays} kun (oldingi ${d.windowDays} kunga nisbatan): ${kpiLine}.`);
  if (d.rootCause) {
    lines.push('', `Asosiy muammo: ${d.rootCause.headline}.`, `Asosiy omil: ${d.rootCause.mainFactor}.`, d.rootCause.explanation);
    for (const e of d.rootCause.evidence) lines.push(`• ${e}`);
  } else {
    lines.push('', "Jiddiy salbiy o'zgarish aniqlanmadi.");
  }
  if (d.recommendations.length) {
    lines.push('', 'Tavsiya etilgan harakatlar:');
    d.recommendations.slice(0, 4).forEach((r, i) => lines.push(`${i + 1}. ${r.title} (${actionLabel(r.actionType)}, xavf: ${r.risk})`));
  }
  return lines.join('\n');
}
