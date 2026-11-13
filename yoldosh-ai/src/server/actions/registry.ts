import { z } from 'zod';
import type { Db } from '../db';
import type { Business, BusinessSettings, RiskLevel, Unit } from '../../shared/types';
import { updateBusiness } from '../context/business';
import * as q from '../metrics/queries';
import { addDays, addHours, fmtMoney, fmtPct, pctChange, safeDiv } from '../lib/util';
import {
  createTask,
  findEmployeeByRole,
  messageCustomer,
  notifyEmployee,
  reassignLead,
  updateCampaign,
  type ChannelContext,
} from './channels';

/**
 * Action Layer registri — AI bajara oladigan barcha harakatlar.
 * Har bir harakat: parametr sxemasi (zod), xavf darajasi, bajaruvchi va
 * natijani o'lchash usuli (Feedback Loop uchun).
 */

export interface ActionExecContext extends ChannelContext {
  business: Business;
  actionId: string;
  at: Date;
}

export interface ExecResult {
  summary: string;
  simulated?: boolean;
  manual?: boolean;
  details?: Record<string, unknown>;
}

export interface MeasureContext {
  db: Db;
  businessId: string;
}

export interface OutcomeSpec {
  metric: string;
  label: string;
  direction: 'increase' | 'decrease';
  unit: Unit;
  windowHours: number;
  measure(ctx: MeasureContext, phase: 'baseline' | 'observed', executedAt: Date): Promise<number | null>;
}

export interface RiskContext {
  db: Db;
  businessId: string;
  settings: BusinessSettings;
}

export interface ActionDefinition<S extends z.ZodType = z.ZodType> {
  type: string;
  label: string;
  description: string;
  schema: S;
  baseRisk: RiskLevel;
  risk?(ctx: RiskContext, params: z.infer<S>): Promise<RiskLevel>;
  execute(ctx: ActionExecContext, params: z.infer<S>): Promise<ExecResult>;
  outcome?(params: z.infer<S>): OutcomeSpec | null;
}

function define<S extends z.ZodType>(def: ActionDefinition<S>): ActionDefinition<S> {
  return def;
}

// ---------------- O'lchov yordamchilari (Feedback Loop) ----------------

function leadsResponseRate(leadIds: string[]): OutcomeSpec {
  return {
    metric: 'leads_response_rate',
    label: 'Leadlarga javob berilgan ulush',
    direction: 'increase',
    unit: 'ratio',
    windowHours: 24,
    async measure(ctx, phase, executedAt) {
      if (!leadIds.length) return null;
      const row = await ctx.db.one<{ total: number; answered: number }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE first_response_at IS NOT NULL AND ($3 = 'observed' OR first_response_at <= $2)) AS answered
           FROM leads WHERE id = ANY($1)`,
        [leadIds, executedAt, phase],
      );
      return row && row.total > 0 ? row.answered / row.total : null;
    },
  };
}

function customersAttendance(customerIds: string[]): OutcomeSpec {
  return {
    metric: 'customers_attendance_rate',
    label: 'Mijozlar davomati (7 kun)',
    direction: 'increase',
    unit: 'ratio',
    windowHours: 7 * 24,
    async measure(ctx, phase, executedAt) {
      if (!customerIds.length) return null;
      const start = phase === 'baseline' ? addDays(executedAt, -7) : executedAt;
      const end = phase === 'baseline' ? executedAt : addDays(executedAt, 7);
      const row = await ctx.db.one<{ rate: number | null }>(
        `SELECT avg(CASE WHEN present THEN 1.0 ELSE 0.0 END)::float8 AS rate FROM attendance
          WHERE customer_id = ANY($1) AND date >= ($2::timestamptz)::date AND date < ($3::timestamptz)::date`,
        [customerIds, start, end],
      );
      return row?.rate ?? null;
    },
  };
}

function paymentsPaidShare(paymentIds: string[]): OutcomeSpec {
  return {
    metric: 'payments_paid_share',
    label: "To'langan ulush (5 kun)",
    direction: 'increase',
    unit: 'ratio',
    windowHours: 5 * 24,
    async measure(ctx, phase, executedAt) {
      if (!paymentIds.length) return null;
      const row = await ctx.db.one<{ total: number; paid: number }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE status = 'paid' AND ($3 = 'observed' OR paid_at <= $2)) AS paid
           FROM payments WHERE id = ANY($1)`,
        [paymentIds, executedAt, phase],
      );
      return row && row.total > 0 ? row.paid / row.total : null;
    },
  };
}

