// src/lib/integrations/botDispatch.ts
// The Phase-2 message handler for the staff text-ops bot (2026-07-19 plan).
// Every gate lives here, in one place, so no tool can ship ungated:
//
//   addressed?  → in a group the bot answers ONLY when spoken to (botGroupGate)
//   role?       → the SENDER's tier, not the room's (botRoles)
//   confirmed?  → sensitive writes stage a summary and wait for "yes" (botConfirm)
//   audited     → every write attempt, including refusals (botAudit)
//
// The Phase-1 entry point (handleWhatsAppText in whatsapp.ts) is untouched and
// still serves the WhatsApp route as a read-only dispatcher; this is the richer
// Telegram path that knows who is speaking and can carry voice and photos.

import { parseWhatsAppCommand, type WhatsAppCommand } from './whatsappCommands';
import { runWhatsAppCommand } from './whatsapp';
import { cleanTelegramCommand } from './telegram';
import { interpretBotText, isWriteTool } from './botInterpreter';
import { runStatusTool, runScheduleTool } from './botTools';
import { isAddressedToBot } from './botGroupGate';
import { roleForSenderInAllowedChat, mayRunTool, type BotRole } from './botRoles';
import {
  stagePendingAction,
  consumePendingAction,
  supersedeOpenActions,
  isAffirmative,
  isNegative,
} from './botConfirm';
import { logBotAction } from './botAudit';
import {
  runCompleteInstall,
  summarizeCompleteInstall,
  type CompleteInstallArgs,
} from './botWriteTools';
import { listCatalog } from '@/lib/inventory/catalog';
import { listFulfillmentCards } from '@/lib/inventory/jobs';
import { downloadTelegramFile } from './telegramMedia';
import { transcribeAudio, isTranscriptionConfigured } from './transcribe';

export type BotIncomingMessage = {
  chatId: string;
  userId: string;
  /** Telegram chat.type — 'private' | 'group' | 'supergroup'. */
  chatType?: string | null;
  /** RAW text or photo caption: the group gate needs the @mention intact. */
  text: string;
  isReplyToBot?: boolean;
  photoFileIds?: string[];
  voiceFileId?: string | null;
};

const NOT_UNDERSTOOD = 'Didn\'t understand that. Text "help" for commands.';
const NOTHING_PENDING = 'Nothing is waiting for a yes.';

// Keyword writes that move real stock. The plan's rule is that every sensitive
// write confirms first, regardless of role — a misread text stays harmless
// until "yes".
const CONFIRM_REQUIRED_KEYWORDS = new Set(['prep', 'set']);

// Sending the model the real catalog codes is what turns "2 boxes of C9" into a
// SKU that exists. Capped so a large catalog can't blow up the prompt.
const MAX_SKU_HINTS = 120;

/**
 * Handle one inbound message. Returns the reply text, or null when the bot
 * should stay silent (a group message that wasn't addressed to it).
 */
