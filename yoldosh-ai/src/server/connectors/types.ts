import type { Db } from '../db';
import type { ConfigField, ConnectorTypeInfo } from '../../shared/types';
import type { ContactInfo } from '../ingest/identity';

/**
 * Connector Layer — har bir platforma o'z ma'lumotini shu normallashtirilgan
 * yozuvlarga aylantiradi. Ingest moduli ularni yagona data modelga yozadi.
 */
export type LeadStatus = 'new' | 'contacted' | 'trial' | 'won' | 'lost';
export type PaymentStatus = 'paid' | 'pending' | 'overdue' | 'refunded' | 'failed';

export interface CampaignRecord {
  kind: 'campaign';
  source: string;
  externalId: string;
  name: string;
  segment?: string | null;
  status?: string;
  dailyBudget?: number | null;
  startedAt?: Date | null;
}

export interface AdMetricsRecord {
  kind: 'ad_metrics';
  source: string;
  campaignExternalId: string;
  campaignName?: string;
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
}

export interface EmployeeRecord {
  kind: 'employee';
  source: string;
  externalId: string;
  name: string;
  role?: string;
  telegramChatId?: string | null;
}

export interface LeadRecord {
  kind: 'lead';
  source: string;
  externalId: string;
  contact: ContactInfo;
  campaignExternalId?: string | null;
  campaignSource?: string | null;
  campaignName?: string | null;
  segment?: string | null;
  productHint?: string | null;
  status?: LeadStatus;
  assignedToExternalId?: string | null;
  assignedToSource?: string | null;
  createdAt: Date;
  firstResponseAt?: Date | null;
  trialAt?: Date | null;
  wonAt?: Date | null;
  lostAt?: Date | null;
  lostReason?: string | null;
  value?: number | null;
}

export interface PaymentRecord {
  kind: 'payment';
  source: string;
  externalId: string;
  contact: ContactInfo;
  amount: number;
  status: PaymentStatus;
  method?: string | null;
  paidAt?: Date | null;
  dueDate?: string | null;
  productHint?: string | null;
}

export interface InteractionRecord {
  kind: 'interaction';
  source: string;
  externalId?: string | null;
  contact: ContactInfo;
  channel: string;
  direction: 'in' | 'out';
  occurredAt: Date;
  summary?: string | null;
  employeeExternalId?: string | null;
  leadExternalId?: string | null;
}

export type NormalizedRecord =
  | CampaignRecord
  | AdMetricsRecord
  | EmployeeRecord
  | LeadRecord
  | PaymentRecord
  | InteractionRecord;

export interface ConnectorRow {
  id: string;
  business_id: string;
  type: string;
  name: string;
  status: string;
  config: Record<string, any>;
  cursor: Record<string, any>;
  last_sync_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ConnectorContext {
  db: Db;
  businessId: string;
  connector: ConnectorRow;
  /** Shifrdan chiqarilgan konfiguratsiya */
  config: Record<string, any>;
  fetch: FetchLike;
  now: Date;
  log: (msg: string) => void;
}

export interface SyncResult {
  records: NormalizedRecord[];
  cursor?: Record<string, any>;
  stats?: Record<string, number>;
}

export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  rawBody: string;
}

export interface WebhookResult {
  /** HTTP javob (masalan Meta verify challenge) */
  response: { status: number; body: string; contentType?: string };
  records?: NormalizedRecord[];
  /** raw_events uchun idempotentlik kaliti */
  eventId?: string;
  eventType?: string;
  /** Maxsus ishlov (masalan Telegram bot xabari) — ingest'dan tashqari */
  handled?: boolean;
}

export interface ConnectorDefinition extends Omit<ConnectorTypeInfo, 'configFields'> {
  configFields: ConfigField[];
  sync?(ctx: ConnectorContext): Promise<SyncResult>;
  handleWebhook?(ctx: ConnectorContext, req: WebhookRequest): Promise<WebhookResult>;
  test?(ctx: ConnectorContext): Promise<{ ok: boolean; message: string }>;
}

export class ConnectorError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Tashqi API'ga JSON so'rov — xatolarni tushunarli qiladi. */
export async function fetchJson<T = any>(fetchFn: FetchLike, url: string, init?: RequestInit): Promise<T> {
  const res = await fetchFn(url, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      (body && typeof body === 'object' && (body.error?.message || body.detail || body.title || body.description)) ||
      (typeof body === 'string' ? body.slice(0, 300) : '');
    throw new ConnectorError(`HTTP ${res.status}: ${detail || res.statusText}`, res.status);
  }
  return body as T;
}