function campaignCac(campaignId: string): OutcomeSpec {
  return {
    metric: 'campaign_cac',
    label: 'Kampaniya CAC',
    direction: 'decrease',
    unit: 'money',
    windowHours: 7 * 24,
    async measure(ctx, phase, executedAt) {
      const range = phase === 'baseline' ? { start: addDays(executedAt, -14), end: executedAt } : { start: executedAt, end: addDays(executedAt, 7) };
      const rows = await q.campaignPerformance(ctx.db, ctx.businessId, range);
      const c = rows.find((r) => r.campaign_id === campaignId);
      return c?.cac ?? null;
    },
  };
}

function blendedCac(): OutcomeSpec {
  return {
    metric: 'blended_cac',
    label: 'Umumiy CAC',
    direction: 'decrease',
    unit: 'money',
    windowHours: 14 * 24,
    async measure(ctx, phase, executedAt) {
      const range = phase === 'baseline' ? { start: addDays(executedAt, -14), end: executedAt } : { start: executedAt, end: addDays(executedAt, 14) };
      return (await q.marketingTotals(ctx.db, ctx.businessId, range)).cac;
    },
  };
}

function medianResponse(): OutcomeSpec {
  return {
    metric: 'response_time_minutes',
    label: 'Birinchi javob vaqti (median)',
    direction: 'decrease',
    unit: 'minutes',
    windowHours: 7 * 24,
    async measure(ctx, phase, executedAt) {
      const range = phase === 'baseline' ? { start: addDays(executedAt, -7), end: executedAt } : { start: executedAt, end: addDays(executedAt, 7) };
      const rows = await q.responseTimes(ctx.db, ctx.businessId, range, 'total', 15);
      return rows[0]?.medianMinutes ?? null;
    },
  };
}

async function employeeName(db: Db, id: string | null | undefined): Promise<string> {
  if (!id) return '—';
  return (await db.one<{ name: string }>('SELECT name FROM employees WHERE id = $1', [id]))?.name ?? id;
}

const ids = z.array(z.string().min(1));

// ---------------- Harakatlar ----------------

const createTaskAction = define({
  type: 'create_task',
  label: 'Vazifa yaratish',
  description: "Xodimga vazifa yaratadi (ichki tizimda va amoCRM ulangan bo'lsa CRM'da) va unga xabar yuboradi.",
  baseRisk: 'low',
  schema: z.object({
    title: z.string().min(3),
    description: z.string().optional(),
    assigneeId: z.string().optional(),
    leadIds: ids.optional(),
    customerId: z.string().optional(),
    dueInHours: z.number().positive().max(24 * 30).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
  }),
  async execute(ctx, p) {
    const task = await createTask(ctx, {
      title: p.title,
      description: p.description,
      assigneeId: p.assigneeId,
      leadIds: p.leadIds,
      customerId: p.customerId,
      dueAt: addHours(ctx.at, p.dueInHours ?? 2),
      priority: p.priority ?? 'normal',
    });
    let delivery = null;
    if (p.assigneeId) {
      delivery = await notifyEmployee(ctx, p.assigneeId, `📋 Yangi vazifa: ${p.title}${p.description ? `\n\n${p.description}` : ''}`);
    }
    return {
      summary: `Vazifa yaratildi: "${p.title}" → ${await employeeName(ctx.db, p.assigneeId)}${task.crm === 'amocrm' ? ' (amoCRM)' : ''}`,
      simulated: task.crm === 'internal',
      details: { ...task, delivery },
    };
  },
  outcome: (p) => (p.leadIds?.length ? leadsResponseRate(p.leadIds) : null),
});

