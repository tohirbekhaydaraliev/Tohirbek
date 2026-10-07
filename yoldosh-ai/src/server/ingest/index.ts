import type { Db } from '../db';
import { newId } from '../lib/util';
import type {
  AdMetricsRecord,
  CampaignRecord,
  EmployeeRecord,
  InteractionRecord,
  LeadRecord,
  NormalizedRecord,
  PaymentRecord,
} from '../connectors/types';
import { resolveCustomer } from './identity';

/**
 * Ingest — normallashtirilgan yozuvlarni yagona data modelga yozadi.
 * Tartib muhim: xodimlar → kampaniyalar → reklama metrikalari → leadlar → to'lovlar → muloqotlar.
 */

export interface IngestStats {
  [kind: string]: number;
}

interface ProductInfo {
  id: string;
  name: string;
  segment: string;
  price: number;
  keywords: string[];
}

class IngestContext {
  private products: ProductInfo[] | null = null;
  private employeeCache = new Map<string, string | null>();
  private campaignCache = new Map<string, string | null>();

  constructor(readonly db: Db, readonly businessId: string) {}

  async getProducts(): Promise<ProductInfo[]> {
    if (!this.products) {
      this.products = await this.db.query<ProductInfo>(
        'SELECT id, name, segment, price, keywords FROM products WHERE business_id = $1 AND active',
        [this.businessId],
      );
    }
    return this.products;
  }

  /** Matndan (kampaniya nomi, kurs nomi) segmentni aniqlash: "IELTS September" → IELTS */
  async inferProduct(text: string | null | undefined): Promise<ProductInfo | null> {
    if (!text) return null;
    const t = text.toLowerCase();
    const products = await this.getProducts();
    // Eng uzun mos kelgan kalit so'z g'olib: "Kids English" → Kids (General English emas)
    let best: { product: ProductInfo; len: number } | null = null;
    for (const p of products) {
      const needles = [p.segment, p.name, ...(p.keywords ?? [])].map((s) => s.toLowerCase()).filter(Boolean);
      for (const n of needles) {
        if (t.includes(n) && (!best || n.length > best.len)) best = { product: p, len: n.length };
      }
    }
    return best?.product ?? null;
  }

  async productBySegment(segment: string | null | undefined): Promise<ProductInfo | null> {
    if (!segment) return null;
    const products = await this.getProducts();
    return products.find((p) => p.segment.toLowerCase() === segment.toLowerCase()) ?? (await this.inferProduct(segment));
  }

  async employeeId(source: string | null | undefined, externalId: string | null | undefined): Promise<string | null> {
    if (!externalId) return null;
    const key = `${source}:${externalId}`;
    if (this.employeeCache.has(key)) return this.employeeCache.get(key)!;
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM employees WHERE business_id = $1 AND ((source = $2 AND external_id = $3) OR id = $3) LIMIT 1`,
      [this.businessId, source ?? 'internal', externalId],
    );
    this.employeeCache.set(key, row?.id ?? null);
    return row?.id ?? null;
  }

  async campaignId(source: string | null | undefined, externalId: string | null | undefined, name?: string | null) {
    const key = `${source}:${externalId}:${name}`;
    if (this.campaignCache.has(key)) return this.campaignCache.get(key)!;
    let row: { id: string } | undefined;
    if (externalId) {
      row = await this.db.one<{ id: string }>(
        `SELECT id FROM campaigns WHERE business_id = $1 AND external_id = $2 AND ($3::text IS NULL OR source = $3) LIMIT 1`,
        [this.businessId, externalId, source ?? null],
      );
    }
    if (!row && name) {
      row = await this.db.one<{ id: string }>(
        `SELECT id FROM campaigns WHERE business_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [this.businessId, name],
      );
    }
    this.campaignCache.set(key, row?.id ?? null);
    return row?.id ?? null;
  }

  invalidateCampaigns() {
    this.campaignCache.clear();
  }
}

async function ingestEmployee(ctx: IngestContext, r: EmployeeRecord) {
  await ctx.db.query(
    `INSERT INTO employees (id, business_id, name, role, telegram_chat_id, source, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id, source, external_id) DO UPDATE SET
       name = EXCLUDED.name,
       role = COALESCE(EXCLUDED.role, employees.role),
       telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, employees.telegram_chat_id)`,
    [newId('emp'), ctx.businessId, r.name, r.role ?? 'sales_manager', r.telegramChatId ?? null, r.source, r.externalId],
  );
}

async function ingestCampaign(ctx: IngestContext, r: CampaignRecord) {
  const segment = r.segment ?? (await ctx.inferProduct(r.name))?.segment ?? null;
  await ctx.db.query(
    `INSERT INTO campaigns (id, business_id, source, external_id, name, segment, status, daily_budget, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (business_id, source, external_id) DO UPDATE SET
       name = EXCLUDED.name,
       segment = COALESCE(campaigns.segment, EXCLUDED.segment),
       status = EXCLUDED.status,
       daily_budget = COALESCE(EXCLUDED.daily_budget, campaigns.daily_budget),
       started_at = COALESCE(campaigns.started_at, EXCLUDED.started_at)`,
    [newId('cmp'), ctx.businessId, r.source, r.externalId, r.name, segment, r.status ?? 'active', r.dailyBudget ?? null, r.startedAt ?? null],
  );
  ctx.invalidateCampaigns();
}

