import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectorDefinition, PaymentRecord, PaymentStatus } from './types';

/**
 * Universal to'lovlar webhook'i — Payme/Click/Uzum middleware, 1C, bank yoki
 * o'z tizimingiz shu formatda to'lovlarni yuboradi:
 *
 *   POST /api/webhooks/payments/:connectorId
 *   X-Yoldosh-Signature: sha256=<HMAC-SHA256(secret, body)>
 *   { "id": "pay-123", "amount": 1800000, "status": "paid", "paid_at": "2026-10-01T10:00:00+05:00",
 *     "phone": "+998901234567", "name": "Ali Valiyev", "method": "payme", "product": "IELTS" }
 *
 * yoki { "payments": [ ... ] } ko'rinishida bir nechtasini.
 */

export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifyPaymentSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = signPayload(secret, body);
  const got = header.startsWith('sha256=') ? header : `sha256=${header}`;
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

const STATUSES: PaymentStatus[] = ['paid', 'pending', 'overdue', 'refunded', 'failed'];

export function mapPaymentPayload(p: any, defaultMethod?: string): PaymentRecord {
  if (!p || p.id === undefined || p.amount === undefined) throw new Error("To'lovda 'id' va 'amount' majburiy");
  const status = STATUSES.includes(p.status) ? (p.status as PaymentStatus) : 'paid';
  return {
    kind: 'payment',
    source: String(p.source ?? 'payments_webhook'),
    externalId: String(p.id),
    contact: { name: p.name ?? null, phone: p.phone ?? null, email: p.email ?? null },
    amount: Number(p.amount),
    status,
    method: p.method ?? defaultMethod ?? null,
    paidAt: p.paid_at ? new Date(p.paid_at) : status === 'paid' ? new Date() : null,
    dueDate: p.due_date ?? null,
    productHint: p.product ?? null,
  };
}

export const paymentsConnector: ConnectorDefinition = {
  type: 'payments',
  label: "To'lovlar webhook (Payme / Click / 1C / bank)",
  category: 'finance',
  description:
    "Har qanday to'lov tizimi yoki 1C bu manzilga to'lovlarni yuboradi. Mijoz telefon raqami orqali avtomatik ravishda Customer 360 bilan bog'lanadi.",
  configFields: [
    { key: 'secret', label: 'HMAC maxfiy kalit', type: 'secret', required: true, help: 'X-Yoldosh-Signature sarlavhasi shu kalit bilan imzolanadi' },
    { key: 'defaultMethod', label: "Standart to'lov usuli", type: 'select', options: ['payme', 'click', 'uzum', 'bank', 'cash'], default: 'payme' },
  ],
  capabilities: { sync: false, webhook: true, actions: [] },

  async handleWebhook(ctx, req) {
    const secret = ctx.config.secret as string | undefined;
    if (!secret || !verifyPaymentSignature(secret, req.rawBody, req.headers['x-yoldosh-signature'])) {
      return { response: { status: 401, body: JSON.stringify({ ok: false, error: 'imzo noto‘g‘ri' }), contentType: 'application/json' }, handled: true };
    }
    const body = JSON.parse(req.rawBody || '{}');
    const list: any[] = Array.isArray(body.payments) ? body.payments : [body];
    const records = list.map((p) => mapPaymentPayload(p, ctx.config.defaultMethod));
    return {
      response: { status: 200, body: JSON.stringify({ ok: true, accepted: records.length }), contentType: 'application/json' },
      records,
      eventId: `payments:${records.map((r) => `${r.externalId}:${r.status}`).join(',')}`,
      eventType: 'payment',
    };
  },
};
