import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db/client';
import type { TreeNode } from '../src/shared/types';
import { config } from '../src/server/config';
import { ActionValidationError, approveAction, getAction, listActions, proposeAction, rejectAction } from '../src/server/actions/service';
import { runDiagnosis } from '../src/server/brain/service';
import { getCustomer360, searchCustomers } from '../src/server/brain/customer360';
import { runRules } from '../src/server/context/rules';
import { evaluateDueOutcomes, learningStats } from '../src/server/feedback/outcomes';
import { createApp } from '../src/server/http/app';
import { addDays, now } from '../src/server/lib/util';
import { demoDb } from './helpers';

let db: Db;
let businessId: string;

beforeAll(async () => {
  ({ db, businessId } = await demoDb());
});
afterAll(() => db.close());

function sumCheck(node: TreeNode, path: string[] = []) {
  // Yig'indi/ko'paytma bolalari hissalari ota o'zgarishiga teng bo'lishi kerak
  const parts = node.children.filter((c) => (c.relation === 'sum' || c.relation === 'product') && c.contribution !== null);
  if (parts.length) {
    const delta = node.current - node.previous;
    const total = parts.reduce((a, c) => a + (c.contribution ?? 0), 0);
    expect(Math.abs(total - delta), `${[...path, node.key].join(' > ')}`).toBeLessThan(Math.max(1e-6, Math.abs(delta) * 1e-6) + 1e-9);
  }
  node.children.forEach((c) => sumCheck(c, [...path, node.key]));
}

describe('Daily Business Diagnosis (demo: Edinburg)', () => {
  let diagnosisId: string;

  it("daromad tushishining root cause'ini IELTS javob vaqtigacha kuzatadi", async () => {
    const d = await runDiagnosis(db, businessId, { kind: 'daily', narrate: false });
    diagnosisId = d.id;
    const revenue = d.kpis.find((k) => k.key === 'revenue')!;
    expect(revenue.change!).toBeLessThan(-0.05);
    expect(d.rootCause).not.toBeNull();
    expect(d.rootCause!.path).toEqual(expect.arrayContaining(['revenue', 'revenue.new', 'funnel.conversion', 'funnel.conversion.IELTS']));
    expect(d.rootCause!.path.some((k) => k.startsWith('driver.response_time.IELTS') || k.startsWith('driver.sla.IELTS'))).toBe(true);
    expect(d.rootCause!.segment).toBe('IELTS');
    expect(d.rootCause!.evidence.join(' ')).toMatch(/15 daqiqa ichida/);
    expect(d.narrative).toContain('IELTS');
  });

  it("KPI daraxti hissalari matematik jihatdan izchil", async () => {
    const d = (await runDiagnosis(db, businessId, { narrate: false, propose: false }));
    sumCheck(d.tree);
  });

  it('ustuvorliklar root cause bilan bog‘liq muammodan boshlanadi va tavsiyalar Action Layer’ga yuboriladi', async () => {
    const res = await createApp(db).request(`/api/diagnoses/${diagnosisId}`);
    const d = await res.json();
    expect(d.priorities[0].detector).toBe('lead_unanswered');
    const reassign = d.recommendations.find((r: any) => r.actionType === 'reassign_leads');
    expect(reassign).toMatchObject({ risk: 'medium', actionStatus: 'proposed' });
    const churn = d.recommendations.find((r: any) => r.actionType === 'retention_outreach');
    expect(churn?.actionStatus).toBe('executed'); // past xavf — avtomatik
  });
});

