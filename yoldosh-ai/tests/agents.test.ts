import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/server/db/client';
import { chat, type ChatEvent } from '../src/server/agents/chat';
import { runAgent, setClient } from '../src/server/agents/llm';
import { z } from 'zod';
import { demoDb } from './helpers';

/**
 * Soxta Anthropic klienti: beta.messages.stream() → oldindan yozilgan javoblar.
 * Haqiqiy API'ga so'rov yubormasdan agent siklini, tool bajarilishini,
 * parallel tool natijalarini va tarixni saqlashni tekshiradi.
 */
type Scripted = Array<{ stop_reason: string; content: any[] }>;

function fakeClient(script: Scripted, requests: any[]) {
  let i = 0;
  const stream = (params: any) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const step = script[Math.min(i++, script.length - 1)];
    const handlers: Record<string, Array<(x: any) => void>> = {};
    return {
      on(event: string, cb: (x: any) => void) {
        (handlers[event] ??= []).push(cb);
        return this;
      },
      async finalMessage() {
        for (const block of step.content) if (block.type === 'text') handlers.text?.forEach((h) => h(block.text));
        return {
          id: `msg_${i}`,
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: step.content,
          stop_reason: step.stop_reason,
          stop_details: null,
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
        };
      },
    };
  };
  return { beta: { messages: { stream } } } as unknown as Anthropic;
}

let db: Db;
let businessId: string;
beforeAll(async () => {
  ({ db, businessId } = await demoDb());
});
afterAll(async () => {
  setClient(null);
  await db.close();
});

describe('agent sikli (runAgent)', () => {
  it("parallel tool chaqiruvlari bitta user xabarida qaytadi, noto'g'ri kirish is_error bo'ladi", async () => {
    const requests: any[] = [];
    setClient(
      fakeClient(
        [
          {
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 't1', name: 'add', input: { a: 2, b: 3 } },
              { type: 'tool_use', id: 't2', name: 'add', input: { a: 'x' } },
            ],
          },
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Natija: 5' }] },
        ],
        requests,
      ),
    );
    const add = { name: 'add', description: 'Qo‘shish', inputSchema: z.object({ a: z.number(), b: z.number() }), run: async (x: { a: number; b: number }) => ({ sum: x.a + x.b }) };
    const res = await runAgent({ agent: 'test', system: 'sys', tools: [add], messages: [{ role: 'user', content: 'hisobla' }] });
    expect(res.text).toBe('Natija: 5');
    const toolTurn = requests[1].messages[2];
    expect(toolTurn.role).toBe('user');
    expect(toolTurn.content).toHaveLength(2);
    expect(toolTurn.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: '{"sum":5}' });
    expect(toolTurn.content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 't2', is_error: true });
    // So'rov parametrlari: model, adaptive thinking, refusal fallback, eager tool streaming
    expect(requests[0]).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(requests[0].tools[0]).toMatchObject({ name: 'add', eager_input_streaming: true, input_schema: { type: 'object' } });
  });

  it('refusal holati xavfsiz matn bilan yakunlanadi', async () => {
    setClient(fakeClient([{ stop_reason: 'refusal', content: [] }], []));
    const res = await runAgent({ agent: 'test', system: 's', tools: [], messages: [{ role: 'user', content: 'x' }] });
    expect(res.stopReason).toBe('refusal');
    expect(res.text).toMatch(/bajara olmayman/);
  });
});

describe('CEO Agent chat', () => {
  it('tool → harakat taklifi → javob; tarix aynan saqlanadi va keyingi savolda qayta yuboriladi', async () => {
    const requests: any[] = [];
    const leads = await db.query<{ id: string }>(`SELECT id FROM leads WHERE business_id = $1 AND status = 'new' AND first_response_at IS NULL LIMIT 2`, [businessId]);
    setClient(
      fakeClient(
        [
          { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig1' }, { type: 'tool_use', id: 'c1', name: 'get_kpi_summary', input: { days: 30 } }] },
          {
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'c2',
                name: 'propose_action',
                input: { type: 'create_task', title: 'Javobsiz leadlar bo‘yicha vazifa', params: { title: 'Leadlarga javob bering', leadIds: leads.map((l) => l.id) }, rationale: 'Javob vaqti 50 daqiqaga oshgan' },
              },
            ],
          },
          { stop_reason: 'end_turn', content: [{ type: 'text', text: '**Xulosa:** daromad IELTS javob vaqti sababli tushgan. Vazifa yaratildi.' }] },
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ikkinchi javob' }] },
        ],
        requests,
      ),
    );
    const events: ChatEvent[] = [];
    const msg = await chat(db, businessId, 'cnv_test', 'Nega daromad tushdi?', (e) => events.push(e));
    expect(msg.role).toBe('assistant');
    expect(msg.text).toContain('IELTS');
    expect(msg.actions).toHaveLength(1);
    expect(msg.actions[0]).toMatchObject({ type: 'create_task', status: 'executed', source: 'agent' });
    expect(msg.steps.map((s) => s.label)).toEqual(expect.arrayContaining(["KPI'lar (30 kun)"]));
    expect(events.some((e) => e.type === 'action')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    expect(requests[0].system).toContain("Yo'ldosh AI");
    expect(requests[0].messages[0].content[0].text).toMatch(/^\[Sana: \d{4}-\d{2}-\d{2}\]\nNega daromad tushdi\?/);

    // Ikkinchi savol: avvalgi butun tarix (thinking bloklari bilan) o'zgarishsiz qayta yuboriladi
    await chat(db, businessId, 'cnv_test', 'Rahmat, keyin-chi?');
    const replay = requests[3].messages;
    expect(replay.slice(0, 6)).toEqual(requests[2].messages.concat([{ role: 'assistant', content: [{ type: 'text', text: '**Xulosa:** daromad IELTS javob vaqti sababli tushgan. Vazifa yaratildi.' }] }]));
    expect(replay[1].content[0]).toMatchObject({ type: 'thinking', signature: 'sig1' });
  });
});
