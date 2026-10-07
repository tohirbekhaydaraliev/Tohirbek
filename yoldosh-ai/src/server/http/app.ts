import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Db } from '../db';
import { config } from '../config';
import { actionCatalog } from '../actions/registry';
import {
  ActionValidationError,
  approveAction,
  getAction,
  ignoreAction,
  listActions,
  proposeAction,
  rejectAction,
} from '../actions/service';
import { chat, type ChatEvent } from '../agents/chat';
import { createConversation, deleteConversation, getConversation, listConversations } from '../agents/conversations';
import { aiEnabled } from '../agents/llm';
import { handleTelegramUpdate, setTelegramWebhook } from '../bot/telegram';
import { loadBrainContext } from '../brain/context';
import { getCustomer360, searchCustomers } from '../brain/customer360';
import { detectorCatalog, listFindings, refreshFindings } from '../brain/detectors';
import { kpiSnapshot } from '../brain/kpis';
import { scoreOpenLeads } from '../brain/scoring';
import { getDiagnosis, latestDiagnosis, listDiagnoses, runDiagnosis } from '../brain/service';
import { getBusiness, listBusinesses, updateBusiness } from '../context/business';
import { deleteRule, listRules, runRules, upsertRule } from '../context/rules';
import { deleteTarget, listTargets, METRIC_CATALOG, upsertTarget } from '../context/targets';
import { CSV_TEMPLATES, csvToRecords, type CsvKind } from '../connectors/csv';
import {
  connectorCatalog,
  createConnector,
  deleteConnector,
  getConnectorRow,
  handleWebhook,
  listConnectors,
  runSync,
  testConnector,
  updateConnector,
} from '../connectors/registry';
import { decryptConfig } from '../connectors/secrets';
import type { TelegramConfig } from '../connectors/telegram';
import { DEMO_BUSINESS_ID, resetDemo, seedDemo } from '../demo/seed';
import { decisionHistory, evaluateDueOutcomes, learningStats } from '../feedback/outcomes';
import { ingestRecords } from '../ingest';
import * as q from '../metrics/queries';
import { comparisonRanges, errorMessage } from '../lib/util';

