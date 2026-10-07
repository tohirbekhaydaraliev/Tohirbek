import { z } from 'zod';
import type { Db } from '../db';
import type { ActionView } from '../../shared/types';
import { listActions } from '../actions/service';
import { loadBrainContext, type BrainContext } from '../brain/context';
import { getCustomer360, searchCustomers } from '../brain/customer360';
import { listFindings } from '../brain/detectors';
import { kpiSnapshot } from '../brain/kpis';
import { scoreChurn, scoreOpenLeads } from '../brain/scoring';
import { listRules } from '../context/rules';
import { decisionHistory, learningStats } from '../feedback/outcomes';
import * as q from '../metrics/queries';
import { comparisonRanges, pctChange, round } from '../lib/util';
import type { AgentTool } from './llm';

/**
 * Agentlar uchun domen toollari (faqat o'qish). Yagona data model va metrikalar
 * qatlamidan foydalanadi — AI hech qachon xom SQL yozmaydi.
 */

export interface ToolEnv {
  db: Db;
  businessId: string;
  onAction?: (a: ActionView) => void;
}

const days = z.number().int().min(1).max(365).default(30).describe("Tahlil oynasi (kun); oldingi teng davr bilan solishtiriladi");

function tool<S extends z.ZodType>(t: { name: string; description: string; inputSchema: S; label: (i: z.infer<S>) => string; run: (i: z.infer<S>) => Promise<unknown> }): AgentTool<z.infer<S>> {
  return t as AgentTool<z.infer<S>>;
}

async function ctxOf(env: ToolEnv): Promise<BrainContext> {
  return loadBrainContext(env.db, env.businessId);
}

const r2 = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? null : round(n, d));

// ---------------- Umumiy ----------------

export function commonTools(env: ToolEnv): AgentTool[] {
  return [
    tool({
      name: 'get_business_context',
      description: "Biznes profili: strategiya, ustuvorliklar, maqsadlar/KPI chegaralari, biznes qoidalari va avtonomiya sozlamalari.",
      inputSchema: z.object({}),
      label: () => 'Biznes kontekstini o‘qish',
      run: async () => {
        const ctx = await ctxOf(env);
        const rules = await listRules(env.db, env.businessId);
        return {
          name: ctx.business.name,
          vertical: ctx.business.vertical,
          currency: ctx.business.currency,
          strategy: ctx.business.strategy,
          priorities: ctx.business.priorities,
          targets: ctx.targets.map((t) => ({ kind: t.kind, metric: t.metric, label: t.label, target: t.target, comparator: t.comparator, segment: t.segment })),
          rules: rules.map((r) => ({ name: r.name, enabled: r.enabled, detector: r.detector, params: r.params, action: r.action_type })),
          settings: {
            responseSlaMinutes: ctx.business.settings.responseSlaMinutes,
            churnThreshold: ctx.business.settings.churnThreshold,
            autonomy: ctx.business.settings.autonomy,
          },
          today: ctx.at.toISOString(),
        };
      },
    }),
    tool({
      name: 'get_kpi_summary',
      description: "Asosiy KPI'lar (daromad, leadlar, sotuvlar, konversiya, CAC, javob vaqti, faol mijozlar, churn, davomat) — joriy davr vs oldingi davr va maqsadlar.",
      inputSchema: z.object({ days }),
      label: (i) => `KPI'lar (${i.days} kun)`,
      run: async (i) => {
        const snap = await kpiSnapshot(await ctxOf(env), i.days);
        return {
          windowDays: snap.windowDays,
          kpis: snap.kpis.map((k) => ({ key: k.key, label: k.label, unit: k.unit, current: r2(k.current), previous: r2(k.previous), change: r2(k.change, 3), target: k.target ?? null })),
        };
      },
    }),
    tool({
      name: 'get_decision_history',
      description: "Oldingi qarorlar va ularning natijalari (Decision → Action → Outcome). Shunga o'xshash harakat avval ishlaganmi — bilish uchun.",
      inputSchema: z.object({ action_type: z.string().optional(), limit: z.number().int().min(1).max(50).default(15) }),
      label: () => 'Qarorlar tarixi',
      run: async (i) => ({
        history: (await decisionHistory(env.db, env.businessId, { type: i.action_type, limit: i.limit })).map((h) => ({
          date: h.createdAt.slice(0, 10),
          type: h.type,
          title: h.title,
          status: h.status,
          rationale: h.rationale,
          result: h.resultSummary,
          outcome: h.outcome ? { metric: h.outcome.label, baseline: r2(h.outcome.baseline), observed: r2(h.outcome.observed), verdict: h.outcome.verdict } : null,
        })),
        stats: (await learningStats(env.db, env.businessId)).map((s) => ({ type: s.type, executed: s.executed, evaluated: s.evaluated, improved: s.improved, worsened: s.worsened })),
      }),
    }),
  ];
}

