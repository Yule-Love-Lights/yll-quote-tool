// src/lib/integrations/botInterpreter.ts
// LLM interpreter for the staff text-ops bot (2026-07-19 text-ops plan). Turns
// ONE free-form staff message into ONE structured tool call — {tool, args,
// confidence} — via a cheap Haiku-tier classification call. The keyword parser
// (whatsappCommands.ts) still runs FIRST in the dispatcher; this only sees text
// the parser couldn't match, so exact commands stay deterministic and cost
// nothing.
//
// SAFETY MODEL — read-only by DEFAULT. The write tools are unreachable unless
// the caller passes { allowWrites: true }, which only the Phase-2 dispatcher
// does, and only on a path that then enforces the role check AND the confirm-yes
// gate. Interpretation NEVER executes anything: a write coming out of here is a
// PROPOSAL that the dispatcher stages and the human confirms.
//
// Whatever the model replies, an out-of-enum tool name fails validation and the
// caller falls back to the help reply. Low confidence (< MIN_CONFIDENCE) also
// returns null — the bot would rather say "didn't understand" than guess. Any
// API failure returns null (fail-closed to the dumb-but-safe path); this module
// never throws into the webhook.

import { getClaudeClient } from '@/lib/claude';

export const BOT_READ_TOOLS = ['status', 'schedule', 'stock', 'low', 'jobs', 'help'] as const;
export type BotReadTool = (typeof BOT_READ_TOOLS)[number];

// Field-capture writes (Phase 2). Confirm-gated and audit-logged by the caller.
export const BOT_WRITE_TOOLS = ['completeInstall'] as const;
export type BotWriteTool = (typeof BOT_WRITE_TOOLS)[number];

export type BotTool = BotReadTool | BotWriteTool;

// What the crew SAID, not a SKU. The catalog has ~877 rows, far too many to
// hand a cheap classifier, and a wrong-but-real SKU silently corrupts stock
// with nothing to catch it. So the model only captures the phrase and the
// count; resolveMaterialLines turns that into a real SKU deterministically,
// searching the job's own bill of materials first and refusing when unsure.
export type BotMaterialLine = { item: string; qty: number };

export type BotInterpretation = {
  tool: BotTool;
  args: {
    query?: string;
    when?: 'today' | 'tomorrow' | 'week';
    sku?: string;
    jobNumber?: number;
    materials?: BotMaterialLine[];
    note?: string;
  };
  confidence: number;
};

export function isWriteTool(tool: string): tool is BotWriteTool {
  return (BOT_WRITE_TOOLS as readonly string[]).includes(tool);
}

// Below this the interpretation is discarded — a clarifying "didn't understand"
// beats acting on a guess, even for reads. For writes the confirm-yes gate is
// the real safety net; this is the first line.
const MIN_CONFIDENCE = 0.6;

// Intent-parsing is classification, not reasoning — the plan pins it to the
// cheap fast tier so per-message cost stays near zero (locked decision, S46).
const INTERPRETER_MODEL = 'claude-haiku-4-5-20251001';

// A crew member listing what they used should never produce a hundred lines;
// anything past this is a malformed reply, not a real install.
const MAX_MATERIAL_LINES = 20;

function systemPrompt(allowWrites: boolean): string {
  const lines = [
    'You route one staff text message for a residential holiday-lighting company',
    '(Yule Love Lights) to ONE ops tool. Staff ask about quotes, jobs, installs,',
    'and inventory. Tools:',
    '- status: look up a quote or job — put the customer name or quote/job number in query',
    '- schedule: upcoming installs — set when to today, tomorrow, or week (default today)',
    '- stock: on-hand count for one SKU — put the SKU in sku',
    '- low: list low-stock items',
    '- jobs: the active job board',
    '- help: anything else',
  ];

  if (allowWrites) {
    lines.push(
      '- completeInstall: a crew member reporting an install is FINISHED and what',
      '  material it took. Put the job number in jobNumber and each material line in',
      '  materials as {item, qty}, where item is the product AS THEY DESCRIBED IT,',
      '  copied plainly, and qty is how many. Do NOT invent product codes and do not',
      '  convert units: "2 boxes of C9 warm white" is {item: "C9 warm white", qty: 2}.',
      '  Anything else they said goes in note.',
      '  Example: "job 142 done, used 2 boxes of C9 and 30 clips" → completeInstall,',
      '  jobNumber 142, materials [{item: "C9", qty: 2}, {item: "clips", qty: 30}].',
      'For any OTHER change (moving a job stage, setting stock, editing or sending a',
      'quote, prices, contacts) answer help with confidence 0 — those are not',
      'available here.',
    );
  } else {
    lines.push(
      'If the message asks to CHANGE anything (move a job, set stock, edit or send a',
      'quote, prices, contacts) answer help with confidence 0 — writes are not',
      'available here.',
    );
  }

  lines.push('confidence is 0..1: how sure you are this routing is what the sender wants.');
  return lines.join('\n');
}