export async function handleBotMessage(msg: BotIncomingMessage): Promise<string | null> {
  if (
    !isAddressedToBot({
      chatType: msg.chatType,
      text: msg.text,
      isReplyToBot: msg.isReplyToBot,
    })
  ) {
    return null;
  }

  const role = roleForSenderInAllowedChat(msg.userId);
  let text = cleanTelegramCommand(msg.text);

  // A voice note carries the instruction when there's no caption to read.
  if (!text && msg.voiceFileId) {
    const spoken = await transcribeVoice(msg.voiceFileId);
    if (!spoken) {
      return isTranscriptionConfigured()
        ? "Couldn't make out that voice note — try typing it."
        : 'Voice notes are not set up yet — type it instead.';
    }
    text = spoken;
  }

  // ── the confirm-yes gate ──────────────────────────────────────────────────
  if (isNegative(text)) {
    await supersedeOpenActions(msg.chatId, msg.userId);
    await logBotAction({ chatId: msg.chatId, userId: msg.userId, role, tool: 'confirm', outcome: 'cancelled' });
    return 'Cancelled — nothing was changed.';
  }

  if (isAffirmative(text)) {
    const pending = await consumePendingAction(msg.chatId, msg.userId);
    if (!pending) return NOTHING_PENDING;
    return executeConfirmed(pending.tool, pending.args, role, msg);
  }

  if (!text) {
    return msg.photoFileIds?.length
      ? 'Got the photo. Send it with the job, like "job 142 done, 2 boxes C9".'
      : NOT_UNDERSTOOD;
  }

  // ── keyword commands: deterministic, never touch the LLM ───────────────────
  const cmd = parseWhatsAppCommand(text);
  if (cmd.kind !== 'unknown') {
    if (!mayRunTool(role, cmd.kind)) return denied(msg, role, cmd.kind);

    if (CONFIRM_REQUIRED_KEYWORDS.has(cmd.kind)) {
      const summary =
        cmd.kind === 'prep'
          ? `Prep job #${(cmd as { jobNumber: number }).jobNumber} and deduct its materials from stock — reply yes to confirm.`
          : `Set ${(cmd as { sku: string }).sku} on-hand to ${(cmd as { qty: number }).qty} — reply yes to confirm.`;
      return stage(msg, role, cmd.kind, cmd as unknown as Record<string, unknown>, summary);
    }
    return runWhatsAppCommand(cmd);
  }

  // ── LLM interpretation (writes allowed, but only as a PROPOSAL) ────────────
  const interp = await interpretBotText(text, {
    allowWrites: true,
    skuHints: await skuHints(),
  });
  if (!interp) return NOT_UNDERSTOOD;

  if (!mayRunTool(role, interp.tool)) return denied(msg, role, interp.tool);

  if (isWriteTool(interp.tool)) {
    if (interp.tool === 'completeInstall') {
      const jobNumber = interp.args.jobNumber;
      if (!jobNumber) return 'Which job number? Try "job 142 done, 2 boxes C9".';

      const args: CompleteInstallArgs = {
        jobNumber,
        materials: interp.args.materials ?? [],
        note: interp.args.note ?? null,
        photoFileIds: msg.photoFileIds ?? [],
      };
      const card = (await listFulfillmentCards()).find((c) => c.jobNumber === jobNumber);
      if (!card) return `No active job #${jobNumber}.`;

      return stage(
        msg,
        role,
        interp.tool,
        args as unknown as Record<string, unknown>,
        summarizeCompleteInstall(args, card.customerName),
      );
    }
    return NOT_UNDERSTOOD;
  }

  switch (interp.tool) {
    case 'status':
      return runStatusTool(interp.args.query ?? text);
    case 'schedule':
      return runScheduleTool(interp.args.when ?? 'today');
    case 'stock':
      return interp.args.sku
        ? runWhatsAppCommand({ kind: 'stock', sku: interp.args.sku })
        : NOT_UNDERSTOOD;
    case 'low':
      return runWhatsAppCommand({ kind: 'low' });
    case 'jobs':
      return runWhatsAppCommand({ kind: 'jobs' });
    default:
      return runWhatsAppCommand({ kind: 'help' });
  }
}

/** Run a previously staged action. Role is re-checked at execution time. */
async function executeConfirmed(
  tool: string,
  args: Record<string, unknown>,
  role: BotRole,
  msg: BotIncomingMessage,
): Promise<string> {
  // Re-check rather than trusting the check made when it was staged: the
  // sender's tier may have been lowered in between, and the cost is one
  // in-memory comparison.
  if (!mayRunTool(role, tool)) return denied(msg, role, tool);

  try {
    let reply: string;
    if (tool === 'completeInstall') {
      reply = await runCompleteInstall(args as unknown as CompleteInstallArgs, msg.userId);
    } else if (tool === 'prep' || tool === 'set') {
      // Round-trips through jsonb as the same parsed shape it was staged from.
      reply = await runWhatsAppCommand(args as unknown as WhatsAppCommand);
    } else {
      return NOTHING_PENDING;
    }
    await logBotAction({ chatId: msg.chatId, userId: msg.userId, role, tool, args, outcome: 'ran', detail: reply });
    return reply;
  } catch (err) {
    console.error('[botDispatch] confirmed action failed:', err);
    await logBotAction({
      chatId: msg.chatId,
      userId: msg.userId,
      role,
      tool,
      args,
      outcome: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    return 'That didn\'t go through. Nothing was changed — try again.';
  }
}

async function stage(
  msg: BotIncomingMessage,
  role: BotRole,
  tool: string,
  args: Record<string, unknown>,
  summary: string,
): Promise<string> {
  const id = await stagePendingAction({
    chatId: msg.chatId,
    userId: msg.userId,
    tool,
    args,
    summary,
  });
  // Never claim something is pending when it wasn't stored — a "yes" would then
  // find nothing and the crew would think the work was recorded.
  if (!id) return 'Couldn\'t set that up right now — try again in a minute.';
  await logBotAction({ chatId: msg.chatId, userId: msg.userId, role, tool, args, outcome: 'staged', detail: summary });
  return summary;
}

async function denied(msg: BotIncomingMessage, role: BotRole, tool: string): Promise<string> {
  await logBotAction({ chatId: msg.chatId, userId: msg.userId, role, tool, outcome: 'denied' });
  return "You don't have access to that one. Ask Naldo or Jason.";
}

async function transcribeVoice(fileId: string): Promise<string | null> {
  if (!isTranscriptionConfigured()) return null;
  const file = await downloadTelegramFile(fileId);
  if (!file) return null;
  // Telegram voice notes are OGG/Opus; Whisper picks the decoder off the name.
  return transcribeAudio(file.buffer, 'voice.ogg');
}

async function skuHints(): Promise<string[]> {
  try {
    return (await listCatalog()).slice(0, MAX_SKU_HINTS).map((c) => c.sku);
  } catch {
    return [];
  }
}
