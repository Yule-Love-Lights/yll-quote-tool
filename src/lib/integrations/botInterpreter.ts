// src/lib/integrations/botInterpreter.ts
// LLM interpreter for the staff text-ops bot (Phase 1 of the 2026-07-19
// text-ops plan). Turns ONE free-form staff message into ONE structured
// READ-ONLY tool call — {tool, args, confidence} — via a cheap Haiku-tier
// classification call. The keyword parser (whatsappCommands.ts) still runs
// FIRST in the dispatcher; this only sees text the parser couldn't match, so
// exact commands stay deterministic and cost nothing.
//
// SAFETY MODEL: the tool enum below contains ONLY read tools. A write (move /
// prep / set — or any future money tool) can never come out of this module,
// whatever the model replies: an out-of-enum tool name fails validation and
// the caller falls back to the help reply. Low confidence (< MIN_CONFIDENCE)
// also returns null — the bot would rather say "didn't understand" than guess.
// Any API failure returns null (fail-closed to the dumb-but-safe path); this
// module never throws into the webhook.

import { getClaudeClient } from '@/lib/claude';

export const BOT_READ_TOOLS = ['status', 'schedule', 'stock', 'low', 'jobs', 'help'] as const;
export type BotReadTool = (typeof BOT_READ_TOOLS)[number];

export type BotInterpretation = {
  tool: BotReadTool;
  args: { query?: string; when?: 'today' | 'tomorrow' | 'week'; sku?: string };
  confidence: number;
};

// Below this the interpretation is discarded — a clarifying "didn't understand"
// beats acting on a guess, even for reads (the plan's first-line guard; the
// confirm-yes gate for writes lands in Phase 2).
const MIN_CONFIDENCE = 0.6;

// Intent-parsing is classification, not reasoning — the plan pins it to the
// cheap fast tier so per-message cost stays near zero (locked decision, S46).
const INTERPRETER_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = [
  'You route one staff text message for a residential holiday-lighting company',
  "(Yule Love Lights) to ONE read-only ops tool. Staff ask about quotes, jobs,",
  'installs, and inventory. Tools:',
  '- status: look up a quote or job — put the customer name or quote/job number in query',
  '- schedule: upcoming installs — set when to today, tomorrow, or week (default today)',
  '- stock: on-hand count for one SKU — put the SKU in sku',
  '- low: list low-stock items',
  '- jobs: the active job board',
  '- help: anything else',
  'If the message asks to CHANGE anything (move a job, set stock, edit or send a',
  'quote, prices, contacts) answer help with confidence 0 — writes are not',
  'available here. confidence is 0..1: how sure you are this routing is what the',
  'sender wants.',
].join('\n');

const ROUTE_TOOL = {
  name: 'route',
  description: 'Route the staff message to one read-only ops tool.',
  input_schema: {
    type: 'object' as const,
    properties: {
      tool: { type: 'string', enum: [...BOT_READ_TOOLS] },
      query: { type: 'string', description: 'customer name or quote/job number (status only)' },
      when: { type: 'string', enum: ['today', 'tomorrow', 'week'] },
      sku: { type: 'string', description: 'SKU (stock only)' },
      confidence: { type: 'number' },
    },
    required: ['tool', 'confidence'],
  },
};

/**
 * Interpret a staff message into a read-only tool call, or null when the bot
 * should fall back to the "didn't understand" reply: no API key configured,
 * API failure, malformed/out-of-enum response, or confidence below the bar.
 */
export async function interpretBotText(text: string): Promise<BotInterpretation | null> {
  const client = getClaudeClient();
  if (!client) return null;
  try {
    const res = await client.messages.create({
      model: INTERPRETER_MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: 'user', content: text.slice(0, 1000) }],
      tools: [ROUTE_TOOL],
      tool_choice: { type: 'tool', name: 'route' },
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return null;
    const input = (block.input ?? {}) as Record<string, unknown>;

    const tool = input.tool;
    if (typeof tool !== 'string' || !(BOT_READ_TOOLS as readonly string[]).includes(tool)) {
      return null;
    }
    const confidence = input.confidence;
    if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < MIN_CONFIDENCE) {
      return null;
    }

    const args: BotInterpretation['args'] = {};
    if (typeof input.query === 'string' && input.query.trim()) args.query = input.query.trim();
    if (input.when === 'today' || input.when === 'tomorrow' || input.when === 'week') {
      args.when = input.when;
    }
    if (typeof input.sku === 'string' && input.sku.trim()) args.sku = input.sku.trim();

    return { tool: tool as BotReadTool, args, confidence };
  } catch (err) {
    console.warn('[botInterpreter] interpret failed (falling back to help reply):', err);
    return null;
  }
}
