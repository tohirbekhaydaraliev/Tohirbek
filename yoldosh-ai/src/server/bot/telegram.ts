import type { Db } from '../db';
import type { ActionView, Diagnosis } from '../../shared/types';
import { notifyOwner } from '../actions/channels';
import { approveAction, getAction, listActions, rejectAction } from '../actions/service';
import { chat } from '../agents/chat';
import { runDiagnosis } from '../brain/service';
import { connectorFetch, getActiveConnector } from '../connectors/registry';
import { tgCall, tgSendMessage, type TelegramConfig } from '../connectors/telegram';
import type { ConnectorRow } from '../connectors/types';
import { config } from '../config';
import { errorMessage, fmtMoney } from '../lib/util';

/**
 * Telegram bot — rahbar uchun Yo'ldosh AI'ning mobil interfeysi:
 *  - kunlik diagnostika (ertalab), tasdiq kutayotgan harakatlar inline tugmalar bilan
 *  - ✅/❌ tugmalari orqali harakatlarni tasdiqlash
 *  - erkin savol → CEO Agent javobi
 */

const RISK = { low: '🟢 past', medium: '🟡 o‘rta', high: '🔴 yuqori' } as const;

/** Markdown belgilarini oddiy matnga aylantirish (Telegram'ga parse_mode'siz yuboramiz). */
export function plain(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/_(.+?)_/g, '$1');
}

function actionKeyboard(a: ActionView) {
  return { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: `a:${a.id}` }, { text: '❌ Rad etish', callback_data: `r:${a.id}` }]] };
}

function actionText(a: ActionView): string {
  return `⚡ ${a.title}\nXavf: ${RISK[a.risk]}${a.expectedImpact ? `\nKutilgan natija: ${a.expectedImpact}` : ''}${a.rationale ? `\n\n${a.rationale.slice(0, 600)}` : ''}`;
}

export async function sendDailyDigest(db: Db, businessId: string, d: Diagnosis): Promise<void> {
  const revenue = d.kpis.find((k) => k.key === 'revenue');
  const header = `☀️ Yo'ldosh AI — kunlik diagnostika\n${revenue?.current ? `Daromad (${d.windowDays} kun): ${fmtMoney(revenue.current)}` : ''}\n\n`;
  const res = await notifyOwner({ db, businessId }, header + plain(d.narrative ?? '') + `\n\nBatafsil: ${config.publicUrl}`);
  if (res.status !== 'sent') return;
  const pending = await listActions(db, businessId, { status: 'pending', limit: 5 });
  for (const a of pending) await notifyOwner({ db, businessId, actionId: a.id }, actionText(a), actionKeyboard(a));
}

export async function setTelegramWebhook(db: Db, businessId: string, connectorId: string) {
  const tg = await getActiveConnector(db, businessId, 'telegram');
  if (!tg || tg.row.id !== connectorId) throw new Error('Faol Telegram connector topilmadi');
  const url = `${config.publicUrl}/api/webhooks/telegram/${connectorId}`;
  if (!url.startsWith('https://')) throw new Error(`Telegram webhook uchun PUBLIC_URL https bo'lishi kerak (hozir: ${config.publicUrl})`);
  await tgCall(connectorFetch(), tg.config.botToken, 'setWebhook', {
    url,
    allowed_updates: ['message', 'callback_query'],
    ...(tg.config.webhookSecret ? { secret_token: tg.config.webhookSecret } : {}),
  });
  return { url };
}

export async function handleTelegramUpdate(db: Db, row: ConnectorRow, cfg: TelegramConfig, update: any): Promise<void> {
  const fetchFn = connectorFetch();
  const businessId = row.business_id;
  const owner = cfg.ownerChatId ? String(cfg.ownerChatId) : null;
  const send = (chatId: string | number, text: string, replyMarkup?: unknown) => tgSendMessage(fetchFn, cfg.botToken, chatId, text, { replyMarkup });

  // Inline tugmalar: tasdiqlash / rad etish
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message?.chat?.id ?? cq.from?.id);
    if (!owner || chatId !== owner) {
      await tgCall(fetchFn, cfg.botToken, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Ruxsat yo‘q' });
      return;
    }
    const [op, actionId] = String(cq.data ?? '').split(':');
    try {
      const action = op === 'a' ? await approveAction(db, businessId, actionId, 'Rahbar (Telegram)') : await rejectAction(db, businessId, actionId, 'Rahbar (Telegram)');
      await tgCall(fetchFn, cfg.botToken, 'answerCallbackQuery', { callback_query_id: cq.id, text: op === 'a' ? 'Tasdiqlandi' : 'Rad etildi' });
      const result = (action.result as any)?.summary ?? action.error ?? '';
      await send(chatId, `${op === 'a' ? '✅ Bajarildi' : '❌ Rad etildi'}: ${action.title}${result ? `\n${result}` : ''}`);
    } catch (err) {
      const current = await getAction(db, businessId, actionId);
      await tgCall(fetchFn, cfg.botToken, 'answerCallbackQuery', { callback_query_id: cq.id, text: current ? `Holat: ${current.status}` : errorMessage(err) });
    }
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text).trim();

  if (text.startsWith('/start')) {
    await send(chatId, `Assalomu alaykum! Men — Yo'ldosh AI.\nSizning chat ID: ${chatId}\n\nRahbar bo'lsangiz, bu ID ni Integratsiyalar → Telegram sozlamasiga kiriting. Xodim bo'lsangiz — rahbarga yuboring, u sizga vazifa va ogohlantirishlarni shu yerga yuboradi.`);
    return;
  }
  if (!owner || chatId !== owner) {
    await send(chatId, `Bu bot faqat rahbar uchun savol-javob qiladi. Sizning chat ID: ${chatId}`);
    return;
  }
  if (text.startsWith('/diagnoz')) {
    await send(chatId, '🔎 Biznesni tekshiryapman...');
    const d = await runDiagnosis(db, businessId, { kind: 'adhoc' });
    await send(chatId, plain(d.narrative ?? ''));
    return;
  }
  if (text.startsWith('/tasdiq')) {
    const pending = await listActions(db, businessId, { status: 'pending', limit: 10 });
    if (!pending.length) await send(chatId, "Tasdiq kutayotgan harakat yo'q.");
    for (const a of pending) await send(chatId, actionText(a), actionKeyboard(a));
    return;
  }
  await tgCall(fetchFn, cfg.botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const answer = await chat(db, businessId, `tg_${row.id}_${chatId}`.slice(0, 60), text);
  await send(chatId, plain(answer.text));
  for (const a of answer.actions.filter((x) => x.status === 'proposed')) await send(chatId, actionText(a), actionKeyboard(a));
}
