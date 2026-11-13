import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db/client';
import { createPGlite } from '../src/server/db/client';
import { migrate } from '../src/server/db';
import { createApp } from '../src/server/http/app';
import { ingestRecords } from '../src/server/ingest';
import { demoDb } from './helpers';

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('biznessiz o‘rnatma (yangi deploy)', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createPGlite();
    await migrate(db);
  });
  afterAll(() => db.close());

  it('biznes yo‘q bo‘lsa API buni aytadi, yaratish esa ishlaydi', async () => {
    const app = createApp(db);
    expect((await app.request('/api/overview')).status).toBe(404);
    expect((await (await app.request('/api/meta')).json()).businesses).toEqual([]);

    expect((await app.request('/api/businesses', json({ name: 'X' }))).status).toBe(400);
    expect((await app.request('/api/businesses', json({ name: 'Test markaz', timezone: 'Mars/Olympus' }))).status).toBe(400);

    const res = await app.request(
      '/api/businesses',
      json({ name: 'Test markaz', vertical: 'education', strategy: 'Tez xizmat', products: [{ name: 'IELTS', price: 1_800_000, keywords: ['band'] }, { name: 'Kids English', price: 900_000 }] }),
    );
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b).toMatchObject({ name: 'Test markaz', vertical: 'education', strategy: 'Tez xizmat', timezone: 'Asia/Tashkent' });

    const ctx = await (await app.request('/api/context')).json();
    expect(ctx.products.map((p: any) => p.name).sort()).toEqual(['IELTS', 'Kids English']);
    expect(ctx.rules).toHaveLength(6);
    expect(ctx.targets.map((t: any) => t.metric)).toEqual(['response_time_minutes']);
  });

  it("bo'sh biznesda bosh sahifa va diagnostika xatosiz ishlaydi", async () => {
    const app = createApp(db);
    expect((await app.request('/api/overview')).status).toBe(200);
    const d = await (await app.request('/api/diagnoses', json({}))).json();
    expect(d.rootCause).toBeNull();
    expect(d.kpis.find((k: any) => k.key === 'revenue').current).toBe(0);
    for (const path of ['/api/funnel?days=30', '/api/customers', '/api/learning', '/api/leads']) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });

  it("yangi mahsulot kalit so'zi bo'yicha lead segmenti aniqlanadi", async () => {
    const app = createApp(db);
    const p = await (await app.request('/api/context/products', json({ name: 'SAT', price: 2_000_000, keywords: ['sat math'] }))).json();
    expect(p.segment).toBe('SAT');
    const { id } = await (await app.request('/api/meta')).json().then((m: any) => m.businesses[0]);
    await ingestRecords(db, id, [
      { kind: 'lead', source: 'csv_import', externalId: 'L-sat', contact: { phone: '+998901110000' }, campaignName: 'Kuzgi SAT Math kampaniyasi', createdAt: new Date() },
    ]);
    const lead = await db.one<any>(`SELECT segment FROM leads WHERE external_id = 'L-sat'`);
    expect(lead.segment).toBe('SAT');

    expect((await app.request(`/api/context/products/${p.id}`, { method: 'DELETE' })).status).toBe(200);
    const ctx = await (await app.request('/api/context')).json();
    expect(ctx.products.some((x: any) => x.id === p.id)).toBe(false);
  });
});

describe('bir nechta biznes: tanlash va izolyatsiya', () => {
  let db: Db;
  let demoId: string;
  let newId: string;
  beforeAll(async () => {
    ({ db, businessId: demoId } = await demoDb());
    const b = await (await createApp(db).request('/api/businesses', json({ name: 'Ikkinchi biznes', vertical: 'services', products: [{ name: 'Konsultatsiya', price: 500_000 }] }))).json();
    newId = b.id;
  });
  afterAll(() => db.close());

  it('x-business-id sarlavhasi so‘rovni tanlangan biznesga yo‘naltiradi', async () => {
    const app = createApp(db);
    const a = await (await app.request('/api/context', { headers: { 'x-business-id': newId } })).json();
    const d = await (await app.request('/api/context', { headers: { 'x-business-id': demoId } })).json();
    expect(a.business.name).toBe('Ikkinchi biznes');
    expect(a.products.map((p: any) => p.name)).toEqual(['Konsultatsiya']);
    expect(a.rules.some((r: any) => r.name.startsWith('Mijoz 7 kun'))).toBe(true);
    expect(d.business.name).toBe("Edinburg o'quv markazi");
    const meta = await (await app.request('/api/meta')).json();
    expect(meta.businesses.map((b: any) => b.id)).toEqual([demoId, newId]);
  });

  it('boshqa biznesning maqsadi, qoidasi va mahsulotini o‘zgartirib bo‘lmaydi', async () => {
    const app = createApp(db);
    const asNew = { 'x-business-id': newId };
    const demoCtx = await (await app.request('/api/context', { headers: { 'x-business-id': demoId } })).json();
    const target = demoCtx.targets[0];
    const rule = demoCtx.rules[0];
    const product = demoCtx.products[0];

    const t = await app.request(`/api/context/targets/${target.id}`, { ...json({ metric: target.metric, target: 1 }, asNew), method: 'PATCH' });
    expect(t.status).toBe(404);
    const r = await app.request(`/api/context/rules/${rule.id}`, {
      ...json({ name: 'buzildi', detector: rule.detector, action_type: rule.action_type, params: rule.params }, asNew),
      method: 'PATCH',
    });
    expect(r.status).toBe(404);
    const p = await app.request(`/api/context/products/${product.id}`, { ...json({ name: 'buzildi', price: 1 }, asNew), method: 'PATCH' });
    expect(p.status).toBe(404);

    const after = await (await app.request('/api/context', { headers: { 'x-business-id': demoId } })).json();
    expect(after.targets[0].target).toBe(target.target);
    expect(after.rules[0].name).toBe(rule.name);
    expect(after.products[0].name).toBe(product.name);
  });
});
