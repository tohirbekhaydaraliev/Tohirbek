import { timingSafeEqual } from 'node:crypto';
import { fetchJson, type ConnectorDefinition, type FetchLike } from './types';

/**
 * Telegram Bot — O'zbekistonda asosiy aloqa kanali.
 * - Xodimlarga bildirishnoma va vazifalar (Action Layer)
 * - Mijozlarga eslatmalar (tasdiq bilan)
 * - Rahbar uchun: kunlik diagnostika, harakatlarni Telegram'da tasdiqlash, AI'ga savol berish
 */

export interface TelegramConfig {
  botToken: string;
  ownerChatId?: string;
  webhookSecret?: string;
}

const API = 'https://api.telegram.org';

export async function tgCall<T = any>(fetchFn: FetchLike, token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetchJson<{ ok: boolean; result: T; description?: string }>(fetchFn, `${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(res.description ?? 'Telegram xatosi');
  return res.result;
}

/** Telegram 4096 belgidan uzun xabarni qabul qilmaydi. */
export function chunkText(text: string, size = 3900): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function tgSendMessage(
  fetchFn: FetchLike,
  token: string,
  chatId: string | number,
  text: string,
  opts: { replyMarkup?: unknown } = {},
) {
  const chunks = chunkText(text);
  let last: any = null;
  for (let i = 0; i < chunks.length; i++) {
    last = await tgCall(fetchFn, token, 'sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      disable_web_page_preview: true,
      ...(i === chunks.length - 1 && opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
  }
  return last;
}

export function verifyTelegramSecret(header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  if (!header || header.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(secret));
}

export const telegramConnector: ConnectorDefinition = {
  type: 'telegram',
  label: 'Telegram Bot',
  category: 'messaging',
  description:
    "Xodimlarga vazifa va ogohlantirishlar, mijozlarga eslatmalar yuboriladi. Rahbar har kuni ertalab diagnostikani oladi, harakatlarni Telegram'dan tasdiqlaydi va AI'ga to'g'ridan-to'g'ri savol beradi.",
  configFields: [
    { key: 'botToken', label: 'Bot token', type: 'secret', required: true, help: '@BotFather → /newbot' },
    { key: 'ownerChatId', label: 'Rahbar chat ID', type: 'text', help: "Botga /start yozing — bot chat ID'ni ko'rsatadi" },
    { key: 'webhookSecret', label: 'Webhook maxfiy kaliti', type: 'secret', help: 'Ixtiyoriy, setWebhook secret_token sifatida ishlatiladi' },
  ],
  capabilities: { sync: false, webhook: true, actions: ['notify_employee', 'send_customer_message', 'send_payment_reminder'] },

  async test(ctx) {
    const cfg = ctx.config as TelegramConfig;
    const me = await tgCall(ctx.fetch, cfg.botToken, 'getMe', {});
    return { ok: true, message: `Bot: @${me.username}` };
  },

  async handleWebhook(ctx, req) {
    const cfg = ctx.config as TelegramConfig;
    if (!verifyTelegramSecret(req.headers['x-telegram-bot-api-secret-token'], cfg.webhookSecret)) {
      return { response: { status: 401, body: 'secret mos emas' }, handled: true };
    }
    const update = JSON.parse(req.rawBody || '{}');
    // Bot mantiqi ilova qatlamida (bot/telegramBot.ts) bajariladi
    return { response: { status: 200, body: 'ok' }, handled: true, payload: update, eventType: 'telegram_update' };
  },
};