function routeTool(allowWrites: boolean) {
  const properties: Record<string, unknown> = {
    tool: {
      type: 'string',
      enum: allowWrites ? [...BOT_READ_TOOLS, ...BOT_WRITE_TOOLS] : [...BOT_READ_TOOLS],
    },
    query: { type: 'string', description: 'customer name or quote/job number (status only)' },
    when: { type: 'string', enum: ['today', 'tomorrow', 'week'] },
    sku: { type: 'string', description: 'SKU (stock only)' },
    confidence: { type: 'number' },
  };

  if (allowWrites) {
    properties.jobNumber = { type: 'integer', description: 'job number (completeInstall)' };
    properties.materials = {
      type: 'array',
      description: 'material actually used (completeInstall)',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'the product as the sender described it' },
          qty: { type: 'number' },
        },
        required: ['item', 'qty'],
      },
    };
    properties.note = { type: 'string', description: 'anything else the sender said' };
  }

  return {
    name: 'route',
    description: 'Route the staff message to one ops tool.',
    input_schema: { type: 'object' as const, properties, required: ['tool', 'confidence'] },
  };
}

/** Keep only well-formed {item, qty} pairs; a malformed line is dropped, not guessed. */
function parseMaterials(raw: unknown): BotMaterialLine[] {
  if (!Array.isArray(raw)) return [];
  const out: BotMaterialLine[] = [];
  for (const entry of raw.slice(0, MAX_MATERIAL_LINES)) {
    if (!entry || typeof entry !== 'object') continue;
    const { item, qty } = entry as { item?: unknown; qty?: unknown };
    if (typeof item !== 'string' || !item.trim()) continue;
    const n = typeof qty === 'number' ? qty : Number(qty);
    if (!Number.isFinite(n) || n < 0) continue;
    out.push({ item: item.trim(), qty: Math.floor(n) });
  }
  return out;
}

/**
 * Interpret a staff message into a tool call, or null when the bot should fall
 * back to the "didn't understand" reply: no API key configured, API failure,
 * malformed/out-of-enum response, or confidence below the bar.
 *
 * `allowWrites` must only be set by a caller that enforces role + confirmation
 * on the result. `skuHints` gives the model the real catalog codes so a crew
 * member's "2 boxes of C9" maps to an actual SKU instead of an invented one.
 */
export async function interpretBotText(
  text: string,
  opts: { allowWrites?: boolean; skuHints?: string[] } = {},
): Promise<BotInterpretation | null> {
  const allowWrites = opts.allowWrites === true;
  const allowed: readonly string[] = allowWrites
    ? [...BOT_READ_TOOLS, ...BOT_WRITE_TOOLS]
    : BOT_READ_TOOLS;

  const client = getClaudeClient();
  if (!client) return null;
  try {
    const res = await client.messages.create({
      model: INTERPRETER_MODEL,
      max_tokens: 500,
      system: systemPrompt(allowWrites, opts.skuHints ?? []),
      messages: [{ role: 'user', content: text.slice(0, 1000) }],
      tools: [routeTool(allowWrites)],
      tool_choice: { type: 'tool', name: 'route' },
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return null;
    const input = (block.input ?? {}) as Record<string, unknown>;

    const tool = input.tool;
    if (typeof tool !== 'string' || !allowed.includes(tool)) return null;

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

    if (allowWrites) {
      const jobNumber = typeof input.jobNumber === 'number' ? input.jobNumber : Number(input.jobNumber);
      if (Number.isInteger(jobNumber) && jobNumber > 0) args.jobNumber = jobNumber;
      const materials = parseMaterials(input.materials);
      if (materials.length) args.materials = materials;
      if (typeof input.note === 'string' && input.note.trim()) args.note = input.note.trim();
    }

    return { tool: tool as BotTool, args, confidence };
  } catch (err) {
    console.warn('[botInterpreter] interpret failed (falling back to help reply):', err);
    return null;
  }
}
