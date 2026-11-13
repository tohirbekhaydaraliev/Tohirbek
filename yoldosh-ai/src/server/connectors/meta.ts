import { createHmac, timingSafeEqual } from 'node:crypto';
import { isoDate, addDays } from '../lib/util';
import {
  ConnectorError,
  fetchJson,
  type AdMetricsRecord,
  type CampaignRecord,
  type ConnectorDefinition,
  type FetchLike,
  type LeadRecord,
  type NormalizedRecord,
} from './types';

/**
 * Meta Marketing API (Facebook / Instagram reklama).
 * - Kampaniyalar va kunlik insights (spend, impressions, clicks, leads)
 * - Lead Ads: `leadgen` webhook → lead ma'lumotini Graph API'dan olish
 * - Harakatlar: kampaniya byudjetini o'zgartirish, pauza
 */

const LEAD_ACTION_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped', 'offsite_conversion.fb_pixel_lead'];

export interface MetaConfig {
  accessToken: string;
  adAccountId: string;
  apiVersion?: string;
  currencyRate?: number | string;
  appSecret?: string;
  verifyToken?: string;
}

function base(cfg: MetaConfig) {
  return `https://graph.facebook.com/${cfg.apiVersion || 'v24.0'}`;
}

function account(cfg: MetaConfig) {
  const id = String(cfg.adAccountId).trim();
  return id.startsWith('act_') ? id : `act_${id}`;
}

function rate(cfg: MetaConfig) {
  const r = Number(cfg.currencyRate ?? 1);
  return Number.isFinite(r) && r > 0 ? r : 1;
}

async function getAllPages<T>(fetchFn: FetchLike, url: string, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  for (let i = 0; next && i < maxPages; i++) {
    const page: { data?: T[]; paging?: { next?: string } } = await fetchJson(fetchFn, next);
    out.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
  }
  return out;
}

/** Insights qatoridagi lead sonini aniqlash (bir-birini qoplaydigan turlar — eng kattasi olinadi). */
export function leadsFromActions(actions: Array<{ action_type: string; value: string }> | undefined): number {
  if (!actions) return 0;
  let best = 0;
  for (const a of actions) {
    if (LEAD_ACTION_TYPES.includes(a.action_type)) best = Math.max(best, Number(a.value) || 0);
  }
  return best;
}

export function mapInsightRow(row: any, currencyRate: number): AdMetricsRecord {
  return {
    kind: 'ad_metrics',
    source: 'meta_ads',
    campaignExternalId: String(row.campaign_id),
    campaignName: row.campaign_name,
    date: row.date_start,
    spend: Math.round(Number(row.spend ?? 0) * currencyRate),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    leads: leadsFromActions(row.actions),
  };
}

export function mapCampaign(c: any, currencyRate: number): CampaignRecord {
  const status = String(c.effective_status ?? c.status ?? 'ACTIVE').toUpperCase();
  return {
    kind: 'campaign',
    source: 'meta_ads',
    externalId: String(c.id),
    name: c.name,
    status: status === 'ACTIVE' ? 'active' : status === 'PAUSED' ? 'paused' : status.toLowerCase(),
    // daily_budget hisob valyutasining kichik birligida (masalan, sentda)
    dailyBudget: c.daily_budget ? Math.round((Number(c.daily_budget) / 100) * currencyRate) : null,
    startedAt: c.start_time ? new Date(c.start_time) : null,
  };
}

/** Lead Ads `field_data` → kontakt */
export function mapLeadgen(lead: any): LeadRecord {
  const fields: Record<string, string> = {};
  for (const f of lead.field_data ?? []) fields[String(f.name).toLowerCase()] = (f.values ?? [])[0] ?? '';
  const name = fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(' ') || null;
  return {
    kind: 'lead',
    source: 'meta_ads',
    externalId: String(lead.id),
    contact: {
      name,
      phone: fields.phone_number || fields.phone || null,
      email: fields.email || null,
      externalIds: [{ kind: 'meta_lead', value: String(lead.id) }],
    },
    campaignExternalId: lead.campaign_id ? String(lead.campaign_id) : null,
    campaignSource: 'meta_ads',
    productHint: lead.campaign_name ?? null,
    createdAt: lead.created_time ? new Date(lead.created_time) : new Date(),
    status: 'new',
  };
}