async function ingestAdMetrics(ctx: IngestContext, r: AdMetricsRecord) {
  let campaignId = await ctx.campaignId(r.source, r.campaignExternalId);
  if (!campaignId) {
    await ingestCampaign(ctx, {
      kind: 'campaign',
      source: r.source,
      externalId: r.campaignExternalId,
      name: r.campaignName ?? `Kampaniya ${r.campaignExternalId}`,
    });
    campaignId = await ctx.campaignId(r.source, r.campaignExternalId);
  }
  await ctx.db.query(
    `INSERT INTO ad_metrics_daily (campaign_id, business_id, date, spend, impressions, clicks, leads)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (campaign_id, date) DO UPDATE SET
       spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, leads = EXCLUDED.leads`,
    [campaignId, ctx.businessId, r.date, Math.round(r.spend), r.impressions, r.clicks, r.leads],
  );
}

async function ensureSubscriptionForWonLead(
  ctx: IngestContext,
  lead: { id: string; customer_id: string; product_id: string | null; assigned_to: string | null; won_at: Date | null; value: number | null },
) {
  if (!lead.won_at) return;
  const existing = await ctx.db.one('SELECT id FROM subscriptions WHERE lead_id = $1', [lead.id]);
  if (existing) return;
  const product = lead.product_id
    ? await ctx.db.one<{ price: number }>('SELECT price FROM products WHERE id = $1', [lead.product_id])
    : undefined;
  await ctx.db.query(
    `INSERT INTO subscriptions (id, business_id, customer_id, product_id, lead_id, sold_by, status, price, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
    [newId('sub'), ctx.businessId, lead.customer_id, lead.product_id, lead.id, lead.assigned_to, lead.value ?? product?.price ?? 0, lead.won_at],
  );
}

async function ingestLead(ctx: IngestContext, r: LeadRecord) {
  const campaignId = await ctx.campaignId(r.campaignSource ?? null, r.campaignExternalId ?? null, r.campaignName ?? null);
  let product = await ctx.productBySegment(r.segment);
  if (!product) product = await ctx.inferProduct(r.productHint ?? r.campaignName ?? null);
  if (!product && campaignId) {
    const seg = await ctx.db.one<{ segment: string | null }>('SELECT segment FROM campaigns WHERE id = $1', [campaignId]);
    product = await ctx.productBySegment(seg?.segment);
  }
  const { customerId } = await resolveCustomer(
    ctx.db,
    ctx.businessId,
    { ...r.contact, externalIds: [...(r.contact.externalIds ?? []), { kind: `${r.source}_lead`, value: r.externalId }] },
    { source: r.source, seenAt: r.createdAt, campaignId },
  );
  const assignedTo = await ctx.employeeId(r.assignedToSource ?? r.source, r.assignedToExternalId ?? null);
  const status = r.status ?? (r.wonAt ? 'won' : r.lostAt ? 'lost' : r.trialAt ? 'trial' : r.firstResponseAt ? 'contacted' : 'new');

  const row = await ctx.db.one<{
    id: string;
    customer_id: string;
    product_id: string | null;
    assigned_to: string | null;
    won_at: Date | null;
    value: number | null;
  }>(
    `INSERT INTO leads (id, business_id, customer_id, campaign_id, product_id, segment, source, external_id, status,
        assigned_to, created_at, first_response_at, trial_at, won_at, lost_at, lost_reason, value, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     ON CONFLICT (business_id, source, external_id) DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       campaign_id = COALESCE(EXCLUDED.campaign_id, leads.campaign_id),
       product_id = COALESCE(EXCLUDED.product_id, leads.product_id),
       segment = COALESCE(EXCLUDED.segment, leads.segment),
       status = EXCLUDED.status,
       assigned_to = COALESCE(EXCLUDED.assigned_to, leads.assigned_to),
       first_response_at = COALESCE(leads.first_response_at, EXCLUDED.first_response_at),
       trial_at = COALESCE(EXCLUDED.trial_at, leads.trial_at),
       won_at = COALESCE(EXCLUDED.won_at, leads.won_at),
       lost_at = COALESCE(EXCLUDED.lost_at, leads.lost_at),
       lost_reason = COALESCE(EXCLUDED.lost_reason, leads.lost_reason),
       value = COALESCE(EXCLUDED.value, leads.value),
       updated_at = now()
     RETURNING id, customer_id, product_id, assigned_to, won_at, value`,
    [
      newId('led'),
      ctx.businessId,
      customerId,
      campaignId,
      product?.id ?? null,
      product?.segment ?? r.segment ?? null,
      r.source,
      r.externalId,
      status,
      assignedTo,
      r.createdAt,
      r.firstResponseAt ?? null,
      r.trialAt ?? null,
      r.wonAt ?? null,
      r.lostAt ?? null,
      r.lostReason ?? null,
      r.value ?? null,
    ],
  );
  if (row && status === 'won') await ensureSubscriptionForWonLead(ctx, row);
}

async function ingestPayment(ctx: IngestContext, r: PaymentRecord) {
  const { customerId } = await resolveCustomer(ctx.db, ctx.businessId, r.contact, {
    source: r.source,
    seenAt: r.paidAt ?? undefined,
  });
  let sub = await ctx.db.one<{ id: string }>(
    `SELECT id FROM subscriptions WHERE customer_id = $1 ORDER BY (status = 'active') DESC, started_at DESC LIMIT 1`,
    [customerId],
  );
  const prevPaid = await ctx.db.one<{ n: number }>(
    `SELECT count(*) AS n FROM payments WHERE customer_id = $1 AND status = 'paid' AND external_id <> $2`,
    [customerId, r.externalId],
  );
  const kind = (prevPaid?.n ?? 0) === 0 ? 'new' : 'renewal';

  // To'lov tizimidan kelgan yangi mijoz to'lovi = sotuv (CRM bo'lmasa ham)
  if (!sub && r.status === 'paid') {
    const product = await ctx.inferProduct(r.productHint ?? null);
    if (product) {
      const subId = newId('sub');
      await ctx.db.query(
        `INSERT INTO subscriptions (id, business_id, customer_id, product_id, status, price, started_at)
         VALUES ($1,$2,$3,$4,'active',$5,$6)`,
        [subId, ctx.businessId, customerId, product.id, r.amount, r.paidAt ?? new Date()],
      );
      sub = { id: subId };
    }
  }

  await ctx.db.query(
    `INSERT INTO payments (id, business_id, customer_id, subscription_id, amount, method, status, kind, due_date, paid_at, source, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (business_id, source, external_id) DO UPDATE SET
       status = EXCLUDED.status,
       amount = EXCLUDED.amount,
       paid_at = COALESCE(EXCLUDED.paid_at, payments.paid_at),
       due_date = COALESCE(EXCLUDED.due_date, payments.due_date),
       method = COALESCE(EXCLUDED.method, payments.method)`,
    [
      newId('pay'),
      ctx.businessId,
      customerId,
      sub?.id ?? null,
      Math.round(r.amount),
      r.method ?? null,
      r.status,
      kind,
      r.dueDate ?? null,
      r.paidAt ?? null,
      r.source,
      r.externalId,
    ],
  );
}

async function ingestInteraction(ctx: IngestContext, r: InteractionRecord) {
  const lead = r.leadExternalId
    ? await ctx.db.one<{ id: string; customer_id: string; created_at: Date; first_response_at: Date | null }>(
        `SELECT id, customer_id, created_at, first_response_at FROM leads WHERE business_id = $1 AND source = $2 AND external_id = $3`,
        [ctx.businessId, r.source, r.leadExternalId],
      )
    : undefined;
  const customerId = lead
    ? lead.customer_id
    : (await resolveCustomer(ctx.db, ctx.businessId, r.contact, { source: r.source, seenAt: r.occurredAt })).customerId;
  const employeeId = await ctx.employeeId(r.source, r.employeeExternalId ?? null);
  await ctx.db.query(
    `INSERT INTO interactions (id, business_id, customer_id, lead_id, employee_id, channel, direction, occurred_at, summary, source, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING`,
    [newId('int'), ctx.businessId, customerId, lead?.id ?? null, employeeId, r.channel, r.direction, r.occurredAt, r.summary ?? null, r.source, r.externalId ?? null],
  );
  // Chiquvchi birinchi muloqot = leadga birinchi javob
  if (lead && r.direction === 'out' && !lead.first_response_at && r.occurredAt >= lead.created_at) {
    await ctx.db.query(
      `UPDATE leads SET first_response_at = $2, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = now()
        WHERE id = $1 AND first_response_at IS NULL`,
      [lead.id, r.occurredAt],
    );
  }
}

const ORDER: NormalizedRecord['kind'][] = ['employee', 'campaign', 'ad_metrics', 'lead', 'payment', 'interaction'];

export async function ingestRecords(db: Db, businessId: string, records: NormalizedRecord[]): Promise<IngestStats> {
  const ctx = new IngestContext(db, businessId);
  const stats: IngestStats = {};
  const sorted = [...records].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  for (const r of sorted) {
    switch (r.kind) {
      case 'employee':
        await ingestEmployee(ctx, r);
        break;
      case 'campaign':
        await ingestCampaign(ctx, r);
        break;
      case 'ad_metrics':
        await ingestAdMetrics(ctx, r);
        break;
      case 'lead':
        await ingestLead(ctx, r);
        break;
      case 'payment':
        await ingestPayment(ctx, r);
        break;
      case 'interaction':
        await ingestInteraction(ctx, r);
        break;
    }
    stats[r.kind] = (stats[r.kind] ?? 0) + 1;
  }
  return stats;
}
