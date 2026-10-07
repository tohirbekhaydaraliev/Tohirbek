import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db/client';
import { amoBase, mapAmoLead, parseAmoWebhook, parsePipelines } from '../src/server/connectors/amocrm';
import { csvToRecords, parseCsv } from '../src/server/connectors/csv';
import { leadsFromActions, mapCampaign, mapInsightRow, mapLeadgen, verifyMetaSignature } from '../src/server/connectors/meta';
import { mapPaymentPayload, signPayload, verifyPaymentSignature } from '../src/server/connectors/payments';
import { createConnector, handleWebhook, runSync, setConnectorFetch } from '../src/server/connectors/registry';
import { chunkText } from '../src/server/connectors/telegram';
import { emptyDb } from './helpers';

describe('Meta Ads', () => {
  it("insights qatorini so'mga o'giradi va lead turlarini ikki marta sanamaydi", () => {
    const row = {
      campaign_id: '120',
      campaign_name: 'IELTS September',
      date_start: '2026-10-01',
      spend: '4.12',
      impressions: '2100',
      clicks: '35',
      actions: [
        { action_type: 'lead', value: '9' },
        { action_type: 'onsite_conversion.lead_grouped', value: '9' },
        { action_type: 'link_click', value: '35' },
      ],
    };
    const rec = mapInsightRow(row, 12800);
    expect(rec).toMatchObject({ campaignExternalId: '120', date: '2026-10-01', spend: 52736, leads: 9, clicks: 35 });
    expect(leadsFromActions(undefined)).toBe(0);
  });

  it('kampaniya byudjeti (sent) va status', () => {
    expect(mapCampaign({ id: '1', name: 'X', effective_status: 'PAUSED', daily_budget: '400' }, 12800)).toMatchObject({ status: 'paused', dailyBudget: 51200 });
  });

  it('Lead Ads field_data → kontakt', () => {
    const r = mapLeadgen({
      id: 'lg9',
      created_time: '2026-10-06T08:00:00+0000',
      campaign_id: '120',
      field_data: [
        { name: 'full_name', values: ['Ali Valiyev'] },
        { name: 'phone_number', values: ['+998901234567'] },
      ],
    });
    expect(r.contact).toMatchObject({ name: 'Ali Valiyev', phone: '+998901234567' });
    expect(r.campaignExternalId).toBe('120');
  });

  it('X-Hub-Signature-256 tekshiruvi', () => {
    const body = '{"object":"page"}';
    const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, sig, 's3cret')).toBe(true);
    expect(verifyMetaSignature(body, sig, 'boshqa')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3cret')).toBe(false);
  });
});

