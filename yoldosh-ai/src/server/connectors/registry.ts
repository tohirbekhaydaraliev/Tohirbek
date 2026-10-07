import type { Db } from '../db';
import type { ConnectorTypeInfo, ConnectorView } from '../../shared/types';
import { config } from '../config';
import { ingestRecords } from '../ingest';
import { errorMessage, newId, now } from '../lib/util';
import { amoCrmConnector } from './amocrm';
import { metaAdsConnector } from './meta';
import { paymentsConnector } from './payments';
import { decryptConfig, encryptConfig, maskConfig } from './secrets';
import { telegramConnector } from './telegram';
import type { ConnectorContext, ConnectorDefinition, ConnectorRow, FetchLike, WebhookRequest, WebhookResult } from './types';

const demoConnector: ConnectorDefinition = {
  type: 'demo',
  label: 'Demo manba',
  category: 'demo',
  description: "Simulyatsiya qilingan ma'lumot manbai (demo biznes uchun). Haqiqiy integratsiyani ulaganingizdan keyin o'chirib qo'yishingiz mumkin.",
  configFields: [],
  capabilities: { sync: false, webhook: false, actions: [] },
};

export const CONNECTORS: Record<string, ConnectorDefinition> = Object.fromEntries(
  [metaAdsConnector, amoCrmConnector, paymentsConnector, telegramConnector, demoConnector].map((c) => [c.type, c]),
);

export function connectorCatalog(): ConnectorTypeInfo[] {
  return Object.values(CONNECTORS)
    .filter((c) => c.type !== 'demo')
    .map(({ type, label, category, description, configFields, capabilities }) => ({ type, label, category, description, configFields, capabilities }));
}

let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Testlar uchun tashqi HTTP'ni almashtirish. */
export function setConnectorFetch(fn: FetchLike | null) {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
}
export function connectorFetch(): FetchLike {
  return fetchImpl;
}

function webhookUrl(row: ConnectorRow): string | null {
  const def = CONNECTORS[row.type];
  if (!def?.capabilities.webhook) return null;
  return `${config.publicUrl}/api/webhooks/${row.type}/${row.id}`;
}

function toView(row: ConnectorRow, lastRun?: any): ConnectorView {
  const def = CONNECTORS[row.type];
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    config: maskConfig(def?.configFields ?? [], row.config),
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    lastError: row.last_error,
    webhookUrl: webhookUrl(row),
    createdAt: new Date(row.created_at).toISOString(),
    lastRun: lastRun
      ? {
          status: lastRun.status,
          stats: lastRun.stats,
          startedAt: new Date(lastRun.started_at).toISOString(),
          finishedAt: lastRun.finished_at ? new Date(lastRun.finished_at).toISOString() : null,
        }
      : null,
  };
}

export async function listConnectors(db: Db, businessId: string): Promise<ConnectorView[]> {
  const rows = await db.query<ConnectorRow>('SELECT * FROM connectors WHERE business_id = $1 ORDER BY created_at', [businessId]);
  const runs = await db.query<any>(
    `SELECT DISTINCT ON (connector_id) * FROM sync_runs WHERE business_id = $1 ORDER BY connector_id, started_at DESC`,
    [businessId],
  );
  return rows.map((r) => toView(r, runs.find((x) => x.connector_id === r.id)));
}

export async function getConnectorRow(db: Db, id: string): Promise<ConnectorRow | undefined> {
  return db.one<ConnectorRow>('SELECT * FROM connectors WHERE id = $1', [id]);
}

/** Action Layer uchun: biznesning shu turdagi faol connectori (shifrdan chiqarilgan konfiguratsiya bilan). */
export async function getActiveConnector(db: Db, businessId: string, type: string) {
  const row = await db.one<ConnectorRow>(
    `SELECT * FROM connectors WHERE business_id = $1 AND type = $2 AND status = 'active' ORDER BY created_at LIMIT 1`,
    [businessId, type],
  );
  if (!row) return null;
  return { row, config: decryptConfig(row.config) };
}

function validateConfig(def: ConnectorDefinition, cfg: Record<string, unknown>) {
  for (const f of def.configFields) {
    if (f.required && (cfg[f.key] === undefined || cfg[f.key] === null || cfg[f.key] === '')) {
      throw new Error(`"${f.label}" majburiy`);
    }
  }
}

export async function createConnector(
  db: Db,
  businessId: string,
  input: { type: string; name?: string; config: Record<string, unknown> },
): Promise<ConnectorView> {
  const def = CONNECTORS[input.type];
  if (!def || def.type === 'demo') throw new Error(`Noma'lum connector turi: ${input.type}`);
  const cfg: Record<string, unknown> = {};
  for (const f of def.configFields) {
    const v = input.config[f.key] ?? f.default;
    if (v !== undefined && v !== '') cfg[f.key] = v;
  }
  validateConfig(def, cfg);
  const id = newId('con');
  await db.query(`INSERT INTO connectors (id, business_id, type, name, status, config) VALUES ($1,$2,$3,$4,'active',$5)`, [
    id,
    businessId,
    def.type,
    input.name || def.label,
    encryptConfig(def.configFields, cfg),
  ]);
  return toView((await getConnectorRow(db, id))!);
}

