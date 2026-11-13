import type { Db } from '../db';
import { amoCreateTasks, amoUpdateLeads, type AmoConfig } from '../connectors/amocrm';
import { metaUpdateCampaign, type MetaConfig } from '../connectors/meta';
import { connectorFetch, getActiveConnector } from '../connectors/registry';
import { tgSendMessage } from '../connectors/telegram';
import { addHours, errorMessage, newId, now } from '../lib/util';

/**
 * Action Layer kanallari — harakatni haqiqiy tizimga yetkazadi.
 * Tegishli integratsiya ulanmagan bo'lsa, harakat ichki tizimda bajariladi
 * va natijada `simulated: true` deb belgilanadi (shaffoflik uchun).
 */

export interface ChannelContext {
  db: Db;
  businessId: string;
  actionId?: string;
}

export interface DeliveryResult {
  status: 'sent' | 'logged' | 'failed';
  channel: 'telegram' | 'internal';
  error?: string;
}

async function telegram(ctx: ChannelContext) {
  const tg = await getActiveConnector(ctx.db, ctx.businessId, 'telegram');
  const token = (tg?.config.botToken as string | undefined) ?? process.env.TELEGRAM_BOT_TOKEN;
  return token ? { token, ownerChatId: (tg?.config.ownerChatId as string | undefined) ?? null } : null;
}

