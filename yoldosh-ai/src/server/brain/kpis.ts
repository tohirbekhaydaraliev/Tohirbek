import type { Kpi } from '../../shared/types';
import * as q from '../metrics/queries';
import { comparisonRanges, pctChange, type DateRange } from '../lib/util';
import { targetFor, type BrainContext } from './context';

/** Diagnostika va bosh sahifa uchun asosiy KPI'lar (joriy davr vs oldingi davr). */
export interface KpiSnapshot {
  windowDays: number;
  current: DateRange;
  previous: DateRange;
  kpis: Kpi[];
  raw: {
    revenue: { cur: q.RevenueSummary; prev: q.RevenueSummary };
    funnel: { cur: q.FunnelRow[]; prev: q.FunnelRow[] };
    marketing: { cur: Awaited<ReturnType<typeof q.marketingTotals>>; prev: Awaited<ReturnType<typeof q.marketingTotals>> };
    response: { cur: q.ResponseRow[]; prev: q.ResponseRow[] };
    responseBySegment: { cur: q.ResponseRow[]; prev: q.ResponseRow[] };
    active: { cur: number; prev: number };
    churn: { cur: Awaited<ReturnType<typeof q.churnStats>>; prev: Awaited<ReturnType<typeof q.churnStats>> };
    attendance: { cur: number | null; prev: number | null };
  };
}

function kpiStatus(change: number | null, good: 'up' | 'down', tolerance = 0.03): Kpi['status'] {
  if (change === null) return 'neutral';
  if (Math.abs(change) < tolerance) return 'neutral';
  const better = good === 'up' ? change > 0 : change < 0;
  return better ? 'good' : 'bad';
}

function makeKpi(
  ctx: BrainContext,
  key: string,
  label: string,
  unit: Kpi['unit'],
  current: number | null,
  previous: number | null,
  good: 'up' | 'down',
  targetMetric?: string,
  series?: number[],
): Kpi {
  const change = current === null || previous === null ? null : pctChange(current, previous);
  const t = targetMetric ? targetFor(ctx, targetMetric) : null;
  return {
    key,
    label,
    unit,
    current,
    previous,
    change,
    goodDirection: good,
    status: kpiStatus(change, good),
    target: t?.target ?? null,
    targetComparator: t?.comparator,
    series,
  };
}

export async function kpiSnapshot(ctx: BrainContext, windowDays?: number): Promise<KpiSnapshot> {
  const days = windowDays ?? ctx.business.settings.diagnosisWindowDays;
  const { current, previous } = comparisonRanges(days, ctx.at);
  const { db, businessId } = ctx;
  const sla = ctx.business.settings.responseSlaMinutes;
  const tz = ctx.business.timezone;

  const [revCur, revPrev, fCur, fPrev, mCur, mPrev, rCur, rPrev, rsCur, rsPrev, aCur, aPrev, cCur, cPrev, attCur, attPrev] =
    await Promise.all([
      q.revenueSummary(db, businessId, current),
      q.revenueSummary(db, businessId, previous),
      q.funnelBySegment(db, businessId, current),
      q.funnelBySegment(db, businessId, previous),
      q.marketingTotals(db, businessId, current),
      q.marketingTotals(db, businessId, previous),
      q.responseTimes(db, businessId, current, 'total', sla),
      q.responseTimes(db, businessId, previous, 'total', sla),
      q.responseTimes(db, businessId, current, 'segment', sla),
      q.responseTimes(db, businessId, previous, 'segment', sla),
      q.activeCustomers(db, businessId, current.end),
      q.activeCustomers(db, businessId, previous.end),
      q.churnStats(db, businessId, current),
      q.churnStats(db, businessId, previous),
      q.attendanceRate(db, businessId, current),
      q.attendanceRate(db, businessId, previous),
    ]);

  const seriesRange = current;
  const [sRevenue, sLeads, sWon, sSpend] = await Promise.all([
    q.dailySeries(db, businessId, 'revenue', seriesRange, tz),
    q.dailySeries(db, businessId, 'leads', seriesRange, tz),
    q.dailySeries(db, businessId, 'won', seriesRange, tz),
    q.dailySeries(db, businessId, 'spend', seriesRange, tz),
  ]);

  const tCur = q.totalFunnel(fCur);
  const tPrev = q.totalFunnel(fPrev);
  // Oylik daromadga keltirish (maqsad bilan solishtirish uchun)
  const monthFactor = 30 / days;

  const kpis: Kpi[] = [
    makeKpi(ctx, 'revenue', 'Daromad', 'money', revCur.total, revPrev.total, 'up', undefined, sRevenue.map((s) => s.value)),
    makeKpi(ctx, 'new_revenue', 'Yangi mijozlar daromadi', 'money', revCur.newRevenue, revPrev.newRevenue, 'up'),
    makeKpi(ctx, 'leads', 'Yangi leadlar', 'count', tCur.leads, tPrev.leads, 'up', undefined, sLeads.map((s) => s.value)),
    makeKpi(ctx, 'sales', 'Sotuvlar', 'count', tCur.won, tPrev.won, 'up', undefined, sWon.map((s) => s.value)),
    makeKpi(ctx, 'conversion_rate', 'Konversiya (lead → sotuv)', 'ratio', tCur.conversion, tPrev.conversion, 'up', 'conversion_rate'),
    makeKpi(ctx, 'cac', 'CAC', 'money', mCur.cac, mPrev.cac, 'down', 'cac', sSpend.map((s) => s.value)),
    makeKpi(ctx, 'response_time_minutes', 'Birinchi javob (median)', 'minutes', rCur[0]?.medianMinutes ?? null, rPrev[0]?.medianMinutes ?? null, 'down', 'response_time_minutes'),
    makeKpi(ctx, 'active_customers', 'Faol mijozlar', 'count', aCur, aPrev, 'up', 'active_customers'),
    makeKpi(ctx, 'churn_rate', 'Oylik churn', 'ratio', cCur.monthlyChurnRate, cPrev.monthlyChurnRate, 'down', 'churn_rate'),
    makeKpi(ctx, 'attendance_rate', 'Davomat', 'ratio', attCur, attPrev, 'up', 'attendance_rate'),
    makeKpi(ctx, 'ad_spend', 'Reklama xarajati', 'money', mCur.spend, mPrev.spend, 'down'),
  ];
  // Daromad maqsadi oylik — davr uzunligiga moslab ko'rsatamiz
  const revTarget = targetFor(ctx, 'revenue');
  if (revTarget) {
    kpis[0].target = revTarget.target / monthFactor;
    kpis[0].targetComparator = revTarget.comparator;
  }

  return {
    windowDays: days,
    current,
    previous,
    kpis,
    raw: {
      revenue: { cur: revCur, prev: revPrev },
      funnel: { cur: fCur, prev: fPrev },
      marketing: { cur: mCur, prev: mPrev },
      response: { cur: rCur, prev: rPrev },
      responseBySegment: { cur: rsCur, prev: rsPrev },
      active: { cur: aCur, prev: aPrev },
      churn: { cur: cCur, prev: cPrev },
      attendance: { cur: attCur, prev: attPrev },
    },
  };
}