export async function updateConnector(
  db: Db,
  businessId: string,
  id: string,
  patch: { name?: string; status?: string; config?: Record<string, unknown> },
): Promise<ConnectorView> {
  const row = await getConnectorRow(db, id);
  if (!row || row.business_id !== businessId) throw new Error('Connector topilmadi');
  const def = CONNECTORS[row.type];
  let cfg = row.config;
  if (patch.config && def) {
    const merged: Record<string, unknown> = { ...row.config };
    for (const f of def.configFields) {
      const v = patch.config[f.key];
      // Bo'sh yoki maskalangan maxfiy maydon — eski qiymat saqlanadi
      if (v === undefined || (f.type === 'secret' && (v === '' || String(v).startsWith('••')))) continue;
      merged[f.key] = v;
    }
    validateConfig(def, decryptConfig(merged));
    cfg = encryptConfig(def.configFields, merged);
  }
  await db.query(`UPDATE connectors SET name = $2, status = $3, config = $4 WHERE id = $1`, [
    id,
    patch.name ?? row.name,
    patch.status ?? row.status,
    cfg,
  ]);
  return toView((await getConnectorRow(db, id))!);
}

export async function deleteConnector(db: Db, businessId: string, id: string): Promise<void> {
  await db.query('DELETE FROM connectors WHERE business_id = $1 AND id = $2', [businessId, id]);
}

function makeContext(db: Db, row: ConnectorRow, logs: string[]): ConnectorContext {
  return {
    db,
    businessId: row.business_id,
    connector: row,
    config: decryptConfig(row.config),
    fetch: fetchImpl,
    now: now(),
    log: (m) => logs.push(m),
  };
}

export async function testConnector(db: Db, businessId: string, id: string) {
  const row = await getConnectorRow(db, id);
  if (!row || row.business_id !== businessId) throw new Error('Connector topilmadi');
  const def = CONNECTORS[row.type];
  if (!def?.test) return { ok: true, message: 'Tekshiruv talab qilinmaydi' };
  try {
    return await def.test(makeContext(db, row, []));
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/** Connector'dan ma'lumot olib (API pull), yagona modelga yozadi. */
export async function runSync(db: Db, connectorId: string, trigger: 'schedule' | 'manual' = 'manual') {
  const row = await getConnectorRow(db, connectorId);
  if (!row) throw new Error('Connector topilmadi');
  const def = CONNECTORS[row.type];
  if (!def?.sync) return { ok: true, skipped: true, stats: {} };
  const runId = newId('syn');
  await db.query(`INSERT INTO sync_runs (id, business_id, connector_id, trigger) VALUES ($1,$2,$3,$4)`, [runId, row.business_id, row.id, trigger]);
  const logs: string[] = [];
  try {
    const result = await def.sync(makeContext(db, row, logs));
    const ingested = await db.tx((tx) => ingestRecords(tx, row.business_id, result.records));
    const stats = { ...(result.stats ?? {}), ...Object.fromEntries(Object.entries(ingested).map(([k, v]) => [`ingested_${k}`, v])) };
    await db.query(`UPDATE connectors SET cursor = $2, last_sync_at = now(), last_error = NULL WHERE id = $1`, [row.id, result.cursor ?? row.cursor]);
    await db.query(`UPDATE sync_runs SET status = 'success', stats = $2, finished_at = now() WHERE id = $1`, [runId, { ...stats, logs }]);
    return { ok: true, stats };
  } catch (err) {
    const msg = errorMessage(err);
    await db.query(`UPDATE connectors SET last_error = $2 WHERE id = $1`, [row.id, msg]);
    await db.query(`UPDATE sync_runs SET status = 'error', error = $2, finished_at = now(), stats = $3 WHERE id = $1`, [runId, msg, { logs }]);
    return { ok: false, error: msg, stats: {} };
  }
}

export async function syncAll(db: Db, businessId?: string) {
  const rows = await db.query<ConnectorRow>(
    `SELECT * FROM connectors WHERE status = 'active' AND ($1::text IS NULL OR business_id = $1)`,
    [businessId ?? null],
  );
  const results = [];
  for (const r of rows) {
    if (CONNECTORS[r.type]?.sync) results.push({ id: r.id, ...(await runSync(db, r.id, 'schedule')) });
  }
  return results;
}

export interface WebhookOutcome {
  result: WebhookResult;
  row: ConnectorRow;
  duplicate?: boolean;
  ingested?: Record<string, number>;
}

/** Webhook (push): imzo tekshiruvi → raw_events inbox (idempotent) → ingest. */
export async function handleWebhook(db: Db, type: string, connectorId: string, req: WebhookRequest): Promise<WebhookOutcome> {
  const row = await getConnectorRow(db, connectorId);
  if (!row || row.type !== type || row.status !== 'active') {
    return { row: row as ConnectorRow, result: { response: { status: 404, body: 'connector topilmadi' }, handled: true } };
  }
  const def = CONNECTORS[type];
  if (!def?.handleWebhook) return { row, result: { response: { status: 404, body: 'webhook qo‘llab-quvvatlanmaydi' }, handled: true } };
  const result = await def.handleWebhook(makeContext(db, row, []), req);
  if (!result.records?.length) return { row, result };

  const eventId = result.eventId ?? newId('evt');
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO raw_events (id, business_id, connector_id, source, event_type, external_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (business_id, source, external_id) DO NOTHING RETURNING id`,
    [newId('raw'), row.business_id, row.id, type, result.eventType ?? 'event', eventId, { body: req.rawBody.slice(0, 50_000) }],
  );
  if (inserted.length === 0) return { row, result, duplicate: true };
  try {
    const ingested = await db.tx((tx) => ingestRecords(tx, row.business_id, result.records!));
    await db.query(`UPDATE raw_events SET status = 'processed', processed_at = now() WHERE id = $1`, [inserted[0].id]);
    return { row, result, ingested };
  } catch (err) {
    await db.query(`UPDATE raw_events SET status = 'error', error = $2 WHERE id = $1`, [inserted[0].id, errorMessage(err)]);
    throw err;
  }
}