async function logNotification(
  ctx: ChannelContext,
  n: { channel: string; employeeId?: string | null; customerId?: string | null; recipient?: string | null; text: string; status: string; error?: string },
) {
  await ctx.db.query(
    `INSERT INTO notifications (id, business_id, channel, recipient_employee_id, recipient_customer_id, recipient, text, status, error, action_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [newId('ntf'), ctx.businessId, n.channel, n.employeeId ?? null, n.customerId ?? null, n.recipient ?? null, n.text, n.status, n.error ?? null, ctx.actionId ?? null],
  );
}

async function deliver(
  ctx: ChannelContext,
  target: { chatId: string | null; employeeId?: string | null; customerId?: string | null; label: string },
  text: string,
  replyMarkup?: unknown,
): Promise<DeliveryResult> {
  const tg = await telegram(ctx);
  if (tg && target.chatId) {
    try {
      await tgSendMessage(connectorFetch(), tg.token, target.chatId, text, { replyMarkup });
      await logNotification(ctx, { channel: 'telegram', ...target, recipient: target.label, text, status: 'sent' });
      return { status: 'sent', channel: 'telegram' };
    } catch (err) {
      await logNotification(ctx, { channel: 'telegram', ...target, recipient: target.label, text, status: 'failed', error: errorMessage(err) });
      return { status: 'failed', channel: 'telegram', error: errorMessage(err) };
    }
  }
  // Telegram ulanmagan — ichki bildirishnoma (ilovadagi "Bildirishnomalar" jurnali)
  await logNotification(ctx, { channel: 'internal', ...target, recipient: target.label, text, status: 'logged' });
  return { status: 'logged', channel: 'internal' };
}

export async function notifyEmployee(ctx: ChannelContext, employeeId: string, text: string): Promise<DeliveryResult> {
  const e = await ctx.db.one<{ name: string; telegram_chat_id: string | null }>('SELECT name, telegram_chat_id FROM employees WHERE id = $1', [employeeId]);
  return deliver(ctx, { chatId: e?.telegram_chat_id ?? null, employeeId, label: e?.name ?? employeeId }, text);
}

export async function messageCustomer(ctx: ChannelContext, customerId: string, text: string): Promise<DeliveryResult> {
  const c = await ctx.db.one<{ full_name: string | null; telegram_chat_id: string | null; phone: string | null }>(
    'SELECT full_name, telegram_chat_id, phone FROM customers WHERE id = $1',
    [customerId],
  );
  return deliver(ctx, { chatId: c?.telegram_chat_id ?? null, customerId, label: c?.full_name ?? c?.phone ?? customerId }, text);
}

export async function notifyOwner(ctx: ChannelContext, text: string, replyMarkup?: unknown): Promise<DeliveryResult> {
  const tg = await telegram(ctx);
  return deliver(ctx, { chatId: tg?.ownerChatId ?? null, label: 'Rahbar' }, text, replyMarkup);
}

export async function findEmployeeByRole(db: Db, businessId: string, role: string): Promise<{ id: string; name: string } | undefined> {
  return db.one('SELECT id, name FROM employees WHERE business_id = $1 AND role = $2 AND active ORDER BY created_at LIMIT 1', [businessId, role]);
}

// ---------------- CRM ----------------

export interface TaskInput {
  title: string;
  description?: string | null;
  assigneeId?: string | null;
  leadIds?: string[];
  customerId?: string | null;
  dueAt?: Date;
  priority?: 'low' | 'normal' | 'high';
  createdBy?: 'ai' | 'rule' | 'human';
}

/** Vazifa: ichki tizimda + amoCRM ulangan bo'lsa, CRM'da ham. */
export async function createTask(ctx: ChannelContext, t: TaskInput) {
  const id = newId('tsk');
  const dueAt = t.dueAt ?? addHours(now(), 2);
  await ctx.db.query(
    `INSERT INTO tasks (id, business_id, title, description, assignee_id, customer_id, lead_ids, due_at, status, priority, created_by, action_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11)`,
    [id, ctx.businessId, t.title, t.description ?? null, t.assigneeId ?? null, t.customerId ?? null, t.leadIds ?? [], dueAt, t.priority ?? 'normal', t.createdBy ?? 'ai', ctx.actionId ?? null],
  );
  let crm: 'amocrm' | 'internal' = 'internal';
  let crmError: string | undefined;
  const amo = await getActiveConnector(ctx.db, ctx.businessId, 'amocrm');
  if (amo) {
    const leads = t.leadIds?.length
      ? await ctx.db.query<{ external_id: string }>(`SELECT external_id FROM leads WHERE id = ANY($1) AND source = 'amocrm'`, [t.leadIds])
      : [];
    const emp = t.assigneeId
      ? await ctx.db.one<{ external_id: string | null; source: string }>('SELECT external_id, source FROM employees WHERE id = $1', [t.assigneeId])
      : undefined;
    const responsible = emp?.source === 'amocrm' ? emp.external_id : null;
    try {
      const tasks = (leads.length ? leads.slice(0, 50) : [{ external_id: null as string | null }]).map((l) => ({
        text: t.title,
        leadExternalId: l.external_id,
        responsibleExternalId: responsible,
        completeTill: dueAt,
      }));
      await amoCreateTasks(connectorFetch(), amo.config as AmoConfig, tasks);
      crm = 'amocrm';
    } catch (err) {
      crmError = errorMessage(err);
    }
  }
  return { taskId: id, crm, crmError };
}

export async function reassignLead(ctx: ChannelContext, leadId: string, employeeId: string) {
  await ctx.db.query(`UPDATE leads SET assigned_to = $2, updated_at = now() WHERE id = $1 AND business_id = $3`, [leadId, employeeId, ctx.businessId]);
  const amo = await getActiveConnector(ctx.db, ctx.businessId, 'amocrm');
  if (!amo) return { crm: 'internal' as const };
  const lead = await ctx.db.one<{ external_id: string; source: string }>('SELECT external_id, source FROM leads WHERE id = $1', [leadId]);
  const emp = await ctx.db.one<{ external_id: string | null; source: string }>('SELECT external_id, source FROM employees WHERE id = $1', [employeeId]);
  if (lead?.source !== 'amocrm' || emp?.source !== 'amocrm' || !emp.external_id) return { crm: 'internal' as const };
  await amoUpdateLeads(connectorFetch(), amo.config as AmoConfig, [{ id: lead.external_id, responsibleExternalId: emp.external_id }]);
  return { crm: 'amocrm' as const };
}

// ---------------- Reklama ----------------

export async function updateCampaign(
  ctx: ChannelContext,
  campaignId: string,
  update: { dailyBudget?: number; status?: 'paused' | 'active' },
): Promise<{ platform: string; simulated: boolean }> {
  const c = await ctx.db.one<{ source: string; external_id: string }>('SELECT source, external_id FROM campaigns WHERE id = $1 AND business_id = $2', [
    campaignId,
    ctx.businessId,
  ]);
  if (!c) throw new Error('Kampaniya topilmadi');
  let simulated = true;
  if (c.source === 'meta_ads') {
    const meta = await getActiveConnector(ctx.db, ctx.businessId, 'meta_ads');
    if (meta) {
      await metaUpdateCampaign(connectorFetch(), meta.config as MetaConfig, c.external_id, {
        dailyBudgetUzs: update.dailyBudget,
        status: update.status === 'paused' ? 'PAUSED' : update.status === 'active' ? 'ACTIVE' : undefined,
      });
      simulated = false;
    }
  }
  await ctx.db.query(
    `UPDATE campaigns SET daily_budget = COALESCE($2, daily_budget), status = COALESCE($3, status) WHERE id = $1`,
    [campaignId, update.dailyBudget ?? null, update.status ?? null],
  );
  return { platform: c.source, simulated };
}