describe('Action Layer va Feedback Loop', () => {
  it('noto‘g‘ri parametrlar rad etiladi', async () => {
    await expect(proposeAction(db, businessId, { type: 'reassign_leads', params: { leadIds: [] }, source: 'user' })).rejects.toBeInstanceOf(ActionValidationError);
    await expect(proposeAction(db, businessId, { type: 'yoq_harakat', params: {}, source: 'user' })).rejects.toBeInstanceOf(ActionValidationError);
  });

  it('o‘rta xavfli harakat tasdiqlangach bajariladi va natijasi o‘lchanadi', async () => {
    const pending = await listActions(db, businessId, { status: 'pending' });
    const reassign = pending.find((a) => a.type === 'reassign_leads')!;
    expect(reassign).toBeDefined();
    const leadIds = reassign.params.leadIds as string[];
    const before = await db.query<{ assigned_to: string }>('SELECT assigned_to FROM leads WHERE id = ANY($1)', [leadIds]);

    const done = await approveAction(db, businessId, reassign.id, 'Test rahbar');
    expect(done.status).toBe('executed');
    expect(done.decidedBy).toBe('Test rahbar');
    expect((done.result as any).summary).toMatch(/qayta taqsimlandi/);
    expect(done.outcome).toMatchObject({ metric: 'leads_response_rate', verdict: 'pending', baseline: 0 });

    const after = await db.query<{ assigned_to: string }>('SELECT assigned_to FROM leads WHERE id = ANY($1)', [leadIds]);
    const overloaded = before.reduce<Record<string, number>>((m, r) => ((m[r.assigned_to] = (m[r.assigned_to] ?? 0) + 1), m), {});
    const top = Object.entries(overloaded).sort((a, b) => b[1] - a[1])[0][0];
    expect(after.every((r) => r.assigned_to !== top)).toBe(true);
    const tasks = await db.query('SELECT id FROM tasks WHERE action_id = $1', [reassign.id]);
    expect(tasks.length).toBeGreaterThan(0);

    // Qayta tasdiqlab bo'lmaydi
    await expect(approveAction(db, businessId, reassign.id, 'x')).rejects.toBeInstanceOf(ActionValidationError);

    // Menejerlar javob berdi → 1 kundan keyin natija "yaxshilandi"
    await db.query(`UPDATE leads SET first_response_at = now() WHERE id = ANY($1)`, [leadIds]);
    const evaluated = await evaluateDueOutcomes(db, businessId, addDays(now(), 2));
    expect(evaluated.length).toBeGreaterThan(0);
    const updated = await getAction(db, businessId, reassign.id);
    expect(updated!.outcome).toMatchObject({ verdict: 'improved', observed: 1 });
    const stats = await learningStats(db, businessId);
    expect(stats.find((s) => s.type === 'reassign_leads')!.improved).toBeGreaterThanOrEqual(2); // demo tarix + yangi
  });

  it('yuqori xavfli harakat (pul qaytarish) avtomatik bajarilmaydi', async () => {
    const pay = await db.one<{ id: string }>(`SELECT id FROM payments WHERE business_id = $1 AND status = 'paid' LIMIT 1`, [businessId]);
    const res = await proposeAction(db, businessId, { type: 'issue_refund', params: { paymentId: pay!.id, amount: 500000, reason: 'Kurs bekor qilindi' }, source: 'agent' });
    expect(res.action.risk).toBe('high');
    expect(res.action.status).toBe('proposed');
    const rejected = await rejectAction(db, businessId, res.action.id, 'Rahbar', 'kerak emas');
    expect(rejected.status).toBe('rejected');
  });

  it('byudjetni katta o‘zgartirish yuqori xavf, kichigi o‘rta xavf', async () => {
    const c = await db.one<{ id: string; daily_budget: number }>(`SELECT id, daily_budget FROM campaigns WHERE business_id = $1 AND status = 'active' LIMIT 1`, [businessId]);
    const small = await proposeAction(db, businessId, { type: 'change_campaign_budget', params: { campaignId: c!.id, newDailyBudget: Math.round(c!.daily_budget * 1.1) }, source: 'agent' });
    const big = await proposeAction(db, businessId, { type: 'change_campaign_budget', params: { campaignId: c!.id, newDailyBudget: c!.daily_budget * 3 }, source: 'agent' });
    expect(small.action.risk).toBe('medium');
    expect(big.action.risk).toBe('high');
  });

  it('dedupe kaliti takroriy harakat yaratmaydi', async () => {
    const input = { type: 'create_task', params: { title: 'Test vazifa' }, source: 'rule' as const, dedupeKey: 'test:dedupe' };
    const a = await proposeAction(db, businessId, input);
    const b = await proposeAction(db, businessId, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.action.id).toBe(a.action.id);
  });
});