// ---------------- Marketing ----------------

export function marketingTools(env: ToolEnv): AgentTool[] {
  return [
    tool({
      name: 'get_campaign_performance',
      description: "Har bir reklama kampaniyasi: xarajat, ko'rishlar, kliklar, leadlar, sotuvlar, daromad, CPL, CAC, ROAS — joriy va oldingi davr.",
      inputSchema: z.object({ days }),
      label: (i) => `Kampaniyalar samaradorligi (${i.days} kun)`,
      run: async (i) => {
        const { current, previous } = comparisonRanges(i.days);
        const [cur, prev] = await Promise.all([q.campaignPerformance(env.db, env.businessId, current), q.campaignPerformance(env.db, env.businessId, previous)]);
        return cur.map((c) => {
          const p = prev.find((x) => x.campaign_id === c.campaign_id);
          return {
            id: c.campaign_id,
            name: c.name,
            source: c.source,
            segment: c.segment,
            status: c.status,
            dailyBudget: c.daily_budget,
            spend: c.spend,
            leads: c.platform_leads || c.crm_leads,
            won: c.won,
            revenue: c.revenue,
            cpl: Math.round(c.cpl),
            cac: c.cac === null ? null : Math.round(c.cac),
            roas: r2(c.roas),
            prev: p ? { spend: p.spend, leads: p.platform_leads || p.crm_leads, won: p.won, cpl: Math.round(p.cpl), cac: p.cac === null ? null : Math.round(p.cac) } : null,
            cacChange: p?.cac && c.cac ? r2(pctChange(c.cac, p.cac), 3) : null,
          };
        });
      },
    }),
    tool({
      name: 'get_marketing_totals',
      description: 'Umumiy reklama xarajati, platforma leadlari, pullik kanallardan sotuvlar va blended CAC (joriy vs oldingi davr).',
      inputSchema: z.object({ days }),
      label: () => 'Marketing jami',
      run: async (i) => {
        const { current, previous } = comparisonRanges(i.days);
        const [cur, prev] = await Promise.all([q.marketingTotals(env.db, env.businessId, current), q.marketingTotals(env.db, env.businessId, previous)]);
        return { current: cur, previous: prev };
      },
    }),
  ];
}

// ---------------- Sotuv ----------------

