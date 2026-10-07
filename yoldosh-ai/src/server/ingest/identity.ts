import type { Db } from '../db';
import { newId, now } from '../lib/util';

/**
 * Identity resolution — turli tizimlardan kelgan bir odamni yagona Customer ID'ga bog'lash.
 * Meta lead (telefon: "90 123 45 67") + CRM kontakt ("+998901234567") + Payme to'lovi
 * (998901234567) => bitta mijoz.
 */

export function normalizePhone(raw: string | null | undefined, countryCode = '998'): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  // O'zbekiston: 9 xonali mahalliy raqam (90 123 45 67)
  if (digits.length === 9 && countryCode === '998') digits = countryCode + digits;
  // 8 (9x) ... ko'rinishidagi eski format
  if (digits.length === 10 && digits.startsWith('8') && countryCode === '998') digits = countryCode + digits.slice(1);
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export function normalizeTelegram(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').toLowerCase();
  return /^[a-z0-9_]{4,32}$/.test(v) ? v : null;
}

export interface ContactInfo {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  telegram?: string | null;
  telegramChatId?: string | null;
  /** Manbadagi tashqi identifikatorlar, masalan {kind: 'amocrm_contact', value: '123'} */
  externalIds?: Array<{ kind: string; value: string }>;
}

interface Key {
  kind: string;
  value: string;
}

function keysFor(contact: ContactInfo): Key[] {
  const keys: Key[] = [];
  const phone = normalizePhone(contact.phone);
  const email = normalizeEmail(contact.email);
  const tg = normalizeTelegram(contact.telegram);
  if (phone) keys.push({ kind: 'phone', value: phone });
  if (email) keys.push({ kind: 'email', value: email });
  if (tg) keys.push({ kind: 'telegram', value: tg });
  if (contact.telegramChatId) keys.push({ kind: 'telegram_chat', value: String(contact.telegramChatId) });
  for (const ext of contact.externalIds ?? []) {
    if (ext.value) keys.push({ kind: ext.kind, value: String(ext.value) });
  }
  return keys;
}

/** Customer ID'ga bog'langan barcha jadvallar — birlashtirish (merge) uchun. */
const CUSTOMER_FK_TABLES = ['leads', 'interactions', 'subscriptions', 'payments', 'tasks', 'notifications'] as const;

async function mergeCustomers(db: Db, businessId: string, keepId: string, dropId: string): Promise<void> {
  for (const table of CUSTOMER_FK_TABLES) {
    const col = table === 'notifications' ? 'recipient_customer_id' : 'customer_id';
    await db.query(`UPDATE ${table} SET ${col} = $1 WHERE business_id = $2 AND ${col} = $3`, [keepId, businessId, dropId]);
  }
  // davomat: birlamchi kalit to'qnashuvini oldini olish
  await db.query(
    `INSERT INTO attendance (business_id, customer_id, group_id, date, present)
     SELECT business_id, $1, group_id, date, present FROM attendance WHERE customer_id = $2
     ON CONFLICT DO NOTHING`,
    [keepId, dropId],
  );
  await db.query(`DELETE FROM attendance WHERE customer_id = $1`, [dropId]);
  await db.query(
    `UPDATE customer_identities SET customer_id = $1 WHERE business_id = $2 AND customer_id = $3`,
    [keepId, businessId, dropId],
  );
  await db.query(
    `UPDATE customers k SET
        full_name = COALESCE(k.full_name, d.full_name),
        phone = COALESCE(k.phone, d.phone),
        email = COALESCE(k.email, d.email),
        telegram = COALESCE(k.telegram, d.telegram),
        telegram_chat_id = COALESCE(k.telegram_chat_id, d.telegram_chat_id),
        first_seen_at = LEAST(k.first_seen_at, d.first_seen_at),
        first_campaign_id = COALESCE(k.first_campaign_id, d.first_campaign_id)
       FROM customers d WHERE k.id = $1 AND d.id = $2`,
    [keepId, dropId],
  );
  await db.query(`DELETE FROM customers WHERE id = $1`, [dropId]);
}

export interface ResolveOptions {
  source: string;
  seenAt?: Date;
  campaignId?: string | null;
}

export interface ResolveResult {
  customerId: string;
  created: boolean;
  merged: string[];
}

/**
 * Kontakt ma'lumotlari bo'yicha mijozni topadi yoki yaratadi.
 * Bir nechta mijozga mos kelsa — eng eskisiga birlashtiriladi (Customer 360 yaxlitligi).
 */
export async function resolveCustomer(
  db: Db,
  businessId: string,
  contact: ContactInfo,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const keys = keysFor(contact);
  const seenAt = opts.seenAt ?? now();

  let matches: Array<{ customer_id: string; created_at: Date }> = [];
  if (keys.length > 0) {
    const kinds = keys.map((k) => k.kind);
    const values = keys.map((k) => k.value);
    matches = await db.query(
      `SELECT DISTINCT ci.customer_id, c.created_at
         FROM customer_identities ci
         JOIN customers c ON c.id = ci.customer_id
         JOIN unnest($2::text[], $3::text[]) AS k(kind, value) ON k.kind = ci.kind AND k.value = ci.value
        WHERE ci.business_id = $1
        ORDER BY c.created_at`,
      [businessId, kinds, values],
    );
  }

  let customerId: string;
  let created = false;
  const merged: string[] = [];

  if (matches.length === 0) {
    customerId = newId('cus');
    created = true;
    await db.query(
      `INSERT INTO customers (id, business_id, full_name, phone, email, telegram, telegram_chat_id, source, first_campaign_id, first_seen_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        customerId,
        businessId,
        contact.name?.trim() || null,
        normalizePhone(contact.phone),
        normalizeEmail(contact.email),
        normalizeTelegram(contact.telegram),
        contact.telegramChatId ?? null,
        opts.source,
        opts.campaignId ?? null,
        seenAt,
      ],
    );
  } else {
    customerId = matches[0].customer_id;
    for (const extra of matches.slice(1)) {
      if (extra.customer_id === customerId) continue;
      await mergeCustomers(db, businessId, customerId, extra.customer_id);
      merged.push(extra.customer_id);
    }
    await db.query(
      `UPDATE customers SET
          full_name = COALESCE(full_name, $2),
          phone = COALESCE(phone, $3),
          email = COALESCE(email, $4),
          telegram = COALESCE(telegram, $5),
          telegram_chat_id = COALESCE(telegram_chat_id, $6),
          first_campaign_id = COALESCE(first_campaign_id, $7),
          first_seen_at = LEAST(first_seen_at, $8)
        WHERE id = $1`,
      [
        customerId,
        contact.name?.trim() || null,
        normalizePhone(contact.phone),
        normalizeEmail(contact.email),
        normalizeTelegram(contact.telegram),
        contact.telegramChatId ?? null,
        opts.campaignId ?? null,
        seenAt,
      ],
    );
  }

  for (const key of keys) {
    await db.query(
      `INSERT INTO customer_identities (id, business_id, customer_id, kind, value, source)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (business_id, kind, value) DO NOTHING`,
      [newId('cid'), businessId, customerId, key.kind, key.value, opts.source],
    );
  }

  return { customerId, created, merged };
}