const notifyEmployeeAction = define({
  type: 'notify_employee',
  label: 'Xodimga xabar yuborish',
  description: "Xodimga (ID yoki rol bo'yicha) Telegram orqali xabar yuboradi.",
  baseRisk: 'low',
  schema: z.object({
    employeeId: z.string().optional(),
    role: z.enum(['sales_manager', 'retention_manager', 'finance', 'owner', 'teacher']).optional(),
    message: z.string().min(3),
    customerIds: ids.optional(),
  }),
  async execute(ctx, p) {
    const emp = p.employeeId
      ? { id: p.employeeId, name: await employeeName(ctx.db, p.employeeId) }
      : await findEmployeeByRole(ctx.db, ctx.businessId, p.role ?? 'owner');
    if (!emp) throw new Error('Xodim topilmadi');
    const delivery = await notifyEmployee(ctx, emp.id, p.message);
    return {
      summary: `${emp.name}ga xabar ${delivery.status === 'sent' ? 'Telegram orqali yuborildi' : 'ichki bildirishnoma sifatida saqlandi'}`,
      simulated: delivery.channel === 'internal',
      details: { delivery },
    };
  },
  outcome: (p) => (p.customerIds?.length ? customersAttendance(p.customerIds) : null),
});

const reassignLeadsAction = define({
  type: 'reassign_leads',
  label: 'Leadlarni qayta taqsimlash',
  description: "Javobsiz leadlarni eng kam yuklangan sotuv menejerlariga qayta biriktiradi, har biriga vazifa va xabar yuboradi.",
  baseRisk: 'medium',
  schema: z.object({
    leadIds: ids.min(1),
    excludeEmployeeIds: ids.optional(),
    toEmployeeIds: ids.optional(),
  }),
  async execute(ctx, p) {
    const leads = await ctx.db.query<{ id: string; assigned_to: string | null; name: string | null; phone: string | null; segment: string | null }>(
      `SELECT l.id, l.assigned_to, c.full_name AS name, c.phone, l.segment FROM leads l JOIN customers c ON c.id = l.customer_id
        WHERE l.business_id = $1 AND l.id = ANY($2) AND l.first_response_at IS NULL AND l.status = 'new'`,
      [ctx.businessId, p.leadIds],
    );
    if (leads.length === 0) return { summary: "Barcha leadlarga allaqachon javob berilgan — qayta taqsimlash shart emas", details: { assigned: 0 } };

    // Ortiqcha yuklangan menejer(lar)ni avtomatik chiqarib tashlash
    let exclude = new Set(p.excludeEmployeeIds ?? []);
    if (!p.excludeEmployeeIds) {
      const counts = new Map<string, number>();
      for (const l of leads) if (l.assigned_to) counts.set(l.assigned_to, (counts.get(l.assigned_to) ?? 0) + 1);
      for (const [emp, n] of counts) if (n / leads.length > 0.4) exclude.add(emp);
    }
    const candidates = await ctx.db.query<{ id: string; name: string; load: number }>(
      `SELECT e.id, e.name,
              (SELECT count(*) FROM leads l WHERE l.assigned_to = e.id AND l.status = 'new' AND l.first_response_at IS NULL) +
              (SELECT count(*) FROM tasks t WHERE t.assignee_id = e.id AND t.status = 'open') AS load
         FROM employees e
        WHERE e.business_id = $1 AND e.role = 'sales_manager' AND e.active AND ($2::text[] IS NULL OR e.id = ANY($2))`,
      [ctx.businessId, p.toEmployeeIds ?? null],
    );
    let pool = candidates.filter((c) => !exclude.has(c.id));
    if (pool.length === 0) pool = candidates;
    if (pool.length === 0) throw new Error('Sotuv menejerlari topilmadi');

    const load = new Map(pool.map((c) => [c.id, c.load]));
    const assignment = new Map<string, typeof leads>();
    for (const l of leads) {
      const target = [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
      load.set(target, load.get(target)! + 1);
      assignment.set(target, [...(assignment.get(target) ?? []), l]);
    }
    let crm = 'internal';
    for (const [empId, list] of assignment) {
      for (const l of list) {
        const r = await reassignLead(ctx, l.id, empId);
        if (r.crm === 'amocrm') crm = 'amocrm';
      }
      const lines = list.slice(0, 15).map((l) => `• ${l.name ?? 'Mijoz'} ${l.phone ?? ''} (${l.segment ?? '—'})`);
      await createTask(ctx, {
        title: `${list.length} ta javobsiz lead — darhol bog'laning`,
        description: lines.join('\n'),
        assigneeId: empId,
        leadIds: list.map((l) => l.id),
        dueAt: addHours(ctx.at, 1),
        priority: 'high',
      });
      await notifyEmployee(ctx, empId, `⚡ Sizga ${list.length} ta javobsiz lead biriktirildi. Iltimos, 15 daqiqa ichida bog'laning:\n${lines.join('\n')}`);
    }
    const parts = await Promise.all(
      [...assignment.entries()].map(async ([empId, list]) => `${pool.find((c) => c.id === empId)?.name ?? (await employeeName(ctx.db, empId))} — ${list.length}`),
    );
    return {
      summary: `${leads.length} ta lead qayta taqsimlandi: ${parts.join(', ')}`,
      simulated: crm === 'internal',
      details: { assigned: leads.length, distribution: Object.fromEntries([...assignment].map(([k, v]) => [k, v.length])), excluded: [...exclude] },
    };
  },
  outcome: (p) => leadsResponseRate(p.leadIds),
});

const retentionOutreach = define({
  type: 'retention_outreach',
  label: "Retention: mijozlar bilan bog'lanish",
  description: "Churn xavfidagi yoki faol bo'lmagan mijozlar ro'yxati bo'yicha retention menejerga qo'ng'iroq vazifasini yaratadi.",
  baseRisk: 'low',
  schema: z.object({
    customerIds: ids.min(1),
    assigneeId: z.string().optional(),
    note: z.string().optional(),
  }),
  async execute(ctx, p) {
    const assignee = p.assigneeId
      ? { id: p.assigneeId, name: await employeeName(ctx.db, p.assigneeId) }
      : await findEmployeeByRole(ctx.db, ctx.businessId, 'retention_manager');
    const customers = await ctx.db.query<{ full_name: string | null; phone: string | null }>(
      'SELECT full_name, phone FROM customers WHERE id = ANY($1) LIMIT 30',
      [p.customerIds],
    );
    const lines = customers.map((c) => `• ${c.full_name ?? 'Mijoz'} ${c.phone ?? ''}`);
    const title = `${p.customerIds.length} ta mijoz bilan bog'lanish (retention)`;
    const task = await createTask(ctx, {
      title,
      description: `${p.note ?? "Davomati tushgan / churn xavfidagi mijozlar. Sababini aniqlang, yordam taklif qiling."}\n\n${lines.join('\n')}`,
      assigneeId: assignee?.id,
      customerId: p.customerIds.length === 1 ? p.customerIds[0] : null,
      dueAt: addHours(ctx.at, 24),
      priority: 'high',
    });
    if (assignee) await notifyEmployee(ctx, assignee.id, `🔔 ${title}:\n${lines.slice(0, 12).join('\n')}`);
    return { summary: `${title} → ${assignee?.name ?? 'biriktirilmagan'}`, simulated: task.crm === 'internal', details: task };
  },
  outcome: (p) => customersAttendance(p.customerIds),
});

const paymentReminder = define({
  type: 'send_payment_reminder',
  label: "To'lov eslatmasi yuborish",
  description: "Kechikkan to'lovlar bo'yicha mijozlarga Telegram eslatma yuboradi; Telegram'i yo'qlar uchun moliya xodimiga qo'ng'iroq vazifasi yaratadi.",
  baseRisk: 'medium',
  schema: z.object({ paymentIds: ids.min(1), message: z.string().optional() }),
  async execute(ctx, p) {
    const rows = await ctx.db.query<{ id: string; customer_id: string; full_name: string | null; phone: string | null; amount: number; due_date: string; telegram_chat_id: string | null }>(
      `SELECT p.id, p.customer_id, c.full_name, c.phone, p.amount, p.due_date, c.telegram_chat_id
         FROM payments p JOIN customers c ON c.id = p.customer_id
        WHERE p.business_id = $1 AND p.id = ANY($2) AND p.status IN ('pending', 'overdue')`,
      [ctx.businessId, p.paymentIds],
    );
    let sent = 0;
    const callList: typeof rows = [];
    for (const r of rows) {
      if (r.telegram_chat_id) {
        const text =
          p.message ??
          `Assalomu alaykum, ${r.full_name ?? ''}! ${ctx.business.name}: ${r.due_date} sanasidagi ${fmtMoney(r.amount)} to'lov muddati o'tgan. Iltimos, to'lovni amalga oshiring. Savollar bo'lsa, javob yozing.`;
        const d = await messageCustomer(ctx, r.customer_id, text);
        if (d.status === 'sent') sent++;
        else callList.push(r);
      } else callList.push(r);
    }
    if (callList.length) {
      const finance = await findEmployeeByRole(ctx.db, ctx.businessId, 'finance');
      await createTask(ctx, {
        title: `${callList.length} ta mijozga to'lov bo'yicha qo'ng'iroq`,
        description: callList.map((r) => `• ${r.full_name ?? 'Mijoz'} ${r.phone ?? ''} — ${fmtMoney(r.amount)} (${r.due_date})`).join('\n'),
        assigneeId: finance?.id,
        dueAt: addHours(ctx.at, 24),
      });
    }
    return {
      summary: `${sent} ta mijozga Telegram eslatma yuborildi, ${callList.length} tasi uchun qo'ng'iroq vazifasi yaratildi`,
      simulated: sent === 0,
      details: { sent, calls: callList.length, total: rows.length },
    };
  },
  outcome: (p) => paymentsPaidShare(p.paymentIds),
});

const changeBudget = define({
  type: 'change_campaign_budget',
  label: "Kampaniya byudjetini o'zgartirish",
  description: "Reklama kampaniyasining kunlik byudjetini (so'mda) o'zgartiradi. Katta o'zgarish — yuqori xavf.",
  baseRisk: 'medium',
  schema: z.object({ campaignId: z.string(), newDailyBudget: z.number().positive(), reason: z.string().optional() }),
  async risk(ctx, p) {
    const c = await ctx.db.one<{ daily_budget: number | null }>('SELECT daily_budget FROM campaigns WHERE id = $1', [p.campaignId]);
    if (!c?.daily_budget) return 'high';
    const change = Math.abs(p.newDailyBudget - c.daily_budget) / c.daily_budget;
    return change * 100 > ctx.settings.maxBudgetChangePct ? 'high' : 'medium';
  },
  async execute(ctx, p) {
    const c = await ctx.db.one<{ name: string; daily_budget: number | null }>('SELECT name, daily_budget FROM campaigns WHERE id = $1 AND business_id = $2', [
      p.campaignId,
      ctx.businessId,
    ]);
    if (!c) throw new Error('Kampaniya topilmadi');
    const r = await updateCampaign(ctx, p.campaignId, { dailyBudget: p.newDailyBudget });
    return {
      summary: `${c.name}: kunlik byudjet ${fmtMoney(c.daily_budget ?? 0)} → ${fmtMoney(p.newDailyBudget)}${r.simulated ? ' (reklama kabineti ulanmagan — ichki tizimda yangilandi)' : ''}`,
      simulated: r.simulated,
      details: { previousDailyBudget: c.daily_budget, newDailyBudget: p.newDailyBudget, platform: r.platform },
    };
  },
  outcome: (p) => campaignCac(p.campaignId),
});

const pauseCampaign = define({
  type: 'pause_campaign',
  label: "Kampaniyani to'xtatish",
  description: "Samarasiz reklama kampaniyasini to'xtatadi (pauza).",
  baseRisk: 'medium',
  schema: z.object({ campaignId: z.string(), reason: z.string().optional() }),
  async execute(ctx, p) {
    const c = await ctx.db.one<{ name: string }>('SELECT name FROM campaigns WHERE id = $1 AND business_id = $2', [p.campaignId, ctx.businessId]);
    if (!c) throw new Error('Kampaniya topilmadi');
    const r = await updateCampaign(ctx, p.campaignId, { status: 'paused' });
    return { summary: `${c.name} to'xtatildi${r.simulated ? ' (ichki tizimda)' : ''}`, simulated: r.simulated, details: r };
  },
  outcome: () => blendedCac(),
});

const routeLeads = define({
  type: 'route_leads',
  label: "Leadlarni boshqa guruhga yo'naltirish",
  description: "Segmentdagi yangi leadlarni to'lib qolgan guruh o'rniga bo'sh guruhga yo'naltiradi (lead routing qoidasi).",
  baseRisk: 'low',
  schema: z.object({ segment: z.string(), fromGroupId: z.string().optional(), toGroupId: z.string() }),
  async execute(ctx, p) {
    const g = await ctx.db.one<{ name: string }>('SELECT name FROM groups WHERE id = $1 AND business_id = $2', [p.toGroupId, ctx.businessId]);
    if (!g) throw new Error('Guruh topilmadi');
    await updateBusiness(ctx.db, ctx.businessId, { settings: { leadRouting: { ...ctx.business.settings.leadRouting, [p.segment]: p.toGroupId } } });
    const managers = await ctx.db.query<{ id: string }>(`SELECT id FROM employees WHERE business_id = $1 AND role = 'sales_manager' AND active`, [ctx.businessId]);
    for (const m of managers) await notifyEmployee(ctx, m.id, `ℹ️ ${p.segment} bo'yicha yangi talabalarni endi "${g.name}" guruhiga yozing.`);
    return { summary: `${p.segment} leadlari endi "${g.name}" guruhiga yo'naltiriladi`, details: { notified: managers.length } };
  },
});

const updateLeadStatus = define({
  type: 'update_lead_status',
  label: 'Lead holatini yangilash',
  description: 'Lead bosqichini yangilaydi (new, contacted, trial, won, lost).',
  baseRisk: 'low',
  schema: z.object({ leadId: z.string(), status: z.enum(['new', 'contacted', 'trial', 'won', 'lost']), reason: z.string().optional() }),
  async execute(ctx, p) {
    await ctx.db.query(
      `UPDATE leads SET status = $3, lost_reason = COALESCE($4, lost_reason),
         lost_at = CASE WHEN $3 = 'lost' THEN now() ELSE lost_at END, updated_at = now()
       WHERE id = $1 AND business_id = $2`,
      [p.leadId, ctx.businessId, p.status, p.reason ?? null],
    );
    return { summary: `Lead holati: ${p.status}`, simulated: true };
  },
});

const customerMessage = define({
  type: 'send_customer_message',
  label: 'Mijozga xabar yuborish',
  description: 'Mijozga Telegram orqali xabar yuboradi (muhim muloqot — tasdiq talab qilinadi).',
  baseRisk: 'medium',
  schema: z.object({ customerId: z.string(), message: z.string().min(3) }),
  async execute(ctx, p) {
    const d = await messageCustomer(ctx, p.customerId, p.message);
    if (d.status !== 'sent') {
      await createTask(ctx, { title: "Mijozga xabarni yetkazish (Telegram yo'q)", description: p.message, customerId: p.customerId });
    }
    return { summary: d.status === 'sent' ? 'Xabar Telegram orqali yuborildi' : "Telegram yo'q — qo'ng'iroq vazifasi yaratildi", simulated: d.status !== 'sent', details: { delivery: d } };
  },
});

const refund = define({
  type: 'issue_refund',
  label: 'Pulni qaytarish',
  description: "Mijozga pul qaytarish. Faqat inson tasdig'i bilan; moliya bo'limi qo'lda bajaradi.",
  baseRisk: 'high',
  schema: z.object({ paymentId: z.string(), amount: z.number().positive(), reason: z.string().min(3) }),
  async execute(ctx, p) {
    const finance = await findEmployeeByRole(ctx.db, ctx.businessId, 'finance');
    await createTask(ctx, {
      title: `Pul qaytarish: ${fmtMoney(p.amount)}`,
      description: `To'lov: ${p.paymentId}\nSabab: ${p.reason}`,
      assigneeId: finance?.id,
      priority: 'high',
      dueAt: addHours(ctx.at, 24),
    });
    return { summary: `Moliya bo'limiga ${fmtMoney(p.amount)} qaytarish vazifasi yaratildi (qo'lda bajariladi)`, manual: true };
  },
});

const analyzeCampaign = define({
  type: 'analyze_campaign',
  label: 'Kampaniyani tahlil qilish',
  description: "Kampaniyaning so'nggi 4 haftalik voronkasini (xarajat, CPL, sotuv, CAC) tahlil qilib hisobot tayyorlaydi.",
  baseRisk: 'low',
  schema: z.object({ campaignId: z.string() }),
  async execute(ctx, p) {
    const c = await ctx.db.one<{ name: string; daily_budget: number | null }>('SELECT name, daily_budget FROM campaigns WHERE id = $1 AND business_id = $2', [
      p.campaignId,
      ctx.businessId,
    ]);
    if (!c) throw new Error('Kampaniya topilmadi');
    const weeks = [];
    for (let w = 3; w >= 0; w--) {
      const range = { start: addDays(ctx.at, -7 * (w + 1)), end: addDays(ctx.at, -7 * w) };
      const row = (await q.campaignPerformance(ctx.db, ctx.businessId, range)).find((r) => r.campaign_id === p.campaignId);
      weeks.push({
        week: `${4 - w}-hafta`,
        spend: row?.spend ?? 0,
        leads: row ? row.platform_leads || row.crm_leads : 0,
        won: row?.won ?? 0,
        cpl: row?.cpl ?? 0,
        cac: row?.cac ?? null,
      });
    }
    const first = weeks[0];
    const last = weeks[weeks.length - 1];
    const cplChange = pctChange(last.cpl, first.cpl);
    const leadsChange = pctChange(last.leads, first.leads);
    const spendChange = pctChange(last.spend, first.spend);
    const notes: string[] = [];
    if ((spendChange ?? 0) > 0.15 && (leadsChange ?? 0) < (spendChange ?? 0) / 2) {
      notes.push(`Xarajat ${fmtPct(spendChange)} oshgan, leadlar esa atigi ${fmtPct(leadsChange)} — auditoriya to'yingan bo'lishi mumkin.`);
    }
    if ((cplChange ?? 0) > 0.2) notes.push(`CPL ${fmtPct(cplChange)} oshgan — kreativni yangilash yoki auditoriyani torayish tavsiya etiladi.`);
    // So'nggi hafta leadlari hali "yetilmagan" — konversiya 1- va 3-hafta bo'yicha solishtiriladi
    const mature = weeks[2];
    const conv = safeDiv(mature.won, mature.leads);
    const convFirst = safeDiv(first.won, first.leads);
    if (convFirst > 0 && conv < convFirst * 0.75) notes.push(`Lead sifati pasaygan: konversiya ${fmtPct(convFirst, 1, false)} → ${fmtPct(conv, 1, false)}.`);
    if (!notes.length) notes.push("Jiddiy salbiy o'zgarish topilmadi.");
    return {
      summary: `${c.name} tahlili: ${notes.join(' ')}`,
      details: { weeks, notes, dailyBudget: c.daily_budget },
    };
  },
});

const updateSla = define({
  type: 'update_sla',
  label: "Javob SLA'sini o'zgartirish",
  description: "Leadlarga birinchi javob SLA'sini (daqiqa) o'zgartiradi — detektorlar va ogohlantirishlar shunga moslashadi.",
  baseRisk: 'medium',
  schema: z.object({ minutes: z.number().int().min(1).max(240) }),
  async execute(ctx, p) {
    const prev = ctx.business.settings.responseSlaMinutes;
    await updateBusiness(ctx.db, ctx.businessId, { settings: { responseSlaMinutes: p.minutes } });
    await ctx.db.query(`UPDATE business_rules SET params = jsonb_set(params, '{minutes}', to_jsonb($2::int)) WHERE business_id = $1 AND detector = 'response_time_sla'`, [
      ctx.businessId,
      p.minutes,
    ]);
    const managers = await ctx.db.query<{ id: string }>(`SELECT id FROM employees WHERE business_id = $1 AND role = 'sales_manager' AND active`, [ctx.businessId]);
    for (const m of managers) await notifyEmployee(ctx, m.id, `⏱ Yangi standart: har bir yangi leadga ${p.minutes} daqiqa ichida javob bering.`);
    return { summary: `Javob SLA: ${prev} → ${p.minutes} daqiqa, ${managers.length} menejer xabardor qilindi` };
  },
  outcome: () => medianResponse(),
});

export const ACTIONS: Record<string, ActionDefinition<any>> = Object.fromEntries(
  [
    createTaskAction,
    notifyEmployeeAction,
    reassignLeadsAction,
    retentionOutreach,
    paymentReminder,
    changeBudget,
    pauseCampaign,
    routeLeads,
    updateLeadStatus,
    customerMessage,
    refund,
    analyzeCampaign,
    updateSla,
  ].map((a) => [a.type, a]),
);

export function actionLabel(type: string): string {
  return ACTIONS[type]?.label ?? type;
}

export async function assessRisk(ctx: RiskContext, type: string, params: unknown): Promise<RiskLevel> {
  const def = ACTIONS[type];
  if (!def) throw new Error(`Noma'lum harakat turi: ${type}`);
  return def.risk ? def.risk(ctx, params) : def.baseRisk;
}

/** UI va AI uchun katalog (parametr sxemasi JSON Schema ko'rinishida). */
export function actionCatalog() {
  return Object.values(ACTIONS).map((a) => ({
    type: a.type,
    label: a.label,
    description: a.description,
    baseRisk: a.baseRisk,
    paramsSchema: z.toJSONSchema(a.schema),
  }));
}

