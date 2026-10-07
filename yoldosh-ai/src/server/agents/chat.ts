import type { Db } from '../db';
import type { ActionView, AgentStep, ChatMessageView } from '../../shared/types';
import { errorMessage, now } from '../lib/util';
import { CEO_SYSTEM, ceoTools } from './ceo';
import { appendMessages, createConversation, getConversation, loadHistory, renameIfNew } from './conversations';
import { aiEnabled, runAgent, type AgentEvent, type MessageParam } from './llm';
import { offlineAnswer } from './offline';

export type ChatEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'text'; text: string }
  | { type: 'text_reset' }
  | { type: 'action'; action: ActionView }
  | { type: 'done'; message: ChatMessageView }
  | { type: 'error'; error: string };

/**
 * CEO bilan suhbat: savol → CEO Agent (kerak bo'lsa mutaxassis agentlar) → javob + harakatlar.
 * Barcha qadamlar real vaqtda (SSE) UI'ga uzatiladi.
 */
export async function chat(
  db: Db,
  businessId: string,
  conversationId: string,
  text: string,
  onEvent: (e: ChatEvent) => void = () => {},
): Promise<ChatMessageView> {
  await createConversation(db, businessId, { id: conversationId });
  await renameIfNew(db, conversationId, text);
  const userMessage: MessageParam = { role: 'user', content: [{ type: 'text', text: `[Sana: ${now().toISOString().slice(0, 10)}]\n${text}` }] };

  if (!aiEnabled()) {
    const answer = await offlineAnswer(db, businessId, text);
    onEvent({ type: 'text', text: answer });
    await appendMessages(db, businessId, conversationId, [
      { message: userMessage, display: text },
      { message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, display: answer, meta: { steps: [], actionIds: [], offline: true } },
    ]);
    return finish(db, businessId, conversationId, onEvent);
  }

  const steps: AgentStep[] = [];
  const actionIds: string[] = [];
  const pushStep = (step: AgentStep) => {
    steps.push(step);
    onEvent({ type: 'step', step });
  };
  const handle = (e: AgentEvent) => {
    const at = now().toISOString();
    if (e.type === 'text' && e.agent === 'CEO Agent' && e.text) onEvent({ type: 'text', text: e.text });
    else if (e.type === 'text_reset' && e.agent === 'CEO Agent') onEvent({ type: 'text_reset' });
    else if (e.type === 'agent_start' && e.agent !== 'CEO Agent') pushStep({ agent: e.agent, kind: 'start', label: `${e.agent} ishga tushdi`, at });
    else if (e.type === 'agent_end' && e.agent !== 'CEO Agent') pushStep({ agent: e.agent, kind: 'done', label: `${e.agent} hisobot berdi`, at });
    else if (e.type === 'tool' && e.label) pushStep({ agent: e.agent, kind: 'tool', label: e.label, at });
  };

  const history = await loadHistory(db, conversationId);
  try {
    const res = await runAgent({
      agent: 'CEO Agent',
      system: CEO_SYSTEM,
      tools: ceoTools(
        {
          db,
          businessId,
          onAction: (a) => {
            actionIds.push(a.id);
            onEvent({ type: 'action', action: a });
          },
        },
        handle,
      ),
      messages: [...history, userMessage],
      effort: 'high',
      maxIterations: 10,
      streamText: true,
      onEvent: handle,
    });
    const answer = res.text || "Javob tayyorlanmadi — savolni qayta yuboring.";
    const turns = res.newMessages.map((m) => ({ message: m }));
    // Yakuniy assistant xabariga ko'rinadigan matn va meta biriktiriladi
    const lastAssistant = [...turns].reverse().find((t) => t.message.role === 'assistant');
    if (lastAssistant) Object.assign(lastAssistant, { display: answer, meta: { steps, actionIds, usage: res.usage } });
    else turns.push({ message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, display: answer, meta: { steps, actionIds } } as any);
    await appendMessages(db, businessId, conversationId, [{ message: userMessage, display: text }, ...turns]);
  } catch (err) {
    const msg = errorMessage(err);
    onEvent({ type: 'error', error: msg });
    // Xato bo'lsa ham savolni yo'qotmaymiz: zaxira javob bilan saqlaymiz
    const fallback = `AI xizmatida xato: ${msg}\n\n${await offlineAnswer(db, businessId, text)}`;
    await appendMessages(db, businessId, conversationId, [
      { message: userMessage, display: text },
      { message: { role: 'assistant', content: [{ type: 'text', text: fallback }] }, display: fallback, meta: { steps, actionIds, error: msg } },
    ]);
  }
  return finish(db, businessId, conversationId, onEvent);
}

async function finish(db: Db, businessId: string, conversationId: string, onEvent: (e: ChatEvent) => void) {
  const conv = await getConversation(db, businessId, conversationId);
  const last = conv!.messages[conv!.messages.length - 1];
  onEvent({ type: 'done', message: last });
  return last;
}

/** Bir martalik savol (Telegram bot uchun) — natijani matn sifatida qaytaradi. */
export async function ask(db: Db, businessId: string, conversationId: string, text: string): Promise<ChatMessageView> {
  return chat(db, businessId, conversationId, text);
}