export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice('sha256='.length);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Kampaniyani yangilash: byudjet (so'mda beriladi) yoki status. */
export async function metaUpdateCampaign(
  fetchFn: FetchLike,
  cfg: MetaConfig,
  campaignExternalId: string,
  update: { dailyBudgetUzs?: number; status?: 'PAUSED' | 'ACTIVE' },
) {
  const body = new URLSearchParams({ access_token: cfg.accessToken });
  if (update.dailyBudgetUzs !== undefined) {
    body.set('daily_budget', String(Math.round((update.dailyBudgetUzs / rate(cfg)) * 100)));
  }
  if (update.status) body.set('status', update.status);
  return fetchJson(fetchFn, `${base(cfg)}/${campaignExternalId}`, { method: 'POST', body });
}

export const metaAdsConnector: ConnectorDefinition = {
  type: 'meta_ads',
  label: 'Meta Ads (Facebook / Instagram)',
  category: 'marketing',
  description:
    "Kampaniyalar, kunlik xarajat, ko'rishlar, kliklar va leadlar Marketing API orqali avtomatik olinadi. Lead Ads leadlari webhook orqali real vaqtda keladi. AI tasdiq bilan byudjetni o'zgartira yoki kampaniyani to'xtata oladi.",
  configFields: [
    { key: 'accessToken', label: 'Access token (System User)', type: 'secret', required: true, help: 'Business Manager → System Users → ads_read, ads_management, leads_retrieval ruxsatlari' },
    { key: 'adAccountId', label: 'Ad account ID', type: 'text', required: true, placeholder: 'act_1234567890' },
    { key: 'currencyRate', label: "Valyuta kursi (1 hisob valyutasi = ? so'm)", type: 'number', default: '12800', help: "Masalan USD hisob uchun 12800" },
    { key: 'apiVersion', label: 'Graph API versiyasi', type: 'text', default: 'v24.0' },
    { key: 'appSecret', label: 'App secret (webhook imzosini tekshirish)', type: 'secret' },
    { key: 'verifyToken', label: 'Webhook verify token', type: 'text', help: 'Meta App → Webhooks → Page → leadgen obunasida shu tokenni kiriting' },
  ],
  capabilities: { sync: true, webhook: true, actions: ['change_campaign_budget', 'pause_campaign'] },

  async test(ctx) {
    const cfg = ctx.config as MetaConfig;
    const acc = await fetchJson(ctx.fetch, `${base(cfg)}/${account(cfg)}?fields=name,currency,account_status&access_token=${encodeURIComponent(cfg.accessToken)}`);
    return { ok: true, message: `Ulandi: ${acc.name} (${acc.currency})` };
  },

  async sync(ctx) {
    const cfg = ctx.config as MetaConfig;
    if (!cfg.accessToken || !cfg.adAccountId) throw new ConnectorError('accessToken va adAccountId majburiy');
    const token = encodeURIComponent(cfg.accessToken);
    const r = rate(cfg);
    // Atributsiya yangilanishi uchun oxirgi 7 kun qayta olinadi; birinchi marta — 90 kun
    const since = ctx.connector.cursor?.lastDate
      ? isoDate(addDays(new Date(ctx.connector.cursor.lastDate), -7))
      : isoDate(addDays(ctx.now, -90));
    const until = isoDate(ctx.now);

    const campaigns = await getAllPages<any>(
      ctx.fetch,
      `${base(cfg)}/${account(cfg)}/campaigns?fields=id,name,status,effective_status,daily_budget,start_time&limit=200&access_token=${token}`,
    );
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const insights = await getAllPages<any>(
      ctx.fetch,
      `${base(cfg)}/${account(cfg)}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions&time_increment=1&time_range=${timeRange}&limit=500&access_token=${token}`,
    );
    const records: NormalizedRecord[] = [...campaigns.map((c) => mapCampaign(c, r)), ...insights.map((row) => mapInsightRow(row, r))];
    return { records, cursor: { lastDate: until }, stats: { campaigns: campaigns.length, insightRows: insights.length } };
  },

  async handleWebhook(ctx, req) {
    const cfg = ctx.config as MetaConfig;
    if (req.method === 'GET') {
      // Meta webhook tasdiqlash (verify challenge)
      if (req.query['hub.mode'] === 'subscribe' && cfg.verifyToken && req.query['hub.verify_token'] === cfg.verifyToken) {
        return { response: { status: 200, body: req.query['hub.challenge'] ?? '', contentType: 'text/plain' }, handled: true };
      }
      return { response: { status: 403, body: 'verify token mos emas' }, handled: true };
    }
    if (cfg.appSecret && !verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'], cfg.appSecret)) {
      return { response: { status: 401, body: 'imzo noto‘g‘ri' }, handled: true };
    }
    const payload = JSON.parse(req.rawBody || '{}');
    const leadIds: string[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'leadgen' && change.value?.leadgen_id) leadIds.push(String(change.value.leadgen_id));
      }
    }
    const records: NormalizedRecord[] = [];
    for (const id of leadIds) {
      const lead = await fetchJson(
        ctx.fetch,
        `${base(cfg)}/${id}?fields=id,created_time,field_data,ad_id,adset_id,campaign_id,campaign_name,form_id,platform&access_token=${encodeURIComponent(cfg.accessToken)}`,
      );
      records.push(mapLeadgen(lead));
    }
    return {
      response: { status: 200, body: 'EVENT_RECEIVED', contentType: 'text/plain' },
      records,
      eventId: leadIds.length ? `leadgen:${leadIds.join(',')}` : undefined,
      eventType: 'leadgen',
    };
  },
};
