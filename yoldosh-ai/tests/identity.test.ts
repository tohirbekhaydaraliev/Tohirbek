import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db/client';
import { normalizeEmail, normalizePhone, normalizeTelegram, resolveCustomer } from '../src/server/ingest/identity';
import { ingestRecords } from '../src/server/ingest';
import { emptyDb } from './helpers';

describe('normallashtirish', () => {
  it("O'zbekiston telefon raqamlarini E.164 ga keltiradi", () => {
    expect(normalizePhone('90 123 45 67')).toBe('+998901234567');
    expect(normalizePhone('+998 (90) 123-45-67')).toBe('+998901234567');
    expect(normalizePhone('998901234567')).toBe('+998901234567');
    expect(normalizePhone('00998901234567')).toBe('+998901234567');
    expect(normalizePhone('8901234567')).toBe('+998901234567');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('email va telegram', () => {
    expect(normalizeEmail('  Ali@Mail.UZ ')).toBe('ali@mail.uz');
    expect(normalizeEmail('yaroqsiz')).toBeNull();
    expect(normalizeTelegram('@Ali_Valiyev')).toBe('ali_valiyev');
    expect(normalizeTelegram('https://t.me/ali_valiyev')).toBe('ali_valiyev');
  });
});

describe('identity resolution (universal Customer ID)', () => {
  let db: Db;
  let businessId: string;
  beforeAll(async () => {
    ({ db, businessId } = await emptyDb());
  });
  afterAll(() => db.close());

  it("Meta lead, CRM kontakt va to'lov bitta mijozga bog'lanadi", async () => {
    const a = await resolveCustomer(db, businessId, { name: 'Ali', phone: '90 123 45 67', externalIds: [{ kind: 'meta_lead', value: 'lg1' }] }, { source: 'meta_ads' });
    const b = await resolveCustomer(db, businessId, { name: 'Ali Valiyev', phone: '+998901234567', email: 'ali@mail.uz', externalIds: [{ kind: 'amocrm_contact', value: '77' }] }, { source: 'amocrm' });
    const c = await resolveCustomer(db, businessId, { phone: '998901234567' }, { source: 'payme' });
    expect(a.created).toBe(true);
    expect(b.customerId).toBe(a.customerId);
    expect(c.customerId).toBe(a.customerId);
    const ids = await db.query<{ kind: string }>('SELECT kind FROM customer_identities WHERE customer_id = $1 ORDER BY kind', [a.customerId]);
    expect(ids.map((i) => i.kind)).toEqual(['amocrm_contact', 'email', 'meta_lead', 'phone']);
    const row = await db.one<{ email: string }>('SELECT email FROM customers WHERE id = $1', [a.customerId]);
    expect(row?.email).toBe('ali@mail.uz');
  });

  it("ikki alohida mijoz umumiy identifikator topilganda birlashtiriladi", async () => {
    const x = await resolveCustomer(db, businessId, { phone: '+998935550000' }, { source: 'a' });
    const y = await resolveCustomer(db, businessId, { email: 'x@y.uz' }, { source: 'b' });
    expect(x.customerId).not.toBe(y.customerId);
    await db.query(
      `INSERT INTO payments (id, business_id, customer_id, amount, status, source, external_id) VALUES ('p1', $1, $2, 1000, 'paid', 'test', 'p1')`,
      [businessId, y.customerId],
    );
    const z = await resolveCustomer(db, businessId, { phone: '935550000', email: 'x@y.uz' }, { source: 'c' });
    expect(z.merged).toEqual([y.customerId]);
    expect(z.customerId).toBe(x.customerId);
    const pay = await db.one<{ customer_id: string }>(`SELECT customer_id FROM payments WHERE id = 'p1'`);
    expect(pay?.customer_id).toBe(x.customerId);
    expect(await db.one('SELECT id FROM customers WHERE id = $1', [y.customerId])).toBeUndefined();
  });

  it('ingest: lead → sotuv → obuna, chiquvchi muloqot birinchi javob vaqtini belgilaydi', async () => {
    await db.query(`INSERT INTO products (id, business_id, name, segment, price, keywords) VALUES ('prd_i', $1, 'IELTS', 'IELTS', 1800000, '{ielts}')`, [businessId]);
    const created = new Date('2026-09-10T06:00:00Z');
    await ingestRecords(db, businessId, [
      { kind: 'campaign', source: 'meta_ads', externalId: 'c1', name: 'IELTS September' },
      { kind: 'lead', source: 'amocrm', externalId: 'L1', contact: { name: 'Vali', phone: '+998977777777' }, campaignExternalId: 'c1', campaignSource: 'meta_ads', createdAt: created },
      { kind: 'interaction', source: 'amocrm', contact: { phone: '+998977777777' }, channel: 'call', direction: 'out', occurredAt: new Date(created.getTime() + 9 * 60_000), leadExternalId: 'L1' },
    ]);
    let lead = await db.one<any>(`SELECT * FROM leads WHERE external_id = 'L1'`);
    expect(lead.segment).toBe('IELTS');
    expect(lead.status).toBe('contacted');
    expect((new Date(lead.first_response_at).getTime() - created.getTime()) / 60_000).toBe(9);

    await ingestRecords(db, businessId, [
      { kind: 'lead', source: 'amocrm', externalId: 'L1', contact: { phone: '+998977777777' }, createdAt: created, status: 'won', wonAt: new Date('2026-09-14T06:00:00Z') },
    ]);
    lead = await db.one<any>(`SELECT * FROM leads WHERE external_id = 'L1'`);
    expect(lead.status).toBe('won');
    const sub = await db.one<any>('SELECT * FROM subscriptions WHERE lead_id = $1', [lead.id]);
    expect(sub.price).toBe(1800000);
  });
});