type Env = { Variables: { businessId: string } };

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function tokenOk(header: string | undefined): boolean {
  if (!config.apiToken) return true;
  const got = header?.replace(/^Bearer\s+/i, '') ?? '';
  return got.length === config.apiToken.length && timingSafeEqual(Buffer.from(got), Buffer.from(config.apiToken));
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

const daysParam = (c: Context, fallback = 30) => {
  const v = Number(c.req.query('days'));
  return Number.isFinite(v) && v >= 1 && v <= 365 ? Math.round(v) : fallback;
};

export function createApp(db: Db) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : err instanceof ActionValidationError ? 400 : 500;
    if (status === 500) console.error('[api]', err);
    return c.json({ error: errorMessage(err) }, status as 400 | 401 | 404 | 500);
  });

  // ---------- Ochiq endpointlar ----------
  app.get('/api/health', (c) => c.json({ ok: true, db: db.kind }));

  // Webhooklar: o'z imzo/token tekshiruviga ega (Meta, amoCRM, to'lovlar, Telegram)
  app.on(['GET', 'POST'], '/api/webhooks/:type/:connectorId', async (c) => {
    const type = c.req.param('type');
    const connectorId = c.req.param('connectorId');
    const rawBody = c.req.method === 'POST' ? await c.req.text() : '';
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const outcome = await handleWebhook(db, type, connectorId, { method: c.req.method, headers, query: c.req.query(), rawBody });
    if (type === 'telegram' && outcome.result.payload && outcome.row) {
      const cfg = decryptConfig(outcome.row.config) as TelegramConfig;
      // Telegram 60 soniyada javob kutadi — bot javobini fon rejimida yuboramiz
      void handleTelegramUpdate(db, outcome.row, cfg, outcome.result.payload).catch((err) => console.error('[telegram]', errorMessage(err)));
    }
    const { status, body: resBody, contentType } = outcome.result.response;
    return c.body(resBody, status as 200, { 'Content-Type': contentType ?? 'text/plain; charset=utf-8' });
  });

  // ---------- Autentifikatsiya va biznes tanlash ----------
  app.use('/api/*', async (c, next) => {
    if (!tokenOk(c.req.header('authorization'))) return c.json({ error: 'Avtorizatsiya talab qilinadi' }, 401);
    const requested = c.req.header('x-business-id') ?? c.req.query('businessId');
    const businesses = await listBusinesses(db);
    const b = businesses.find((x) => x.id === requested) ?? businesses[0];
    if (!b && !c.req.path.startsWith('/api/meta') && !c.req.path.startsWith('/api/demo')) {
      return c.json({ error: "Biznes yo'q. Demo ma'lumotlarni yuklang: POST /api/demo/reset" }, 404);
    }
    c.set('businessId', b?.id ?? '');
    await next();
  });

  app.get('/api/meta', async (c) =>
    c.json({
      aiEnabled: aiEnabled(),
      model: aiEnabled() ? config.model : null,
      authRequired: !!config.apiToken,
      publicUrl: config.publicUrl,
      businesses: (await listBusinesses(db)).map((b) => ({ id: b.id, name: b.name })),
    }),
  );

  // ---------- Biznes konteksti ----------
  app.get('/api/business', async (c) => c.json(await getBusiness(db, c.get('businessId'))));
  app.patch('/api/business', async (c) => {
    const patch = await body(
      c,
      z.object({
        name: z.string().min(2).optional(),
        strategy: z.string().nullable().optional(),
        priorities: z.array(z.string()).optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
    );
    return c.json(await updateBusiness(db, c.get('businessId'), patch as any));
  });

  app.get('/api/context', async (c) => {
    const bid = c.get('businessId');
    return c.json({
      business: await getBusiness(db, bid),
      targets: await listTargets(db, bid),
      rules: await listRules(db, bid),
      detectors: detectorCatalog(),
      metrics: METRIC_CATALOG,
      actions: actionCatalog(),
    });
  });
  const targetSchema = z.object({
    kind: z.enum(['goal', 'kpi', 'constraint']).optional(),
    metric: z.string(),
    label: z.string().optional(),
    target: z.number(),
    comparator: z.enum(['gte', 'lte']).optional(),
    segment: z.string().nullable().optional(),
    priority: z.number().int().optional(),
  });
  app.post('/api/context/targets', async (c) => c.json(await upsertTarget(db, c.get('businessId'), await body(c, targetSchema))));
  app.patch('/api/context/targets/:id', async (c) =>
    c.json(await upsertTarget(db, c.get('businessId'), { ...(await body(c, targetSchema)), id: c.req.param('id') })),
  );
  app.delete('/api/context/targets/:id', async (c) => {
    await deleteTarget(db, c.get('businessId'), c.req.param('id'));
    return c.json({ ok: true });
  });
  const ruleSchema = z.object({
    name: z.string().min(3),
    description: z.string().nullable().optional(),
    detector: z.string(),
    params: z.record(z.string(), z.number()).optional(),
    action_type: z.string(),
    action_params: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  });
  app.post('/api/context/rules', async (c) => c.json(await upsertRule(db, c.get('businessId'), (await body(c, ruleSchema)) as any)));
  app.patch('/api/context/rules/:id', async (c) =>
    c.json(await upsertRule(db, c.get('businessId'), { ...((await body(c, ruleSchema)) as any), id: c.req.param('id') })),
  );
  app.delete('/api/context/rules/:id', async (c) => {
    await deleteRule(db, c.get('businessId'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/rules/run', async (c) => c.json(await runRules(db, c.get('businessId'))));

  // ---------- Bosh sahifa ----------
  app.get('/api/overview', async (c) => {
    const bid = c.get('businessId');
    const [business, diagnosis, pending, recent, findings, connectors] = await Promise.all([
      getBusiness(db, bid),
      latestDiagnosis(db, bid),
      listActions(db, bid, { status: 'pending', limit: 20 }),
      listActions(db, bid, { status: 'history', limit: 8 }),
      listFindings({ db, businessId: bid }, 'open'),
      listConnectors(db, bid),
    ]);
    return c.json({
      business,
      diagnosis,
      pendingActions: pending,
      recentActions: recent,
      findings,
      connectors: connectors.map((x) => ({ id: x.id, type: x.type, name: x.name, status: x.status, lastSyncAt: x.lastSyncAt, lastError: x.lastError })),
      aiEnabled: aiEnabled(),
    });
  });

  app.get('/api/kpis', async (c) => {
    const snap = await kpiSnapshot(await loadBrainContext(db, c.get('businessId')), daysParam(c));
    return c.json({ windowDays: snap.windowDays, kpis: snap.kpis });
  });

  // ---------- Diagnostika ----------
  app.get('/api/diagnoses', async (c) => c.json(await listDiagnoses(db, c.get('businessId'))));
  app.get('/api/diagnoses/latest', async (c) => c.json(await latestDiagnosis(db, c.get('businessId'))));
  app.get('/api/diagnoses/:id', async (c) => {
    const d = await getDiagnosis(db, c.get('businessId'), c.req.param('id'));
    if (!d) throw new HttpError(404, 'Diagnostika topilmadi');
    return c.json(d);
  });
  app.post('/api/diagnoses', async (c) => {
    const input = await body(c, z.object({ windowDays: z.number().int().min(7).max(180).optional() }));
    return c.json(await runDiagnosis(db, c.get('businessId'), { kind: 'adhoc', windowDays: input.windowDays }));
  });
  app.get('/api/findings', async (c) => {
    const status = (c.req.query('status') as 'open' | 'resolved' | 'all') ?? 'open';
    return c.json(await listFindings({ db, businessId: c.get('businessId') }, status));
  });
  app.post('/api/findings/refresh', async (c) => c.json(await refreshFindings(await loadBrainContext(db, c.get('businessId')))));

  // ---------- Harakatlar (Action Layer) ----------
  app.get('/api/actions', async (c) => {
    const status = c.req.query('status') as any;
    return c.json(await listActions(db, c.get('businessId'), { status, limit: Number(c.req.query('limit') ?? 100) }));
  });
  app.get('/api/actions/catalog', (c) => c.json(actionCatalog()));
  app.get('/api/actions/:id', async (c) => {
    const a = await getAction(db, c.get('businessId'), c.req.param('id'));
    if (!a) throw new HttpError(404, 'Harakat topilmadi');
    return c.json(a);
  });
  app.post('/api/actions', async (c) => {
    const input = await body(
      c,
      z.object({ type: z.string(), params: z.record(z.string(), z.unknown()), title: z.string().optional(), rationale: z.string().optional() }),
    );
    return c.json(await proposeAction(db, c.get('businessId'), { ...input, source: 'user' }));
  });
  const decision = z.object({ note: z.string().optional(), by: z.string().optional() });
  app.post('/api/actions/:id/approve', async (c) => {
    const d = await body(c, decision);
    return c.json(await approveAction(db, c.get('businessId'), c.req.param('id'), d.by ?? 'Rahbar (web)', d.note));
  });
  app.post('/api/actions/:id/reject', async (c) => {
    const d = await body(c, decision);
    return c.json(await rejectAction(db, c.get('businessId'), c.req.param('id'), d.by ?? 'Rahbar (web)', d.note));
  });
  app.post('/api/actions/:id/ignore', async (c) => {
    const d = await body(c, decision);
    return c.json(await ignoreAction(db, c.get('businessId'), c.req.param('id'), d.by ?? 'Rahbar (web)', d.note));
  });

  // ---------- Feedback / o'rganish ----------
  app.get('/api/learning', async (c) => {
    const bid = c.get('businessId');
    const pending = await db.one<{ n: number }>(`SELECT count(*) AS n FROM outcomes WHERE business_id = $1 AND verdict = 'pending'`, [bid]);
    return c.json({ stats: await learningStats(db, bid), history: await decisionHistory(db, bid, { limit: 50 }), pendingOutcomes: pending?.n ?? 0 });
  });
  app.post('/api/outcomes/evaluate', async (c) => c.json(await evaluateDueOutcomes(db, c.get('businessId'))));

  // ---------- Ma'lumotlar: mijozlar, leadlar, voronka ----------
  app.get('/api/customers', async (c) => {
    const risk = c.req.query('risk') as 'high' | 'medium' | undefined;
    return c.json(await searchCustomers(db, c.get('businessId'), { q: c.req.query('q'), risk, limit: Number(c.req.query('limit') ?? 50) }));
  });
  app.get('/api/customers/:id', async (c) => {
    const r = await getCustomer360(db, c.get('businessId'), c.req.param('id'));
    if (!r) throw new HttpError(404, 'Mijoz topilmadi');
    return c.json(r);
  });
  app.get('/api/leads', async (c) => {
    const ctx = await loadBrainContext(db, c.get('businessId'));
    if (c.req.query('filter') === 'unanswered') return c.json(await q.unansweredLeads(db, ctx.businessId, ctx.business.settings.unansweredHours, ctx.at));
    return c.json(await scoreOpenLeads(ctx, 50));
  });
  app.get('/api/funnel', async (c) => {
    const bid = c.get('businessId');
    const ctx = await loadBrainContext(db, bid);
    const { current, previous } = comparisonRanges(daysParam(c), ctx.at);
    const sla = ctx.business.settings.responseSlaMinutes;
    const [campCur, campPrev, fCur, fPrev, mCur, mPrev, rev, revPrev, rtCur, rtPrev, managers, spend, leads, won] = await Promise.all([
      q.campaignPerformance(db, bid, current),
      q.campaignPerformance(db, bid, previous),
      q.funnelBySegment(db, bid, current),
      q.funnelBySegment(db, bid, previous),
      q.marketingTotals(db, bid, current),
      q.marketingTotals(db, bid, previous),
      q.revenueSummary(db, bid, current),
      q.revenueSummary(db, bid, previous),
      q.responseTimes(db, bid, current, 'segment', sla),
      q.responseTimes(db, bid, previous, 'segment', sla),
      q.managerPerformance(db, bid, current),
      q.dailySeries(db, bid, 'spend', current, ctx.business.timezone),
      q.dailySeries(db, bid, 'leads', current, ctx.business.timezone),
      q.dailySeries(db, bid, 'won', current, ctx.business.timezone),
    ]);
    return c.json({
      campaigns: campCur.map((x) => ({ ...x, prev: campPrev.find((p) => p.campaign_id === x.campaign_id) ?? null })),
      funnel: { current: [...fCur, q.totalFunnel(fCur)], previous: [...fPrev, q.totalFunnel(fPrev)] },
      marketing: { current: mCur, previous: mPrev },
      revenue: { current: rev, previous: revPrev },
      responseTimes: rtCur.map((r) => ({ ...r, prev: rtPrev.find((p) => p.key === r.key) ?? null })),
      managers,
      series: { spend, leads, won },
    });
  });
  app.get('/api/tasks', async (c) =>
    c.json(
      await db.query(
        `SELECT t.id, t.title, t.description, t.status, t.priority, t.created_by, t.due_at, t.created_at, t.action_id, e.name AS assignee
           FROM tasks t LEFT JOIN employees e ON e.id = t.assignee_id
          WHERE t.business_id = $1 AND ($2::text IS NULL OR t.status = $2) ORDER BY t.created_at DESC LIMIT 100`,
        [c.get('businessId'), c.req.query('status') ?? null],
      ),
    ),
  );
  app.get('/api/notifications', async (c) =>
    c.json(
      await db.query(
        `SELECT id, channel, recipient, text, status, error, action_id, created_at FROM notifications
          WHERE business_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [c.get('businessId')],
      ),
    ),
  );
  app.get('/api/employees', async (c) =>
    c.json(await db.query(`SELECT id, name, role, telegram_chat_id, source, active FROM employees WHERE business_id = $1 ORDER BY role, name`, [c.get('businessId')])),
  );
  app.patch('/api/employees/:id', async (c) => {
    const input = await body(c, z.object({ telegram_chat_id: z.string().nullable().optional(), active: z.boolean().optional(), role: z.string().optional() }));
    await db.query(
      `UPDATE employees SET telegram_chat_id = COALESCE($3, telegram_chat_id), active = COALESCE($4, active), role = COALESCE($5, role) WHERE business_id = $1 AND id = $2`,
      [c.get('businessId'), c.req.param('id'), input.telegram_chat_id ?? null, input.active ?? null, input.role ?? null],
    );
    return c.json({ ok: true });
  });

  // ---------- Integratsiyalar ----------
  app.get('/api/connectors', async (c) => c.json(await listConnectors(db, c.get('businessId'))));
  app.get('/api/connectors/catalog', (c) => c.json(connectorCatalog()));
  app.post('/api/connectors', async (c) => {
    const input = await body(c, z.object({ type: z.string(), name: z.string().optional(), config: z.record(z.string(), z.unknown()) }));
    return c.json(await createConnector(db, c.get('businessId'), input));
  });
  app.patch('/api/connectors/:id', async (c) => {
    const input = await body(c, z.object({ name: z.string().optional(), status: z.enum(['active', 'paused']).optional(), config: z.record(z.string(), z.unknown()).optional() }));
    return c.json(await updateConnector(db, c.get('businessId'), c.req.param('id'), input));
  });
  app.delete('/api/connectors/:id', async (c) => {
    await deleteConnector(db, c.get('businessId'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/connectors/:id/sync', async (c) => {
    const row = await getConnectorRow(db, c.req.param('id'));
    if (!row || row.business_id !== c.get('businessId')) throw new HttpError(404, 'Connector topilmadi');
    return c.json(await runSync(db, row.id, 'manual'));
  });
  app.post('/api/connectors/:id/test', async (c) => c.json(await testConnector(db, c.get('businessId'), c.req.param('id'))));
  app.post('/api/connectors/:id/telegram-webhook', async (c) => c.json(await setTelegramWebhook(db, c.get('businessId'), c.req.param('id'))));

  app.get('/api/import/templates/:kind', (c) => {
    const kind = c.req.param('kind') as CsvKind;
    if (!CSV_TEMPLATES[kind]) throw new HttpError(404, 'Shablon topilmadi');
    return c.body(CSV_TEMPLATES[kind], 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${kind}.csv"` });
  });
  app.post('/api/import/csv', async (c) => {
    const kind = c.req.query('kind') as CsvKind;
    if (!['leads', 'payments', 'ad_metrics'].includes(kind)) throw new HttpError(400, "kind: leads | payments | ad_metrics");
    const text = await c.req.text();
    if (text.length > 10_000_000) throw new HttpError(400, 'Fayl juda katta (10 MB gacha)');
    const { records, errors } = csvToRecords(kind, text);
    const stats = records.length ? await db.tx((tx) => ingestRecords(tx, c.get('businessId'), records)) : {};
    return c.json({ imported: records.length, stats, errors: errors.slice(0, 50) });
  });

  // ---------- CEO Agent suhbatlari ----------
  app.get('/api/conversations', async (c) => c.json(await listConversations(db, c.get('businessId'))));
  app.post('/api/conversations', async (c) => {
    const id = await createConversation(db, c.get('businessId'));
    return c.json(await getConversation(db, c.get('businessId'), id));
  });
  app.get('/api/conversations/:id', async (c) => {
    const conv = await getConversation(db, c.get('businessId'), c.req.param('id'));
    if (!conv) throw new HttpError(404, 'Suhbat topilmadi');
    return c.json(conv);
  });
  app.delete('/api/conversations/:id', async (c) => {
    await deleteConversation(db, c.get('businessId'), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/conversations/:id/messages', async (c) => {
    const { text } = await body(c, z.object({ text: z.string().min(1).max(4000) }));
    const bid = c.get('businessId');
    const conversationId = c.req.param('id');
    return streamSSE(c, async (stream) => {
      const queue: ChatEvent[] = [];
      let notify: (() => void) | null = null;
      let finished = false;
      const push = (e: ChatEvent) => {
        queue.push(e);
        notify?.();
      };
      const run = chat(db, bid, conversationId, text, push)
        .catch((err) => push({ type: 'error', error: errorMessage(err) }))
        .finally(() => {
          finished = true;
          notify?.();
        });
      while (!finished || queue.length) {
        if (!queue.length) await new Promise<void>((r) => (notify = r));
        notify = null;
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        }
      }
      await run;
    });
  });

  // ---------- Demo ----------
  app.post('/api/demo/reset', async (c) => {
    await resetDemo(db, DEMO_BUSINESS_ID);
    await seedDemo(db);
    const d = await runDiagnosis(db, DEMO_BUSINESS_ID, { kind: 'daily', narrate: false });
    await runRules(db, DEMO_BUSINESS_ID);
    return c.json({ ok: true, businessId: DEMO_BUSINESS_ID, diagnosisId: d.id });
  });

  return app;
}