export function salesTools(env: ToolEnv): AgentTool[] {
  return [
    tool({
      name: 'get_sales_funnel',
      description: "Segmentlar bo'yicha voronka: leadlar, javob berilgan, sinov darsi, sotuv, konversiya — joriy va oldingi davr.",
      inputSchema: z.object({ days }),
      label: (i) => `Sotuv voronkasi (${i.days} kun)`,
      run: async (i) => {
        const { current, previous } = comparisonRanges(i.days);
        const [cur, prev] = await Promise.all([q.funnelBySegment(env.db, env.businessId, current), q.funnelBySegment(env.db, env.businessId, previous)]);
        const fmt = (r: q.FunnelRow) => ({ ...r, conversion: r2(r.conversion, 3), trialRate: r2(r.trialRate, 3) });
        return { current: [...cur.map(fmt), fmt(q.totalFunnel(cur))], previous: [...prev.map(fmt), fmt(q.totalFunnel(prev))] };
      },
    }),
    tool({
      name: 'get_response_times',
      description: "Leadga birinchi javob vaqti (median, p90, SLA ichidagi ulush) — segment yoki menejer bo'yicha, joriy va oldingi davr.",
      inputSchema: z.object({ days, group_by: z.enum(['segment', 'manager']).default('segment') }),
      label: (i) => `Javob vaqti (${i.group_by === 'manager' ? 'menejerlar' : 'segmentlar'})`,
      run: async (i) => {
        const ctx = await ctxOf(env);
        const sla = ctx.business.settings.responseSlaMinutes;
        const { current, previous } = comparisonRanges(i.days);
        const [cur, prev] = await Promise.all([
          q.responseTimes(env.db, env.businessId, current, i.group_by, sla),
          q.responseTimes(env.db, env.businessId, previous, i.group_by, sla),
        ]);
        return {
          slaMinutes: sla,
          rows: cur.map((c) => {
            const p = prev.find((x) => x.key === c.key);
            return { name: c.label, leads: c.leads, responded: c.responded, medianMinutes: r2(c.medianMinutes, 1), p90Minutes: r2(c.p90Minutes, 1), withinSla: r2(c.withinSlaShare, 3), prevMedianMinutes: r2(p?.medianMinutes, 1), prevWithinSla: r2(p?.withinSlaShare, 3) };
          }),
        };
      },
    }),
    tool({
      name: 'get_unanswered_leads',
      description: "Hozir N soatdan ortiq javobsiz turgan leadlar: soni, menejer va segment bo'yicha, ro'yxat (ID'lar bilan — harakat taklif qilish uchun).",
      inputSchema: z.object({ hours: z.number().min(0.25).max(240).default(2) }),
      label: (i) => `Javobsiz leadlar (${i.hours}+ soat)`,
      run: async (i) => {
        const rows = await q.unansweredLeads(env.db, env.businessId, i.hours, new Date());
        const by = (k: (r: q.UnansweredLead) => string) => rows.reduce<Record<string, number>>((m, r) => ((m[k(r)] = (m[k(r)] ?? 0) + 1), m), {});
        return {
          count: rows.length,
          byManager: by((r) => r.manager_name ?? 'Biriktirilmagan'),
          bySegment: by((r) => r.segment ?? 'Boshqa'),
          leadIds: rows.map((r) => r.id),
          managerIds: [...new Set(rows.map((r) => `${r.manager_name}: ${r.assigned_to}`))],
          sample: rows.slice(0, 12).map((r) => ({ id: r.id, name: r.customer_name, segment: r.segment, manager: r.manager_name, waitingHours: r2(r.waiting_minutes / 60, 1), campaign: r.campaign_name })),
        };
      },
    }),
    tool({
      name: 'get_manager_performance',
      description: "Sotuv menejerlari: leadlar, javob berilgan, median javob vaqti, sotuvlar, konversiya, hozir javobsiz leadlar va ochiq vazifalar.",
      inputSchema: z.object({ days, segment: z.string().optional() }),
      label: (i) => `Menejerlar samaradorligi${i.segment ? ` (${i.segment})` : ''}`,
      run: async (i) => {
        const { current, previous } = comparisonRanges(i.days);
        const [cur, prev] = await Promise.all([q.managerPerformance(env.db, env.businessId, current, i.segment), q.managerPerformance(env.db, env.businessId, previous, i.segment)]);
        return cur.map((m) => {
          const p = prev.find((x) => x.employee_id === m.employee_id);
          return { id: m.employee_id, name: m.name, leads: m.leads, won: m.won, conversion: r2(m.conversion, 3), medianMinutes: r2(m.median_minutes, 1), openUnanswered: m.open_unanswered, openTasks: m.open_tasks, prev: p ? { leads: p.leads, won: p.won, conversion: r2(p.conversion, 3), medianMinutes: r2(p.median_minutes, 1) } : null };
        });
      },
    }),
    tool({
      name: 'get_conversion_by_response_speed',
      description: "Sababiy dalil: birinchi javob tezligi bo'yicha lead → sotuv konversiyasi (so'nggi 90 kun, yetilgan leadlar).",
      inputSchema: z.object({ segment: z.string().optional() }),
      label: (i) => `Javob tezligi va konversiya${i.segment ? ` (${i.segment})` : ''}`,
      run: async (i) => (await q.conversionByResponseBucket(env.db, env.businessId, new Date(), { segment: i.segment })).map((b) => ({ bucket: b.bucket, leads: b.leads, won: b.won, conversion: r2(b.conversion, 3) })),
    }),
    tool({
      name: 'get_hot_leads',
      description: 'Hozir birinchi ishlash kerak bo‘lgan ochiq leadlar (skor, sabab bilan).',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(15) }),
      label: () => 'Issiq leadlar',
      run: async (i) => (await scoreOpenLeads(await ctxOf(env), i.limit)).map((l) => ({ id: l.leadId, name: l.name, segment: l.segment, status: l.status, manager: l.manager, score: l.score, label: l.label, reason: l.reason })),
    }),
  ];
}

