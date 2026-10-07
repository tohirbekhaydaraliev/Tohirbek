import type { Db } from '../db';
import type { AgentStep, ChatMessageView } from '../../shared/types';
import { listActions } from '../actions/service';
import { newId } from '../lib/util';
import type { MessageParam } from './llm';

/**
 * CEO suhbatlari. `content` — API'ga aynan qayta yuboriladigan JSON matn (TEXT ustun:
 * jsonb kalitlar tartibini o'zgartiradi, bu esa prompt cache va thinking bloklarini buzadi).
 * `display` — UI uchun yakuniy matn (oraliq tool qadamlarida bo'sh).
 */

export async function createConversation(db: Db, businessId: string, opts: { title?: string; channel?: string; id?: string } = {}) {
  const id = opts.id ?? newId('cnv');
  await db.query(`INSERT INTO conversations (id, business_id, title, channel) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [
    id,
    businessId,
    opts.title ?? 'Yangi suhbat',
    opts.channel ?? 'web',
  ]);
  return id;
}

export async function listConversations(db: Db, businessId: string) {
  const rows = await db.query<any>(
    `SELECT c.id, c.title, c.channel, c.updated_at,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.display IS NOT NULL) AS messages
       FROM conversations c WHERE c.business_id = $1 AND c.channel = 'web' ORDER BY c.updated_at DESC LIMIT 50`,
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, channel: r.channel, updatedAt: new Date(r.updated_at).toISOString(), messages: r.messages }));
}

export async function loadHistory(db: Db, conversationId: string): Promise<MessageParam[]> {
  const rows = await db.query<{ content: string }>('SELECT content FROM messages WHERE conversation_id = $1 ORDER BY seq', [conversationId]);
  return rows.map((r) => JSON.parse(r.content) as MessageParam);
}

export async function appendMessages(
  db: Db,
  businessId: string,
  conversationId: string,
  messages: Array<{ message: MessageParam; display?: string | null; meta?: Record<string, unknown> }>,
) {
  for (const m of messages) {
    await db.query(
      `INSERT INTO messages (id, conversation_id, business_id, role, content, display, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId('msg'), conversationId, businessId, m.message.role, JSON.stringify(m.message), m.display ?? null, m.meta ?? {}],
    );
  }
  await db.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
}

export async function renameIfNew(db: Db, conversationId: string, firstQuestion: string) {
  const title = firstQuestion.replace(/\s+/g, ' ').trim().slice(0, 60);
  await db.query(`UPDATE conversations SET title = $2 WHERE id = $1 AND title = 'Yangi suhbat'`, [conversationId, title || 'Suhbat']);
}

export async function getConversation(db: Db, businessId: string, id: string): Promise<{ id: string; title: string; messages: ChatMessageView[] } | null> {
  const conv = await db.one<any>('SELECT * FROM conversations WHERE business_id = $1 AND id = $2', [businessId, id]);
  if (!conv) return null;
  const rows = await db.query<any>(
    `SELECT id, role, display, meta, created_at FROM messages WHERE conversation_id = $1 AND display IS NOT NULL ORDER BY seq`,
    [id],
  );
  const actionIds = rows.flatMap((r) => (Array.isArray(r.meta?.actionIds) ? r.meta.actionIds : []));
  const actions = actionIds.length ? await listActions(db, businessId, { ids: actionIds, limit: 200 }) : [];
  return {
    id: conv.id,
    title: conv.title,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      text: r.display,
      steps: (r.meta?.steps ?? []) as AgentStep[],
      actions: actions.filter((a) => (r.meta?.actionIds ?? []).includes(a.id)),
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

export async function deleteConversation(db: Db, businessId: string, id: string) {
  await db.query('DELETE FROM conversations WHERE business_id = $1 AND id = $2', [businessId, id]);
}
