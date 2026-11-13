import type { AdMetricsRecord, LeadRecord, LeadStatus, NormalizedRecord, PaymentRecord, PaymentStatus } from './types';

/**
 * Excel / CSV import — 1C, Google Sheets yoki istalgan jadvaldan eksport qilingan ma'lumot.
 * Sarlavhalar o'zbekcha, ruscha yoki inglizcha bo'lishi mumkin.
 */

export type CsvKind = 'leads' | 'payments' | 'ad_metrics';

/** RFC 4180 CSV parser (qo'shtirnoq, vergul/nuqtali vergul, qator ichidagi yangi qator). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  id: ['id', 'external_id', 'raqam', '№', 'номер'],
  name: ['name', 'full_name', 'ism', 'fio', 'f.i.o', 'mijoz', 'имя', 'фио', 'клиент'],
  phone: ['phone', 'telefon', 'tel', 'телефон', 'phone_number'],
  email: ['email', 'e-mail', 'почта'],
  source: ['source', 'manba', 'источник', 'utm_source'],
  campaign: ['campaign', 'kampaniya', 'кампания', 'utm_campaign', 'campaign_name'],
  segment: ['segment', 'kurs', 'course', 'product', 'mahsulot', 'курс', 'продукт'],
  status: ['status', 'holat', 'статус', 'этап'],
  manager: ['manager', 'menejer', 'responsible', 'менеджер', 'ответственный'],
  created_at: ['created_at', 'date', 'sana', 'дата', 'created', 'yaratilgan'],
  first_response_at: ['first_response_at', 'birinchi_javob', 'first_contact'],
  won_at: ['won_at', 'sotilgan', 'sale_date', 'дата продажи'],
  amount: ['amount', 'summa', 'сумма', 'price', 'value'],
  paid_at: ['paid_at', "to'langan", 'tolangan', 'дата оплаты', 'payment_date'],
  due_date: ['due_date', 'muddat', 'срок'],
  method: ['method', 'usul', 'способ', 'payment_method'],
  spend: ['spend', 'xarajat', 'расход', 'cost'],
  impressions: ['impressions', "ko'rishlar", 'показы'],
  clicks: ['clicks', 'kliklar', 'клики'],
  leads: ['leads', 'lidlar', 'лиды'],
};

function headerMap(header: string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((h, idx) => {
    const norm = h.trim().toLowerCase();
    for (const [canon, aliases] of Object.entries(ALIASES)) {
      if (!map.has(canon) && aliases.includes(norm)) map.set(canon, idx);
    }
  });
  return map;
}

function parseDate(v: string | undefined): Date | null {
  if (!v || !v.trim()) return null;
  const s = v.trim();
  // 07.10.2026 yoki 07.10.2026 14:30
  const dmY = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (dmY) {
    const [, d, m, y, hh, mm] = dmY;
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${(hh ?? '12').padStart(2, '0')}:${mm ?? '00'}:00+05:00`);
  }
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00+05:00` : s);
  return Number.isNaN(t.getTime()) ? null : t;
}

function parseNumber(v: string | undefined): number {
  if (!v) return 0;
  return Number(v.replace(/\s/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/[^\d.-]/g, '')) || 0;
}

function leadStatus(v: string | undefined): LeadStatus | undefined {
  const s = (v ?? '').toLowerCase();
  if (!s) return undefined;
  if (/(won|sotildi|успешно|оплат|продан)/.test(s)) return 'won';
  if (/(lost|yo'qot|отказ|закрыто)/.test(s)) return 'lost';
  if (/(trial|sinov|пробн)/.test(s)) return 'trial';
  if (/(new|yangi|нов)/.test(s)) return 'new';
  return 'contacted';
}

function paymentStatus(v: string | undefined): PaymentStatus {
  const s = (v ?? '').toLowerCase();
  if (/(refund|qaytar|возврат)/.test(s)) return 'refunded';
  if (/(pending|kutil|ожида)/.test(s)) return 'pending';
  if (/(overdue|kechik|просроч)/.test(s)) return 'overdue';
  if (/(fail|xato|ошибка)/.test(s)) return 'failed';
  return 'paid';
}

export interface CsvImportResult {
  records: NormalizedRecord[];
  errors: Array<{ row: number; error: string }>;
}

export function csvToRecords(kind: CsvKind, text: string, sourceName = 'csv_import'): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { records: [], errors: [{ row: 0, error: "Fayl bo'sh yoki sarlavha yo'q" }] };
  const h = headerMap(rows[0]);
  const get = (r: string[], k: string) => (h.has(k) ? r[h.get(k)!]?.trim() : undefined);
  const records: NormalizedRecord[] = [];
  const errors: CsvImportResult['errors'] = [];

  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    try {
      if (kind === 'leads') {
        const phone = get(r, 'phone');
        const created = parseDate(get(r, 'created_at'));
        if (!phone && !get(r, 'email')) throw new Error('telefon yoki email kerak');
        const rec: LeadRecord = {
          kind: 'lead',
          source: sourceName,
          externalId: get(r, 'id') || `${phone}-${created?.toISOString() ?? rowNo}`,
          contact: { name: get(r, 'name'), phone, email: get(r, 'email') },
          campaignName: get(r, 'campaign') || null,
          segment: get(r, 'segment') || null,
          productHint: [get(r, 'segment'), get(r, 'campaign')].filter(Boolean).join(' ') || null,
          status: leadStatus(get(r, 'status')),
          createdAt: created ?? new Date(),
          firstResponseAt: parseDate(get(r, 'first_response_at')),
          wonAt: parseDate(get(r, 'won_at')),
          value: get(r, 'amount') ? parseNumber(get(r, 'amount')) : null,
        };
        records.push(rec);
      } else if (kind === 'payments') {
        const amount = parseNumber(get(r, 'amount'));
        if (!amount) throw new Error('summa kerak');
        const rec: PaymentRecord = {
          kind: 'payment',
          source: sourceName,
          externalId: get(r, 'id') || `${get(r, 'phone')}-${get(r, 'paid_at') ?? get(r, 'due_date')}-${amount}`,
          contact: { name: get(r, 'name'), phone: get(r, 'phone'), email: get(r, 'email') },
          amount,
          status: paymentStatus(get(r, 'status')),
          method: get(r, 'method') || null,
          paidAt: parseDate(get(r, 'paid_at')),
          dueDate: get(r, 'due_date') ? parseDate(get(r, 'due_date'))!.toISOString().slice(0, 10) : null,
          productHint: get(r, 'segment') || null,
        };
        records.push(rec);
      } else {
        const date = parseDate(get(r, 'created_at'));
        const campaign = get(r, 'campaign');
        if (!date || !campaign) throw new Error('sana va kampaniya kerak');
        const rec: AdMetricsRecord = {
          kind: 'ad_metrics',
          source: get(r, 'source') || sourceName,
          campaignExternalId: campaign,
          campaignName: campaign,
          date: new Date(date.getTime() + 5 * 3_600_000).toISOString().slice(0, 10),
          spend: parseNumber(get(r, 'spend')),
          impressions: parseNumber(get(r, 'impressions')),
          clicks: parseNumber(get(r, 'clicks')),
          leads: parseNumber(get(r, 'leads')),
        };
        records.push(rec);
      }
    } catch (err) {
      errors.push({ row: rowNo, error: (err as Error).message });
    }
  });
  return { records, errors };
}

export const CSV_TEMPLATES: Record<CsvKind, string> = {
  leads: 'id,name,phone,source,campaign,segment,status,manager,created_at,first_response_at,won_at,amount\nL-1001,Ali Valiyev,+998901234567,instagram,IELTS September,IELTS,sotildi,Aziz,2026-09-10 11:20,2026-09-10 11:28,2026-09-14,1800000\n',
  payments: 'id,name,phone,amount,status,paid_at,due_date,method,segment\nP-501,Ali Valiyev,+998901234567,1800000,paid,2026-09-14,,payme,IELTS\n',
  ad_metrics: 'created_at,source,campaign,spend,impressions,clicks,leads\n2026-10-01,meta_ads,IELTS September,64000,25000,410,9\n',
};