// ---------------- Moliya ----------------

export function financeTools(env: ToolEnv): AgentTool[] {
  return [
    tool({
      name: 'get_revenue_breakdown',
      description: "Daromad: jami, yangi mijozlar vs takroriy to'lovlar, segmentlar bo'yicha, to'lovlar soni va o'rtacha chek — joriy va oldingi davr.",
      inputSchema: z.object({ days }),
      label: (i) => `Daromad tarkibi (${i.days} kun)`,
      run: async (i) => {
        const { current, previous } = comparisonRanges(i.days);
        const [rc, rp, sc, sp] = await Promise.all([
          q.revenueSummary(env.db, env.businessId, current),
          q.revenueSummary(env.db, env.businessId, previous),
          q.revenueBySegment(env.db, env.businessId, current),
          q.revenueBySegment(env.db, env.businessId, previous),
        ]);
        return { current: rc, previous: rp, change: r2(pctChange(rc.total, rp.total), 3), bySegmentCurrent: sc, bySegmentPrevious: sp };
      },
    }),
    tool({
      name: 'get_overdue_payments',
      description: "Muddati o'tgan to'lanmagan to'lovlar: soni, summasi, ro'yxat (ID'lar bilan).",
      inputSchema: z.object({ min_days: z.number().int().min(0).max(120).default(3) }),
      label: () => "Kechikkan to'lovlar",
      run: async (i) => {
        const rows = await q.overduePayments(env.db, env.businessId, new Date(), i.min_days);
        return {
          count: rows.length,
          total: rows.reduce((a, r) => a + r.amount, 0),
          paymentIds: rows.map((r) => r.id),
          sample: rows.slice(0, 12).map((r) => ({ id: r.id, customer: r.customer_name, amount: r.amount, daysOverdue: r.days_overdue, hasTelegram: !!r.telegram_chat_id })),
        };
      },
    }),
    tool({
      name: 'get_unit_economics',
      description: "Unit-ekonomika: CAC, o'rtacha oylik chek, o'rtacha qolish muddati (oy), LTV, LTV/CAC, reklama xarajati.",
      inputSchema: z.object({ days }),
      label: () => 'Unit-ekonomika',
      run: async (i) => {
        const { current } = comparisonRanges(i.days);
        const [mk, price, tenure, churn] = await Promise.all([
          q.marketingTotals(env.db, env.businessId, current),
          q.avgMonthlyPrice(env.db, env.businessId),
          q.avgTenureMonths(env.db, env.businessId, new Date()),
          q.churnStats(env.db, env.businessId, current),
        ]);
        const expectedTenure = churn.monthlyChurnRate > 0 ? 1 / churn.monthlyChurnRate : tenure;
        const ltv = price * (expectedTenure ?? 0);
        return { cac: r2(mk.cac, 0), adSpend: mk.spend, avgMonthlyPrice: Math.round(price), avgTenureMonthsEnded: r2(tenure, 1), monthlyChurn: r2(churn.monthlyChurnRate, 3), expectedTenureMonths: r2(expectedTenure, 1), ltv: Math.round(ltv), ltvToCac: mk.cac ? r2(ltv / mk.cac, 1) : null };
      },
    }),
  ];
}

