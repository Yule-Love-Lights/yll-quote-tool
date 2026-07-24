// src/lib/integrations/botGroupGate.ts
// Decides whether an incoming message is actually TALKING TO the bot.
//
// Why this exists: Telegram bots in groups run in "privacy mode" by default and
// only receive slash-commands and @mentions. To let staff ask plain-English
// questions in a group, privacy mode has to be turned OFF in @BotFather — and
// then the bot receives EVERY message in the room, including the humans talking
// to each other. Without this gate the dispatcher would send each of those to
// the LLM interpreter and answer "Didn't understand that" to ordinary
// conversation: constant spam plus a per-message model call.
//
// In a 1:1 chat every message is for the bot. In a group, only an explicit
// address counts: a slash command, an @mention, or a reply to the bot's own
// message (which is how a crew member answers a confirm prompt).

export type AddressCheck = {
  /** Telegram chat.type — 'private' | 'group' | 'supergroup' | 'channel'. */
  chatType: string | null | undefined;
  text: string;
  /** The bot's @username, without the @ (TELEGRAM_BOT_USERNAME). */
  botUsername?: string | null;
  /** True when this message is a reply to a message the bot itself sent. */
  isReplyToBot?: boolean;
};

export function isPrivateChat(chatType: string | null | undefined): boolean {
  return (chatType ?? 'private') === 'private';
}

export function isAddressedToBot(check: AddressCheck): boolean {
  if (isPrivateChat(check.chatType)) return true;

  // A reply to the bot is the natural way to answer its confirm prompt, and it
  // is unambiguous even when the reply is a bare "yes". Checked BEFORE the
  // empty-text guard: a voice-note or photo reply carries no text, and dropping
  // it on the empty-text check would silently swallow a hands-free "yes" in a
  // group (the crew's whole reason for voice notes on a ladder).
  if (check.isReplyToBot) return true;

  const text = (check.text ?? '').trim();
  if (!text) return false;

  // Slash commands reach the bot even with privacy mode left ON, so they must
  // keep working regardless of configuration.
  if (text.startsWith('/')) return true;

  const username = (check.botUsername ?? process.env.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (username && new RegExp(`@${escapeRegex(username)}\\b`, 'i').test(text)) return true;

  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
