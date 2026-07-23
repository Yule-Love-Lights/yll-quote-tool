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
import { interpretBotText, isWriteTool, isInterpreterConfigured } from './botInterpreter';
import { runStatusTool, runScheduleTool } from './botTools';
import { isAddressedToBot } from './botGroupGate';
import { roleForSenderInAllowedChat, mayRunTool, type BotRole } from './botRoles';
import {
  stagePendingAction,
  consumePendingAction,
  supersedeOpenActions,
  peekPendingAction,
  appendPhotosToPendingAction,
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
import { listFulfillmentCards, getJobWorkOrder } from '@/lib/inventory/jobs';
import { resolveMaterialLines } from '@/lib/inventory/materialResolve';
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


/**
 * Handle one inbound message. Returns the reply text, or null when the bot
 * should stay silent (a group message that wasn't addressed to it).
 */
export async function handleBotMessage(msg: BotIncomingMessage): Promise<string | null> {
  const addressed = isAddressedToBot({
    chatType: msg.chatType,
    text: msg.text,
    isReplyToBot: msg.isReplyToBot,
  });

  const role = roleForSenderInAllowedChat(msg.userId);
  let text = cleanTelegramCommand(msg.text);

  if (!addressed) {
    // One exception to the group gate, and it is the important one: a bare
    // "yes" typed into a group is the natural way to confirm, but it is not a
    // reply-to-bot or a mention, so the gate would silently drop it and the
    // crew would think their report went through. A plain yes/no from someone
    // who has an action pending is unambiguous — nobody else's stray "yes"
    // resolves to anything, because they have nothing staged. Photos get the
    // same treatment so an album's untitled follow-ups still land.
    const bare = isAffirmative(text) || isNegative(text);
    const hasPhotos = !!msg.photoFileIds?.length;
    // A voice note carries no text, so a hands-free "yes" voiced into a group
    // must get the same pending-action bypass photos and typed yeses get, or it
    // is silently dropped (it's transcribed further down once addressed).
    const hasVoice = !!msg.voiceFileId;
    if (!bare && !hasPhotos && !hasVoice) return null;
    if (!(await peekPendingAction(msg.chatId, msg.userId))) return null;
  }

  // A voice note carries the instruction when there's no caption to read.
  let heard: string | null = null;
  if (!text && msg.voiceFileId) {
    const spoken = await transcribeVoice(msg.voiceFileId);
    if (!spoken) {
      return isTranscriptionConfigured()
        ? "Couldn't make out that voice note — try typing it."
        : 'Voice notes are not set up yet — type it instead.';
    }
    // Echoed back with the reply: wind, gloves and a ladder make mishearing "two
    // boxes" as "ten boxes" entirely possible, and a summary of codes and counts
    // gives the crew no way to catch it. Showing the words does.
    heard = spoken;
    text = spoken;
  }
  const withHeard = (reply: string) => (heard ? `Heard: "${heard}"\n${reply}` : reply);

  // ── the confirm-yes gate ──────────────────────────────────────────────────
  if (isNegative(text)) {
    await supersedeOpenActions(msg.chatId, msg.userId);
    await logBotAction({ chatId: msg.chatId, userId: msg.userId, role, tool: 'confirm', outcome: 'cancelled' });
    return 'Cancelled — nothing was changed.';
  }

  if (isAffirmative(text)) {
    // A photo sent WITH the "yes" (as its caption) would otherwise be discarded:
    // control reaches here before the captionless-photo branch below. Fold it
    // into the pending action first so the confirmed run saves it too.
    if (msg.photoFileIds?.length) {
      await appendPhotosToPendingAction(msg.chatId, msg.userId, msg.photoFileIds);
    }
    const pending = await consumePendingAction(msg.chatId, msg.userId);
    if (!pending) return NOTHING_PENDING;
    return executeConfirmed(pending.tool, pending.args, role, msg);
  }

  if (!text) {
    if (!msg.photoFileIds?.length) return NOT_UNDERSTOOD;
    // Telegram splits an album into separate updates and puts the caption on
    // only one, so these arrive captionless. Attaching them to the pending
    // action stops the rest of the album from vanishing while the final reply
    // still cheerfully reports "Saved 1 photo".
    const attached = await appendPhotosToPendingAction(
      msg.chatId,
      msg.userId,
      msg.photoFileIds,
    );
    if (attached) {
      const count = Array.isArray(attached.args.photoFileIds)
        ? (attached.args.photoFileIds as string[]).length
        : 1;
      return `Got it — ${count} photo${count === 1 ? '' : 's'} ready for that job. Reply yes to confirm, or send more.`;
    }
    return 'Got the photo. Send it with the job, like "job 142 done, 2 boxes C9".';
  }

  // A reply that is neither a clear yes nor a clear no ("yes but 3 boxes") must
  // not silently strand the pending action: say it is still waiting, and what
  // it says, rather than dropping through to a bare "didn't understand".
  const stillPending = await peekPendingAction(msg.chatId, msg.userId);

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
  if (!isInterpreterConfigured()) {
    // Distinct from "didn't understand": completeInstall has no keyword form, so
    // a missing API key silently kills the whole point of field capture. Saying
    // which one it is turns an invisible config gap into a diagnosable one.
    return withHeard(
      pendingNote(stillPending) ??
        "I can only handle the exact commands right now (text \"help\"). Plain-English requests are off — tell the office.",
    );
  }

  const interp = await interpretBotText(text, { allowWrites: true });
  if (!interp) return withHeard(pendingNote(stillPending) ?? NOT_UNDERSTOOD);

  if (!mayRunTool(role, interp.tool)) return denied(msg, role, interp.tool);

  if (isWriteTool(interp.tool)) {
    if (interp.tool === 'completeInstall') {
      const jobNumber = interp.args.jobNumber;
      if (!jobNumber) return withHeard('Which job number? Try "job 142 done, 2 boxes C9".');

      const card = (await listFulfillmentCards()).find((c) => c.jobNumber === jobNumber);
      if (!card) {
        // Don't just refuse: the crew already typed everything, and retyping it
        // on the same phone that produced the typo is the worst possible ask.
        return withHeard(
          `No active job #${jobNumber} — check the number, or try "status <customer name>" to look it up. Resend once you have it.`,
        );
      }

      // The crew's words become real SKUs HERE, deterministically, searching
      // this job's own bill of materials before the 877-row catalog. A phrase
      // that matches nothing (or several things) is reported, never guessed:
      // a wrong-but-real SKU would move two stock numbers with nothing to catch it.
      const wo = await getJobWorkOrder(card.id);
      const jobMaterials = (wo?.materials.materials ?? []).map((m) => ({
        sku: m.sku,
        name: m.name,
      }));
      const resolution = resolveMaterialLines(
        interp.args.materials ?? [],
        jobMaterials,
        await catalogEntries(),
      );

      const args: CompleteInstallArgs = {
        jobNumber,
        materials: resolution.resolved.map((r) => ({ sku: r.sku, name: r.name, qty: r.qty })),
        note: interp.args.note ?? null,
        photoFileIds: msg.photoFileIds ?? [],
      };

      const summary = summarizeCompleteInstall(args, card.customerName);
      const staged = await stage(
        msg,
        role,
        interp.tool,
        args as unknown as Record<string, unknown>,
        summary,
      );

      if (!resolution.unresolved.length) return withHeard(staged);
      // Surfaced alongside the confirm rather than silently dropped, so the crew
      // can add the missing line before or after confirming.
      const missing = resolution.unresolved
        .map((u) => `${u.qty}× "${u.item}"${u.reason === 'ambiguous' ? ' (matches several)' : ''}`)
        .join(', ');
      return withHeard(`${staged}\nI couldn't match: ${missing}. Reply with the exact product name for those.`);
    }
    return withHeard(NOT_UNDERSTOOD);
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
  const staged = await stagePendingAction({
    chatId: msg.chatId,
    userId: msg.userId,
    tool,
    args,
    summary,
  });
  // Never claim something is pending when it wasn't stored — a "yes" would then
  // find nothing and the crew would think the work was recorded.
  if (!staged) return 'Couldn\'t set that up right now — try again in a minute.';
  await logBotAction({ chatId: msg.chatId, userId: msg.userId, role, tool, args, outcome: 'staged', detail: summary });

  // Only one action can be pending per sender, so a crew member reporting two
  // finished jobs back to back loses the first unless we say so.
  if (staged.supersededSummary) {
    return `Heads up: your previous report wasn't confirmed, so it's cancelled — ${staged.supersededSummary}\n\n${summary}`;
  }
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

async function catalogEntries(): Promise<{ sku: string; name: string }[]> {
  try {
    return (await listCatalog()).map((c) => ({ sku: c.sku, name: c.name ?? '' }));
  } catch {
    return [];
  }
}

/**
 * Tells a pending sender their action is STILL waiting, instead of dropping
 * them onto a bare "didn't understand". A reply like "yes but 3 boxes" is
 * neither a yes nor a no, and silently stranding it is how a crew member walks
 * away believing they corrected something.
 */
function pendingNote(pending: { summary: string } | null): string | null {
  if (!pending) return null;
  return `I didn't read that as a plain yes. Still waiting on: ${pending.summary}\nReply "yes" to confirm, "no" to cancel, or resend the whole line with the right numbers.`;
}