// ---------------- Mijozlar ----------------

export function customerTools(env: ToolEnv): AgentTool[] {
  return [
    tool({
      name: 'get_churn_risk_customers',
      description: "Churn xavfi eng yuqori faol mijozlar (ehtimol, sabablar, davomat, to'lov kechikishi) — ID'lar bilan.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20), min_probability: z.number().min(0).max(1).optional() }),
      label: () => 'Churn xavfidagi mijozlar',
      run: async (i) => {
        const ctx = await ctxOf(env);
        const min = i.min_probability ?? ctx.business.settings.churnThreshold;
        const all = (await scoreChurn(ctx)).sort((a, b) => b.probability - a.probability);
        const risky = all.filter((s) => s.probability >= min);
        return {
          threshold: min,
          count: risky.length,
          totalActive: all.length,
          customerIds: risky.map((s) => s.customerId),
          customers: risky.slice(0, i.limit).map((s) => ({ id: s.customerId, name: s.name, segment: s.segment, group: s.groupName, probability: s.probability, reasons: s.reasons, attendance14: r2(s.attendance14), daysInactive: s.daysSinceLastPresent, monthlyPrice: s.monthlyPrice })),
        };
      },
    }),
    tool({
      name: 'get_customer_360',
      description: "Bitta mijozning to'liq profili (Customer 360): manba, kampaniya, menejer, sinov, xarid, daromad, davomat, churn xavfi, timeline. Ism, telefon yoki ID bo'yicha qidiradi.",
      inputSchema: z.object({ query: z.string().min(2) }),
      label: (i) => `Customer 360: ${i.query}`,
      run: async (i) => {
        const found = i.query.startsWith('cus_') ? [{ id: i.query }] : await searchCustomers(env.db, env.businessId, { q: i.query, limit: 5 });
        if (!found.length) return { found: 0 };
        const c = await getCustomer360(env.db, env.businessId, found[0].id);
        return { found: found.length, others: found.slice(1).map((f: any) => ({ id: f.id, name: f.fullName })), customer: c ? { ...c, timeline: c.timeline.slice(0, 15) } : null };
      },
    }),
    tool({
      name: 'get_engagement_trends',
      description: 'Mijozlar faolligi: faol mijozlar, davomat, churn (joriy vs oldingi davr).',
      inputSchema: z.object({ days }),
      label: () => 'Faollik dinamikasi',
      run: async (i) => {
        const { current, previous } = comparisonRanges(i.days);
        const [ac, ap, atc, atp, cc, cp] = await Promise.all([
          q.activeCustomers(env.db, env.businessId, current.end),
          q.activeCustomers(env.db, env.businessId, previous.end),
          q.attendanceRate(env.db, env.businessId, current),
          q.attendanceRate(env.db, env.businessId, previous),
          q.churnStats(env.db, env.businessId, current),
          q.churnStats(env.db, env.businessId, previous),
        ]);
        return { active: { current: ac, previous: ap }, attendance: { current: r2(atc, 3), previous: r2(atp, 3) }, churn: { current: cc, previous: cp } };
      },
    }),
  ];
}

// ---------------- Operatsiyalar ----------------