describe('Biznes qoidalari', () => {
  it("qoidalar harakat yaratadi, ikkinchi ishga tushirishda takrorlanmaydi", async () => {
    // Yangi javobsiz leadlar paydo bo'lishi uchun bir nechtasini qaytadan "javobsiz" qilamiz
    await db.query(
      `UPDATE leads SET first_response_at = NULL, status = 'new' WHERE id IN (
         SELECT id FROM leads WHERE business_id = $1 AND created_at < now() - interval '3 hours' AND created_at > now() - interval '3 days' ORDER BY created_at DESC LIMIT 4)`,
      [businessId],
    );
    const first = await runRules(db, businessId);
    const unanswered = first.find((r) => r.name.startsWith('Javobsiz lead'))!;
    expect(unanswered.findings).toBe(1);
    expect(unanswered.proposed).toBeGreaterThan(0);
    expect(first.every((r) => r.errors.length === 0)).toBe(true);
    const second = await runRules(db, businessId);
    expect(second.reduce((a, r) => a + r.proposed, 0)).toBe(0);
  });
});

describe('Customer 360', () => {
  it("Ali Valiyev: Instagram → IELTS September → Aziz → sinov → xarid → 1,8 mln so'm", async () => {
    const [ali] = await searchCustomers(db, businessId, { q: 'Ali Valiyev' });
    const c = await getCustomer360(db, businessId, ali.id);
    expect(c).toMatchObject({ source: 'instagram', campaign: '#12 IELTS September', salesManager: 'Aziz Karimov', segment: 'IELTS', revenue: 1_800_000 });
    expect(c!.trialAt).not.toBeNull();
    expect(c!.churnProbability).not.toBeNull();
    expect(c!.identities.map((i) => i.kind)).toEqual(expect.arrayContaining(['phone', 'meta_lead', 'telegram']));
  });
});

describe('HTTP API', () => {
  it('asosiy endpointlar ishlaydi', async () => {
    const app = createApp(db);
    for (const path of ['/api/health', '/api/meta', '/api/overview', '/api/funnel?days=30', '/api/customers?risk=high', '/api/context', '/api/learning', '/api/connectors', '/api/leads']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
    }
    const overview = await (await app.request('/api/overview')).json();
    expect(overview.business.name).toBe("Edinburg o'quv markazi");
  });

  it('YOLDOSH_API_TOKEN o‘rnatilganda avtorizatsiya talab qilinadi (webhooklardan tashqari)', async () => {
    const app = createApp(db);
    config.apiToken = 'maxfiy-token';
    try {
      expect((await app.request('/api/overview')).status).toBe(401);
      expect((await app.request('/api/overview', { headers: { Authorization: 'Bearer maxfiy-token' } })).status).toBe(200);
      expect((await app.request('/api/health')).status).toBe(200);
      expect((await app.request('/api/webhooks/payments/yoq', { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      config.apiToken = undefined;
    }
  });

  it('offline chat (AI kalitisiz) SSE orqali engine javobini qaytaradi', async () => {
    const app = createApp(db);
    const conv = await (await app.request('/api/conversations', { method: 'POST' })).json();
    const res = await app.request(`/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Javobsiz leadlar qancha?' }),
    });
    const text = await res.text();
    expect(text).toContain('event: done');
    expect(text).toMatch(/javobsiz/);
    const saved = await (await app.request(`/api/conversations/${conv.id}`)).json();
    expect(saved.messages).toHaveLength(2);
  });
});
