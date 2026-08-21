// src/app/api/integrations/telegram/webhook/route.ts
// Telegram Bot API webhook for the staff ops bot (#82 Phase 3 → text-ops plan).
//   POST — inbound message update from Telegram. Verifies the
//   X-Telegram-Bot-Api-Secret-Token header → checks the chat-id allowlist →
//   hands the message to the dispatcher, which owns the address/role/confirm
//   gates. Reply sent via sendMessage.
//
// TWO DIFFERENT IDS, on purpose: the allowlist gates the CHAT (which rooms the
// bot serves) while permissions key off the SENDER (message.from.id), so a
// staff group chat doesn't hand every member the highest role in the room.
//
// Always 200s except on a bad secret (401), so Telegram doesn't retry endlessly.
// DORMANT until TELEGRAM_BOT_ENABLED='true' AND TELEGRAM_BOT_TOKEN is set.
// Public path (Telegram calls it, no operator auth) — see operatorGate.ts.

import { NextRequest, NextResponse } from 'next/server';
import {
  isTelegramBotEnabled,
  isTelegramConfigured,
  verifyTelegramSecret,
  isAllowedChat,
  sendTelegramMessage,
} from '@/lib/integrations/telegram';
import { handleBotMessage } from '@/lib/integrations/botDispatch';

export const runtime = 'nodejs';

const ok = () => NextResponse.json({ ok: true });

type TelegramPhotoSize = { file_id?: string };
type TelegramMessage = {
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; first_name?: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: { file_id?: string };
  audio?: { file_id?: string };
  reply_to_message?: { from?: { is_bot?: boolean } };
};

/** "First Last @handle" for the sender log, or "(no name)". Never message text. */
function senderLabel(from: TelegramMessage['from']): string {
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
  const handle = from?.username ? `@${from.username}` : '';
  return [name, handle].filter(Boolean).join(' ') || '(no name)';
}

export async function GET() {
  // For ops checks — Telegram itself doesn't GET; just return 200.
  return new NextResponse('OK', { status: 200 });
}

export async function POST(req: NextRequest) {
  if (!isTelegramBotEnabled() || !isTelegramConfigured()) return ok();

  if (
    !verifyTelegramSecret(
      req.headers.get('x-telegram-bot-api-secret-token'),
      process.env.TELEGRAM_WEBHOOK_SECRET,
    )
  ) {
    return new NextResponse('Bad secret', { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return ok();
  }

  // Status updates (edited_message, callback_query, channel_post, etc.) are ignored.
  const msg = (body as { message?: TelegramMessage } | null)?.message;
  const chatId = msg?.chat?.id;
  if (!msg || chatId === undefined) return ok();

  if (!isAllowedChat(chatId)) {
    console.warn('[telegram] ignored command from non-allowlisted chat:', chatId);
    return ok();
  }

  const userId = msg.from?.id;
  if (userId === undefined) return ok();

  // WHY THIS LOG EXISTS: a Telegram user id is knowable ONLY from a message
  // that person actually sent. Telegram gives a bot no way to enumerate who
  // has talked to it — getUpdates is disabled while a webhook is set, and
  // there is no member-list API for groups. But linking a crew member
  // (crew_members.telegram_user_id, row 318) needs exactly that number, so
  // without this the only route is asking each person to fetch it themselves
  // from @userinfobot. One line per inbound message turns a round of hellos in
  // the crew group into a copyable list in the Vercel logs.
  // WHICH messages reach here is Telegram's call, not ours: with the bot's
  // group privacy mode ON it only receives /commands, @mentions and replies to
  // itself, and with it OFF it receives everything in the room. That setting
  // lives in BotFather, not in this repo, so tell crew to @mention the bot —
  // that arrives under BOTH settings.
  // Ids and display names ONLY — never message text, which can carry customer
  // details. A 1:1 DM from an unlinked person is already covered by the
  // non-allowlisted warn above, since a private chat's chat.id IS their from.id.
  console.info(
    `[telegram] sender id=${userId} name=${senderLabel(msg.from)} chat=${chatId} type=${msg.chat?.type ?? 'private'}`,
  );

  // Telegram sends a photo as an array of sizes, smallest first — the last one
  // is the highest resolution available.
  const photoFileIds: string[] = [];
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1]?.file_id;
    if (largest) photoFileIds.push(largest);
  }

  try {
    const reply = await handleBotMessage({
      chatId: String(chatId),
      userId: String(userId),
      chatType: msg.chat?.type ?? 'private',
      // RAW text (or the photo's caption) — the group gate needs the @mention
      // intact, so cleaning happens inside the dispatcher.
      text: msg.text ?? msg.caption ?? '',
      isReplyToBot: msg.reply_to_message?.from?.is_bot === true,
      photoFileIds,
      voiceFileId: msg.voice?.file_id ?? msg.audio?.file_id ?? null,
    });
    // null = a group message that wasn't addressed to the bot: stay silent.
    if (reply) await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('[telegram] command handling failed:', err);
    try {
      await sendTelegramMessage(chatId, 'Something went wrong handling that.');
    } catch {
      /* best-effort */
    }
  }
  return ok();
}