export function operationsTools(env: ToolEnv): AgentTool[] {
  return [
    tool({
      name: 'get_capacity',
      description: "Guruhlar (sig'im birliklari) to'lishi: faol talabalar / sig'im, segment va filial bo'yicha.",
      inputSchema: z.object({}),
      label: () => "Sig'im (guruhlar)",
      run: async () => (await q.groupCapacity(env.db, env.businessId)).map((g) => ({ id: g.group_id, name: g.name, segment: g.segment, branch: g.branch, active: g.active, capacity: g.capacity, utilization: r2(g.utilization, 2) })),
    }),
    tool({
      name: 'get_employee_load',
      description: 'Xodimlar yuklamasi: ochiq vazifalar, javobsiz leadlar (sotuv menejerlari), rol.',
      inputSchema: z.object({}),
      label: () => 'Xodimlar yuklamasi',
      run: async () =>
        env.db.query(
          `SELECT e.id, e.name, e.role,
                  (SELECT count(*) FROM tasks t WHERE t.assignee_id = e.id AND t.status = 'open') AS open_tasks,
                  (SELECT count(*) FROM leads l WHERE l.assigned_to = e.id AND l.status = 'new' AND l.first_response_at IS NULL) AS unanswered_leads,
                  (SELECT count(*) FROM leads l WHERE l.assigned_to = e.id AND l.created_at > now() - interval '14 days') AS leads_14d
             FROM employees e WHERE e.business_id = $1 AND e.active AND e.role <> 'teacher' ORDER BY open_tasks DESC`,
          [env.businessId],
        ),
    }),
    tool({
      name: 'get_branch_performance',
      description: "Filiallar: faol talabalar, davr daromadi, guruhlar to'lishi.",
      inputSchema: z.object({ days }),
      label: () => 'Filiallar',
      run: async (i) => {
        const { current } = comparisonRanges(i.days);
        return env.db.query(
          `SELECT b.name AS branch,
                  (SELECT count(*) FROM subscriptions s JOIN groups g ON g.id = s.group_id WHERE g.branch_id = b.id AND s.status = 'active') AS active_students,
                  (SELECT COALESCE(sum(p.amount), 0) FROM payments p JOIN subscriptions s ON s.id = p.subscription_id JOIN groups g ON g.id = s.group_id
                    WHERE g.branch_id = b.id AND p.status = 'paid' AND p.paid_at >= $2 AND p.paid_at < $3) AS revenue,
                  (SELECT sum(g.capacity) FROM groups g WHERE g.branch_id = b.id AND g.status = 'active') AS capacity
             FROM branches b WHERE b.business_id = $1`,
          [env.businessId, current.start, current.end],
        );
      },
    }),
  ];
}

export function findingsTool(env: ToolEnv): AgentTool {
  return tool({
    name: 'get_open_findings',
    description: "Detektorlar hozir aniqlagan ochiq muammolar (javobsiz leadlar, churn, CAC, sig'im, kechikkan to'lovlar...).",
    inputSchema: z.object({}),
    label: () => 'Ochiq muammolar',
    run: async () => (await listFindings({ db: env.db, businessId: env.businessId }, 'open')).map((f) => ({ detector: f.detector, severity: f.severity, title: f.title, summary: f.summary, impact: Math.round(f.impact), entityCount: f.entityIds.length })),
  });
}

export function pendingActionsTool(env: ToolEnv): AgentTool {
  return tool({
    name: 'get_pending_actions',
    description: "Rahbar tasdig'ini kutayotgan va yaqinda bajarilgan harakatlar.",
    inputSchema: z.object({}),
    label: () => 'Harakatlar holati',
    run: async () => {
      const [pending, recent] = await Promise.all([listActions(env.db, env.businessId, { status: 'pending', limit: 20 }), listActions(env.db, env.businessId, { status: 'history', limit: 10 })]);
      const f = (a: ActionView) => ({ id: a.id, type: a.type, title: a.title, risk: a.risk, status: a.status, result: (a.result as any)?.summary ?? null });
      return { pending: pending.map(f), recent: recent.map(f) };
    },
  });
}

