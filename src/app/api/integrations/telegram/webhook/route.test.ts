// Telegram webhook — the SENDER LOG, and the gate ordering around it.
//
// The log is the whole point of these tests: a Telegram user id can only be
// learned from a message that person sent, so linking a crew member's
// crew_members.telegram_user_id depends on this line actually firing with the
// id in it. A log nobody has watched fire is a hypothesis, not a feature.
//
// Every IO seam is mocked (enable/config/secret/allowlist/send + the
// dispatcher); the route's own gate ordering and log formatting run for real.

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  isTelegramBotEnabled,
  isTelegramConfigured,
  verifyTelegramSecret,
  isAllowedChat,
  sendTelegramMessage,
  handleBotMessage,
} = vi.hoisted(() => ({
  isTelegramBotEnabled: vi.fn(() => true),
  isTelegramConfigured: vi.fn(() => true),
  verifyTelegramSecret: vi.fn(() => true),
  isAllowedChat: vi.fn(() => true),
  sendTelegramMessage: vi.fn(async () => undefined),
  handleBotMessage: vi.fn(async () => null as string | null),
}));

vi.mock('@/lib/integrations/telegram', () => ({
  isTelegramBotEnabled,
  isTelegramConfigured,
  verifyTelegramSecret,
  isAllowedChat,
  sendTelegramMessage,
}));
vi.mock('@/lib/integrations/botDispatch', () => ({ handleBotMessage }));

import { POST } from './route';

type Msg = Record<string, unknown>;

function makeReq(message: Msg): NextRequest {
  return {
    headers: { get: () => 'secret' },
    json: async () => ({ message }),
  } as unknown as NextRequest;
}

/** A crew member saying hi in the allowlisted jobs group. */
function groupHello(overrides: Msg = {}): Msg {
  return {
    chat: { id: -1001234567890, type: 'supergroup' },
    from: { id: 987654321, first_name: 'Little', last_name: 'James', username: 'lj_yll' },
    text: 'hi',
    ...overrides,
  };
}

let info: MockInstance<typeof console.info>;

beforeEach(() => {
  vi.clearAllMocks();
  isTelegramBotEnabled.mockReturnValue(true);
  isTelegramConfigured.mockReturnValue(true);
  verifyTelegramSecret.mockReturnValue(true);
  isAllowedChat.mockReturnValue(true);
  handleBotMessage.mockResolvedValue(null);
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every console.info line the route emitted, first argument only. */
function infoLines(): string[] {
  return info.mock.calls.map((c) => String(c[0]));
}

/** The single `[telegram] sender` line, or undefined when none was logged. */
function senderLine(): string | undefined {
  return infoLines().find((l) => l.includes('[telegram] sender'));
}

describe('telegram webhook — sender log', () => {
  it('logs the numeric sender id even when the dispatcher stays silent', async () => {
    // handleBotMessage returns null here — unaddressed group chatter, which the
    // bot does not reply to. The id must still be logged, because that silent
    // case is the one the linking workflow depends on. (Whether Telegram
    // DELIVERS such a message depends on the bot's BotFather privacy setting;
    // this asserts the route's behaviour once it arrives, not the delivery.)
    await POST(makeReq(groupHello()));

    const line = senderLine();
    expect(line).toBeDefined();
    expect(line).toContain('id=987654321');
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('names the sender so an id can be matched to a person', async () => {
    await POST(makeReq(groupHello()));

    const line = senderLine()!;
    expect(line).toContain('Little James');
    expect(line).toContain('@lj_yll');
  });

  it('falls back to (no name) rather than logging "undefined" when Telegram sends no name', async () => {
    await POST(makeReq(groupHello({ from: { id: 555 } })));

    const line = senderLine()!;
    expect(line).toContain('id=555');
    expect(line).toContain('(no name)');
    expect(line).not.toContain('undefined');
  });

  it('never puts the message text in the log, because a message can carry customer details', async () => {
    await POST(makeReq(groupHello({ text: 'call Susan Pace-Burke on 5165551234 re: the deposit' })));

    const line = senderLine()!;
    expect(line).not.toContain('Susan');
    expect(line).not.toContain('5165551234');
    // and no OTHER console.info line leaked it either
    expect(infoLines().join('\n')).not.toContain('Susan');
  });

  it('logs nothing and does no work when the chat is not allowlisted', async () => {
    // Ordering matters: the allowlist gate runs BEFORE the sender is resolved,
    // so a stranger who finds the bot never reaches the dispatcher — and the
    // chat-id warn already carries their id, since chat.id IS from.id in a DM.
    isAllowedChat.mockReturnValue(false);

    await POST(makeReq(groupHello()));

    expect(senderLine()).toBeUndefined();
    expect(handleBotMessage).not.toHaveBeenCalled();
  });

  it('logs nothing when the update carries no sender', async () => {
    await POST(makeReq({ chat: { id: -100, type: 'supergroup' }, text: 'hi' }));

    expect(senderLine()).toBeUndefined();
    expect(handleBotMessage).not.toHaveBeenCalled();
  });
});