describe('amoCRM', () => {
  const pipelines = parsePipelines({
    _embedded: {
      pipelines: [
        {
          id: 1,
          name: 'IELTS',
          _embedded: {
            statuses: [
              { id: 10, name: 'Неразобранное', sort: 10, type: 1 },
              { id: 11, name: 'Yangi', sort: 20, type: 0 },
              { id: 12, name: 'Sinov darsi', sort: 30, type: 0 },
              { id: 142, name: 'Sotildi', sort: 10000, type: 0 },
              { id: 143, name: "Yo'qotildi", sort: 11000, type: 0 },
            ],
          },
        },
      ],
    },
  });

  it('domen', () => {
    expect(amoBase({ subdomain: 'edinburg', accessToken: 'x' })).toBe('https://edinburg.amocrm.ru');
    expect(amoBase({ subdomain: 'edinburg.kommo.com', accessToken: 'x' })).toBe('https://edinburg.kommo.com');
  });

  it('lead bosqichlari, kontakt, UTM va yo‘qotish sababi', () => {
    const contacts = new Map([[5, { id: 5, name: 'Ali', custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+998901234567' }] }] }]]);
    const cfg = { subdomain: 'e', accessToken: 'x', trialStatusIds: '12' };
    const base = { id: 1, name: 'Ali — IELTS', price: 1800000, pipeline_id: 1, responsible_user_id: 77, created_at: 1759900000, updated_at: 1759990000, _embedded: { contacts: [{ id: 5, is_main: true }] } };
    const won = mapAmoLead({ ...base, status_id: 142, closed_at: 1760000000, custom_fields_values: [{ field_code: 'UTM_SOURCE', values: [{ value: 'instagram' }] }, { field_code: 'UTM_CAMPAIGN', values: [{ value: '120' }] }] }, contacts, pipelines, cfg);
    expect(won).toMatchObject({ status: 'won', campaignSource: 'meta_ads', campaignExternalId: '120', assignedToExternalId: '77', value: 1800000 });
    expect(won.contact.phone).toBe('+998901234567');
    expect(mapAmoLead({ ...base, status_id: 12 }, contacts, pipelines, cfg).status).toBe('trial');
    expect(mapAmoLead({ ...base, status_id: 11 }, contacts, pipelines, cfg).status).toBe('new');
    expect(mapAmoLead({ ...base, status_id: 11 }, contacts, pipelines, cfg, new Date()).status).toBe('contacted');
    const lost = mapAmoLead({ ...base, status_id: 143, closed_at: 1760000000, _embedded: { ...base._embedded, loss_reason: [{ name: 'Narx qimmat' }] } }, contacts, pipelines, cfg);
    expect(lost).toMatchObject({ status: 'lost', lostReason: 'Narx qimmat' });
  });

  it('webhook (form-urlencoded) dan lead ID’lar', () => {
    const body = 'leads%5Badd%5D%5B0%5D%5Bid%5D=111&leads%5Bstatus%5D%5B0%5D%5Bid%5D=222&account%5Bsubdomain%5D=e';
    expect(parseAmoWebhook(body).sort()).toEqual([111, 222]);
  });
});

describe("to'lovlar webhook", () => {
  it('imzo va mapping', () => {
    const body = JSON.stringify({ id: 'p1', amount: 1800000, phone: '+998901234567' });
    const sig = signPayload('k', body);
    expect(verifyPaymentSignature('k', body, sig)).toBe(true);
    expect(verifyPaymentSignature('k', body, sig.replace('sha256=', ''))).toBe(true);
    expect(verifyPaymentSignature('k', `${body} `, sig)).toBe(false);
    expect(mapPaymentPayload(JSON.parse(body), 'payme')).toMatchObject({ externalId: 'p1', amount: 1800000, status: 'paid', method: 'payme' });
    expect(() => mapPaymentPayload({ amount: 1 })).toThrow();
  });
});

describe('CSV import', () => {
  it("qo'shtirnoq, nuqtali vergul va qator ichidagi yangi qator", () => {
    const rows = parseCsv('ism;telefon;izoh\n"Valiyev, Ali";+998901234567;"ikki\nqator"\n');
    expect(rows).toEqual([
      ['ism', 'telefon', 'izoh'],
      ['Valiyev, Ali', '+998901234567', 'ikki\nqator'],
    ]);
  });

  it("o'zbekcha/ruscha sarlavhalar va sanalar", () => {
    const { records, errors } = csvToRecords('payments', 'Ism,Telefon,Summa,Holat,Sana\nAli,90 123 45 67,"1 800 000",paid,14.09.2026\nXato,,0,,\n'.replace('Sana', "to'langan"));
    expect(errors).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'payment', amount: 1800000, status: 'paid' });
    expect((records[0] as any).paidAt.toISOString()).toBe('2026-09-14T07:00:00.000Z');
  });
});

describe('Telegram', () => {
  it('uzun xabarni bo‘laklarga ajratadi', () => {
    const text = Array.from({ length: 400 }, (_, i) => `qator ${i} — ${'x'.repeat(20)}`).join('\n');
    const parts = chunkText(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 3900)).toBe(true);
  });
});

describe('connector registry: webhook va sync', () => {
  let db: Db;
  let businessId: string;
  beforeAll(async () => {
    ({ db, businessId } = await emptyDb());
  });
  afterAll(async () => {
    setConnectorFetch(null);
    await db.close();
  });

  it("imzolangan to'lov webhook'i ingest qilinadi, takrori e'tiborsiz qoldiriladi", async () => {
    const con = await createConnector(db, businessId, { type: 'payments', config: { secret: 'k' } });
    expect(con.config.secret).toBe('••••••••');
    const raw = JSON.stringify({ payments: [{ id: 'P-1', amount: 1200000, phone: '901112233', name: 'Hilola' }] });
    const req = (sig: string) => ({ method: 'POST', headers: { 'x-yoldosh-signature': sig }, query: {}, rawBody: raw });
    const bad = await handleWebhook(db, 'payments', con.id, req('sha256=00'));
    expect(bad.result.response.status).toBe(401);
    const ok = await handleWebhook(db, 'payments', con.id, req(signPayload('k', raw)));
    expect(ok.result.response.status).toBe(200);
    expect(ok.ingested).toEqual({ payment: 1 });
    const dup = await handleWebhook(db, 'payments', con.id, req(signPayload('k', raw)));
    expect(dup.duplicate).toBe(true);
    const pay = await db.one<any>(`SELECT p.amount, c.phone FROM payments p JOIN customers c ON c.id = p.customer_id WHERE p.external_id = 'P-1'`);
    expect(pay).toMatchObject({ amount: 1200000, phone: '+998901112233' });
  });

  it('Meta sync: soxta Graph API bilan kampaniya va metrikalar olinadi', async () => {
    const calls: string[] = [];
    setConnectorFetch(async (url) => {
      calls.push(url);
      const body = url.includes('/campaigns?')
        ? { data: [{ id: '120', name: 'IELTS September', effective_status: 'ACTIVE', daily_budget: '400' }] }
        : { data: [{ campaign_id: '120', campaign_name: 'IELTS September', date_start: '2026-10-05', spend: '4', impressions: '1000', clicks: '20', actions: [{ action_type: 'lead', value: '8' }] }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const con = await createConnector(db, businessId, { type: 'meta_ads', config: { accessToken: 'tok', adAccountId: '123', currencyRate: 12800 } });
    const res = await runSync(db, con.id, 'manual');
    expect(res.ok).toBe(true);
    expect(calls[0]).toContain('/act_123/campaigns');
    const m = await db.one<any>(`SELECT spend, leads FROM ad_metrics_daily WHERE date = '2026-10-05'`);
    expect(m).toMatchObject({ spend: 51200, leads: 8 });
    const c = await db.one<any>(`SELECT daily_budget FROM campaigns WHERE external_id = '120'`);
    expect(c.daily_budget).toBe(51200);
  });

  it('sync xatosi connector holatida saqlanadi', async () => {
    setConnectorFetch(async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), { status: 400 }));
    const con = await createConnector(db, businessId, { type: 'amocrm', config: { subdomain: 'x', accessToken: 'bad' } });
    const res = await runSync(db, con.id, 'manual');
    expect(res.ok).toBe(false);
    const row = await db.one<any>('SELECT last_error FROM connectors WHERE id = $1', [con.id]);
    expect(row.last_error).toContain('Invalid OAuth');
  });
});
