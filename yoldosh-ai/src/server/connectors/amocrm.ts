import { createHash } from 'node:crypto';
import {
  ConnectorError,
  fetchJson,
  type ConnectorDefinition,
  type EmployeeRecord,
  type FetchLike,
  type LeadRecord,
  type LeadStatus,
  type NormalizedRecord,
} from './types';

/**
 * amoCRM / Kommo (API v4) — O'zbekistonda eng ko'p ishlatiladigan CRM.
 * - Menejerlar (users), leadlar (bosqich, mas'ul, UTM, sabablar), kontaktlar
 * - Birinchi javob vaqti: chiquvchi qo'ng'iroq/chat hodisalaridan (events)
 * - Webhook: lead qo'shildi/o'zgardi → real vaqtda yangilash
 * - Harakatlar: vazifa yaratish, mas'ulni almashtirish
 */

export interface AmoConfig {
  subdomain: string;
  accessToken: string;
  trialStatusIds?: string;
  segmentFieldId?: string;
}

const WON = 142;
const LOST = 143;

export function amoBase(cfg: AmoConfig): string {
  const s = String(cfg.subdomain).trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${s.includes('.') ? s : `${s}.amocrm.ru`}`;
}

function headers(cfg: AmoConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' };
}

async function amoGet<T = any>(fetchFn: FetchLike, cfg: AmoConfig, path: string): Promise<T | null> {
  // amoCRM bo'sh natija uchun 204 No Content qaytaradi
  return fetchJson<T | null>(fetchFn, `${amoBase(cfg)}${path}`, { headers: headers(cfg) });
}

async function amoGetAll(fetchFn: FetchLike, cfg: AmoConfig, path: string, key: string, maxPages = 40): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await amoGet(fetchFn, cfg, `${path}${sep}page=${page}&limit=250`);
    const items = body?._embedded?.[key] ?? [];
    out.push(...items);
    if (items.length < 250 || !body?._links?.next) break;
  }
  return out;
}

function fieldValue(fields: any[] | null | undefined, match: { code?: string; id?: string | number }): string | null {
  for (const f of fields ?? []) {
    if ((match.code && f.field_code === match.code) || (match.id !== undefined && String(f.field_id) === String(match.id))) {
      const v = f.values?.[0]?.value;
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
  }
  return null;
}

function utmSourceToPlatform(src: string | null): string | null {
  if (!src) return null;
  const s = src.toLowerCase();
  if (s.includes('facebook') || s.includes('instagram') || s === 'fb' || s === 'ig' || s.includes('meta')) return 'meta_ads';
  if (s.includes('telegram') || s === 'tg') return 'telegram_ads';
  if (s.includes('google')) return 'google_ads';
  return null;
}

export interface PipelineInfo {
  firstStatusIds: Set<number>;
  statusNames: Map<number, string>;
  pipelineNames: Map<number, string>;
}

export function parsePipelines(body: any): PipelineInfo {
  const info: PipelineInfo = { firstStatusIds: new Set(), statusNames: new Map(), pipelineNames: new Map() };
  for (const p of body?._embedded?.pipelines ?? []) {
    info.pipelineNames.set(p.id, p.name);
    // type 1 — "Неразобранное" (unsorted); birinchi oddiy bosqich — "yangi"
    const statuses = [...(p._embedded?.statuses ?? [])].sort((a: any, b: any) => a.sort - b.sort);
    const first = statuses.find((s: any) => s.type !== 1 && s.id !== WON && s.id !== LOST);
    for (const s of statuses) {
      info.statusNames.set(s.id, s.name);
      if (s.type === 1) info.firstStatusIds.add(s.id);
    }
    if (first) info.firstStatusIds.add(first.id);
  }
  return info;
}

export function mapAmoLead(
  lead: any,
  contactsById: Map<number, any>,
  pipelines: PipelineInfo,
  cfg: AmoConfig,
  firstResponse?: Date | null,
): LeadRecord {
  const trialIds = new Set(
    String(cfg.trialStatusIds ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  );
  const ts = (u: number | null | undefined) => (u ? new Date(u * 1000) : null);
  let status: LeadStatus = 'contacted';
  if (lead.status_id === WON) status = 'won';
  else if (lead.status_id === LOST) status = 'lost';
  else if (trialIds.has(lead.status_id)) status = 'trial';
  else if (pipelines.firstStatusIds.has(lead.status_id) && !firstResponse) status = 'new';

  const contacts: any[] = lead._embedded?.contacts ?? [];
  const main = contacts.find((c) => c.is_main) ?? contacts[0];
  const contact = main ? contactsById.get(main.id) : undefined;
  const utmCampaign = fieldValue(lead.custom_fields_values, { code: 'UTM_CAMPAIGN' });
  const utmSource = fieldValue(lead.custom_fields_values, { code: 'UTM_SOURCE' });
  const segment = cfg.segmentFieldId ? fieldValue(lead.custom_fields_values, { id: cfg.segmentFieldId }) : null;

  return {
    kind: 'lead',
    source: 'amocrm',
    externalId: String(lead.id),
    contact: {
      name: contact?.name ?? lead.name ?? null,
      phone: fieldValue(contact?.custom_fields_values, { code: 'PHONE' }),
      email: fieldValue(contact?.custom_fields_values, { code: 'EMAIL' }),
      externalIds: main ? [{ kind: 'amocrm_contact', value: String(main.id) }] : [],
    },
    campaignExternalId: utmCampaign,
    campaignName: utmCampaign,
    campaignSource: utmSourceToPlatform(utmSource),
    segment,
    productHint: [lead.name, pipelines.pipelineNames.get(lead.pipeline_id), utmCampaign].filter(Boolean).join(' '),
    status,
    assignedToExternalId: lead.responsible_user_id ? String(lead.responsible_user_id) : null,
    assignedToSource: 'amocrm',
    createdAt: ts(lead.created_at) ?? new Date(),
    firstResponseAt: firstResponse ?? null,
    trialAt: status === 'trial' ? ts(lead.updated_at) : null,
    wonAt: status === 'won' ? ts(lead.closed_at) ?? ts(lead.updated_at) : null,
    lostAt: status === 'lost' ? ts(lead.closed_at) ?? ts(lead.updated_at) : null,
    lostReason: status === 'lost' ? lead._embedded?.loss_reason?.[0]?.name ?? null : null,
    value: lead.price ? Number(lead.price) : null,
  };
}

/** Webhook (x-www-form-urlencoded) dan lead ID'larni ajratib olish: leads[add][0][id]=123 */
export function parseAmoWebhook(rawBody: string): number[] {
  const params = new URLSearchParams(rawBody);
  const ids = new Set<number>();
  for (const [key, value] of params) {
    if (/^leads\[(add|update|status|responsible|restore)\]\[\d+\]\[id\]$/.test(key)) {
      const n = Number(value);
      if (n) ids.add(n);
    }
  }
  return [...ids];
}

async function fetchContacts(fetchFn: FetchLike, cfg: AmoConfig, ids: number[]): Promise<Map<number, any>> {
  const map = new Map<number, any>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const qs = chunk.map((id) => `filter[id][]=${id}`).join('&');
    const body = await amoGet(fetchFn, cfg, `/api/v4/contacts?${qs}&limit=250`);
    for (const c of body?._embedded?.contacts ?? []) map.set(c.id, c);
  }
  return map;
}

/** Birinchi chiquvchi muloqot (qo'ng'iroq / chat) vaqtini leadlar bo'yicha topish. */
async function fetchFirstResponses(fetchFn: FetchLike, cfg: AmoConfig, leads: any[], fromUnix: number): Promise<Map<number, Date>> {
  const contactToLeads = new Map<number, number[]>();
  for (const l of leads) {
    for (const c of l._embedded?.contacts ?? []) {
      contactToLeads.set(c.id, [...(contactToLeads.get(c.id) ?? []), l.id]);
    }
  }
  const created = new Map<number, number>(leads.map((l) => [l.id, l.created_at]));
  const events = await amoGetAll(
    fetchFn,
    cfg,
    `/api/v4/events?filter[type][]=outgoing_call&filter[type][]=outgoing_chat_message&filter[created_at][from]=${fromUnix}`,
    'events',
    20,
  );
  const first = new Map<number, number>();
  for (const e of events) {
    const leadIds = e.entity_type === 'lead' ? [e.entity_id] : e.entity_type === 'contact' ? contactToLeads.get(e.entity_id) ?? [] : [];
    for (const id of leadIds) {
      const c = created.get(id);
      if (c === undefined || e.created_at < c) continue;
      if (!first.has(id) || e.created_at < first.get(id)!) first.set(id, e.created_at);
    }
  }
  return new Map([...first].map(([id, t]) => [id, new Date(t * 1000)]));
}

async function leadsToRecords(fetchFn: FetchLike, cfg: AmoConfig, leads: any[], log: (m: string) => void): Promise<LeadRecord[]> {
  const pipelines = parsePipelines(await amoGet(fetchFn, cfg, '/api/v4/leads/pipelines'));
  const contactIds = [...new Set(leads.flatMap((l) => (l._embedded?.contacts ?? []).map((c: any) => c.id)))];
  const contacts = await fetchContacts(fetchFn, cfg, contactIds);
  let responses = new Map<number, Date>();
  if (leads.length) {
    const from = Math.min(...leads.map((l) => l.created_at));
    try {
      responses = await fetchFirstResponses(fetchFn, cfg, leads, from);
    } catch (err) {
      log(`amoCRM events olinmadi (javob vaqti hisoblanmaydi): ${(err as Error).message}`);
    }
  }
  return leads.map((l) => mapAmoLead(l, contacts, pipelines, cfg, responses.get(l.id) ?? null));
}

export async function amoCreateTasks(
  fetchFn: FetchLike,
  cfg: AmoConfig,
  tasks: Array<{ text: string; leadExternalId?: string | null; responsibleExternalId?: string | null; completeTill: Date }>,
) {
  const body = tasks.map((t) => ({
    text: t.text,
    complete_till: Math.floor(t.completeTill.getTime() / 1000),
    ...(t.leadExternalId ? { entity_id: Number(t.leadExternalId), entity_type: 'leads' } : {}),
    ...(t.responsibleExternalId ? { responsible_user_id: Number(t.responsibleExternalId) } : {}),
  }));
  return fetchJson(fetchFn, `${amoBase(cfg)}/api/v4/tasks`, { method: 'POST', headers: headers(cfg), body: JSON.stringify(body) });
}

export async function amoUpdateLeads(
  fetchFn: FetchLike,
  cfg: AmoConfig,
  updates: Array<{ id: string; responsibleExternalId?: string; statusId?: number }>,
) {
  const body = updates.map((u) => ({
    id: Number(u.id),
    ...(u.responsibleExternalId ? { responsible_user_id: Number(u.responsibleExternalId) } : {}),
    ...(u.statusId ? { status_id: u.statusId } : {}),
  }));
  return fetchJson(fetchFn, `${amoBase(cfg)}/api/v4/leads`, { method: 'PATCH', headers: headers(cfg), body: JSON.stringify(body) });
}

export const amoCrmConnector: ConnectorDefinition = {
  type: 'amocrm',
  label: 'amoCRM / Kommo',
  category: 'sales',
  description:
    "Leadlar, sotuv bosqichlari, menejerlar, yo'qotish sabablari va birinchi javob vaqti avtomatik olinadi. Webhook orqali yangi leadlar darhol keladi. AI vazifa yarata va leadlarni qayta taqsimlay oladi.",
  configFields: [
    { key: 'subdomain', label: 'Subdomen yoki domen', type: 'text', required: true, placeholder: 'edinburg yoki edinburg.kommo.com' },
    { key: 'accessToken', label: 'Uzoq muddatli token', type: 'secret', required: true, help: 'amoCRM → Sozlamalar → Integratsiyalar → Xususiy integratsiya → Long-lived token' },
    { key: 'trialStatusIds', label: '"Sinov darsi" bosqichi ID(lar)i', type: 'text', placeholder: '55123401, 55123402', help: "Vergul bilan. Sinov / uchrashuv bosqichlari" },
    { key: 'segmentFieldId', label: 'Kurs/segment maydoni ID', type: 'text', help: "Ixtiyoriy: kurs nomi saqlanadigan custom field ID" },
  ],
  capabilities: { sync: true, webhook: true, actions: ['create_task', 'reassign_leads'] },

  async test(ctx) {
    const cfg = ctx.config as AmoConfig;
    const acc = await amoGet(ctx.fetch, cfg, '/api/v4/account');
    return { ok: true, message: `Ulandi: ${acc?.name ?? amoBase(cfg)}` };
  },

  async sync(ctx) {
    const cfg = ctx.config as AmoConfig;
    if (!cfg.subdomain || !cfg.accessToken) throw new ConnectorError('subdomain va accessToken majburiy');
    const users = await amoGetAll(ctx.fetch, cfg, '/api/v4/users', 'users', 5);
    const employees: EmployeeRecord[] = users.map((u) => ({
      kind: 'employee',
      source: 'amocrm',
      externalId: String(u.id),
      name: u.name,
      role: 'sales_manager',
    }));
    const from = Number(ctx.connector.cursor?.updatedFrom ?? Math.floor(ctx.now.getTime() / 1000) - 90 * 86400);
    const leads = await amoGetAll(
      ctx.fetch,
      cfg,
      `/api/v4/leads?with=contacts,loss_reason&filter[updated_at][from]=${from}&order[updated_at]=asc`,
      'leads',
    );
    const leadRecords = await leadsToRecords(ctx.fetch, cfg, leads, ctx.log);
    const maxUpdated = leads.reduce((m, l) => Math.max(m, l.updated_at ?? 0), from);
    const records: NormalizedRecord[] = [...employees, ...leadRecords];
    return { records, cursor: { updatedFrom: maxUpdated }, stats: { users: users.length, leads: leads.length } };
  },

  async handleWebhook(ctx, req) {
    const cfg = ctx.config as AmoConfig;
    const ids = parseAmoWebhook(req.rawBody);
    if (ids.length === 0) return { response: { status: 200, body: 'ok' }, handled: true };
    const qs = ids.map((id) => `filter[id][]=${id}`).join('&');
    const body = await amoGet(ctx.fetch, cfg, `/api/v4/leads?with=contacts,loss_reason&${qs}`);
    const records = await leadsToRecords(ctx.fetch, cfg, body?._embedded?.leads ?? [], ctx.log);
    return {
      response: { status: 200, body: 'ok' },
      records,
      eventId: `amo:${createHash('sha1').update(req.rawBody).digest('hex')}`,
      eventType: 'lead_update',
    };
  },
};
