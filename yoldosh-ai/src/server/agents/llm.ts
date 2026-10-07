import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config';
import { errorMessage } from '../lib/util';

/**
 * Claude bilan ishlash uchun agent sikli (manual agentic loop):
 * - streaming + finalMessage() (uzoq javoblarda timeout bo'lmasligi uchun)
 * - adaptive thinking, effort sozlamasi
 * - server-side refusal fallback (`fallbacks: "default"`)
 * - parallel tool chaqiruvlari bitta user xabarida qaytariladi
 * - tool kirishlari zod bilan tekshiriladi (eager input streaming yoqilgan)
 * - tarix faqat qo'shib boriladi (append-only) — prompt cache va thinking bloklari saqlanadi
 */

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentTool<I = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  run(input: I): Promise<unknown>;
  /** UI'da ko'rsatiladigan qadam nomi */
  label?(input: I): string;
}

export interface AgentEvent {
  type: 'agent_start' | 'agent_end' | 'tool' | 'text' | 'text_reset' | 'error';
  agent: string;
  label?: string;
  text?: string;
}

export interface AgentRunResult {
  /** Bu ishga tushirishda qo'shilgan xabarlar (assistant + tool_result) */
  newMessages: MessageParam[];
  text: string;
  stopReason: string | null;
  usage: { input: number; output: number; cacheRead: number };
}

let client: Anthropic | null = null;
let clientOverride: Anthropic | null = null;

export function getClient(): Anthropic {
  if (clientOverride) return clientOverride;
  if (!client) client = new Anthropic({ maxRetries: 3 });
  return client;
}

/** Testlar uchun soxta klient. */
export function setClient(c: Anthropic | null) {
  clientOverride = c;
}

export function aiEnabled(): boolean {
  return config.aiEnabled || clientOverride !== null;
}

export function toolSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Beta.BetaTool.InputSchema;
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function stringifyResult(out: unknown): string {
  if (typeof out === 'string') return out;
  return JSON.stringify(out, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v));
}

export async function runAgent(opts: {
  agent: string;
  system: string;
  tools: AgentTool[];
  messages: MessageParam[];
  effort?: Effort;
  maxIterations?: number;
  streamText?: boolean;
  onEvent?: (e: AgentEvent) => void;
}): Promise<AgentRunResult> {
  const anthropic = getClient();
  const emit = opts.onEvent ?? (() => {});
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  const tools: Anthropic.Beta.BetaTool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toolSchema(t.inputSchema),
    eager_input_streaming: true,
  }));
  const history: MessageParam[] = [...opts.messages];
  const newMessages: MessageParam[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let finalText = '';
  let stopReason: string | null = null;
  let jsonRetries = 0;

  emit({ type: 'agent_start', agent: opts.agent });
  for (let i = 0; i < (opts.maxIterations ?? 12); i++) {
    const stream = anthropic.beta.messages.stream({
      model: config.model,
      max_tokens: 64000,
      system: opts.system,
      tools,
      messages: history,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort ?? 'medium' },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (opts.streamText) stream.on('text', (delta) => emit({ type: 'text', agent: opts.agent, text: delta }));

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Faqat tool kirishi JSON sifatida o'qilmagan holatda qayta urinamiz; API xatolari yuqoriga
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      continue;
    }
    usage.input += message.usage.input_tokens ?? 0;
    usage.output += message.usage.output_tokens ?? 0;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    stopReason = message.stop_reason;

    if (message.stop_reason === 'refusal') {
      finalText = "Kechirasiz, bu so'rovni bajara olmayman (xavfsizlik siyosati). Savolni boshqacha ifodalab ko'ring.";
      break;
    }
    const assistant: MessageParam = { role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] };
    if (message.stop_reason === 'pause_turn') {
      history.push(assistant);
      newMessages.push(assistant);
      continue;
    }
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    history.push(assistant);
    newMessages.push(assistant);
    if (toolUses.length === 0) {
      finalText = textOf(message.content);
      break;
    }
    if (message.stop_reason === 'max_tokens') throw new Error('Javob max_tokens chegarasida kesildi');
    // Tool chaqiruvidan oldingi oraliq matn yakuniy javob emas — UI uni tozalaydi
    if (opts.streamText) emit({ type: 'text_reset', agent: opts.agent });

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const tool = toolMap.get(tu.name);
        if (!tool) return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Noma'lum tool: ${tu.name}` };
        const parsed = tool.inputSchema.safeParse(tu.input);
        if (!parsed.success) {
          return {
            type: 'tool_result',
            tool_use_id: tu.id,
            is_error: true,
            content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) }),
          };
        }
        emit({ type: 'tool', agent: opts.agent, label: tool.label?.(parsed.data) ?? tool.name });
        try {
          return { type: 'tool_result', tool_use_id: tu.id, content: stringifyResult(await tool.run(parsed.data)) };
        } catch (err) {
          return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: errorMessage(err) };
        }
      }),
    );
    const toolTurn: MessageParam = { role: 'user', content: results };
    history.push(toolTurn);
    newMessages.push(toolTurn);
  }
  emit({ type: 'agent_end', agent: opts.agent });
  return { newMessages, text: finalText, stopReason, usage };
}

/** Bitta so'rov (toolsiz) — masalan diagnostika matnini yozish uchun. */
export async function complete(opts: { system: string; user: string; effort?: Effort }): Promise<string> {
  const res = await runAgent({ agent: 'writer', system: opts.system, tools: [], messages: [{ role: 'user', content: opts.user }], effort: opts.effort ?? 'low', maxIterations: 2 });
  return res.text;
}
