// src/lib/integrations/whatsappCommands.ts
// Pure parser for the inventory WhatsApp bot (#82 Phase 3). Turns a free-text
// message into a structured command — no Supabase, no network, so it's fully
// unit-testable. The webhook route runs the parsed command against the
// fulfillment board + on-hand stock (src/lib/integrations/whatsapp.ts).
//
// Command set (case-insensitive verb; documented in WHATSAPP_HELP):
//   help                                  — list commands
//   jobs | board                          — active jobs + their stage
//   move <job#> <ordered|pickup|prepared|ready>  — set a job's fulfillment stage
//   prep <job#>                           — mark prepared & DEDUCT stock (Phase 2)
//   stock <sku>                           — on-hand for a SKU
//   set <sku> <qty>                       — set a SKU's on-hand count
//   low                                   — low-stock items
//
// Anything the parser can't match returns 'unknown' — the dispatcher then hands
// the raw text to the LLM interpreter (botInterpreter.ts, read tools only).

import type { FulfillmentStage } from '@/lib/inventory/fulfillmentStage';

export type WhatsAppCommand =
  | { kind: 'help' }
  | { kind: 'jobs' }
  | { kind: 'low' }
  | { kind: 'move'; jobNumber: number; stage: FulfillmentStage }
  | { kind: 'prep'; jobNumber: number }
  | { kind: 'stock'; sku: string }
  | { kind: 'set'; sku: string; qty: number }
  | { kind: 'unknown'; raw: string };

// Fuzzy stage word → fulfillment stage (so "prepared"/"prep"/"to be prepared"
// all land on to_be_prepared, etc.). Null when nothing matches.
function toStage(words: string): FulfillmentStage | null {
  const w = words.toLowerCase();
  if (w.includes('order')) return 'to_be_ordered';
  if (w.includes('pick') || w.includes('await')) return 'awaiting_pickup';
  if (w.includes('prep')) return 'to_be_prepared';
  if (w.includes('ready') || w.includes('install')) return 'ready_for_install';
  return null;
}

const intOrNull = (s: string | undefined): number | null =>
  s && /^\d+$/.test(s) ? Number(s) : null;

export function parseWhatsAppCommand(text: string): WhatsAppCommand {
  const raw = (text ?? '').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: 'unknown', raw };
  const verb = parts[0].toLowerCase();

  if (verb === 'help' || verb === '?' || verb === 'commands') return { kind: 'help' };
  if (verb === 'jobs' || verb === 'board') return { kind: 'jobs' };
  if (verb === 'low') return { kind: 'low' };

  if (verb === 'move') {
    const jobNumber = intOrNull(parts[1]);
    const stage = parts.length > 2 ? toStage(parts.slice(2).join(' ')) : null;
    if (jobNumber !== null && stage) return { kind: 'move', jobNumber, stage };
    return { kind: 'unknown', raw };
  }
  if (verb === 'prep' || verb === 'prepare' || verb === 'prepped') {
    const jobNumber = intOrNull(parts[1]);
    if (jobNumber !== null) return { kind: 'prep', jobNumber };
    return { kind: 'unknown', raw };
  }
  if (verb === 'stock') {
    const sku = parts[1]?.trim();
    if (sku) return { kind: 'stock', sku };
    return { kind: 'unknown', raw };
  }
  if (verb === 'set') {
    const sku = parts[1]?.trim();
    const qty = intOrNull(parts[2]);
    if (sku && qty !== null) return { kind: 'set', sku, qty };
    return { kind: 'unknown', raw };
  }
  return { kind: 'unknown', raw };
}

export const WHATSAPP_HELP = [
  'YLL inventory bot — commands:',
  '• jobs — active jobs + stage',
  '• move <job#> <ordered|pickup|prepared|ready> — set a stage',
  '• prep <job#> — mark prepared & deduct stock',
  '• stock <sku> — on-hand for a SKU',
  '• set <sku> <qty> — set on-hand',
  '• low — low-stock items',
  '• id — show your Telegram id (send it to Naldo/Jason to get added)',
  'Or just ask: "status on the Alvarez quote" · "what installs are today?"',
  '',
  // The field-capture flow was invisible here: a crew member texting "help" to
  // work out how to report a finished job never learned it existed.
  'Finished an install? Say it however you like:',
  '  "job 142 done, used 2 boxes C9 and 30 clips"',
  'Send photos with it, or record a voice note instead of typing.',
  '',
  // Crew time clock. Listed HERE rather than behind its own 'help' word: the
  // crew parser used to claim 'help'/'commands'/'?' and so served this text to
  // everyone in place of the real help. It released those words; this is where
  // crew discover the commands now (S58 wrap review, technical lens).
  'Time clock (crew):',
  '  in / out — clock in and out for the day',
  '  break / back — start and end an unpaid break',
  '  arrive 1042 — arrive at job #1042',
  '  done — finished the job (marks it installed)',
  '  depart weather|access|materials|other — left without finishing',
  '  status — what am I on right now',
  'You get a summary back first — nothing is saved until you reply yes.',
].join('\n');
