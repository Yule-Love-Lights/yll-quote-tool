import { describe, it, expect, afterEach } from 'vitest';
import { verifyTelegramSecret, isAllowedChat, cleanTelegramCommand } from './telegram';

describe('verifyTelegramSecret (#82 Phase 3)', () => {
  it('accepts a matching secret (constant-time)', () => {
    expect(verifyTelegramSecret('abc123', 'abc123')).toBe(true);
  });
  it('rejects a mismatch / missing header / missing server secret', () => {
    expect(verifyTelegramSecret('abc123', 'XYZ999')).toBe(false);
    expect(verifyTelegramSecret(null, 'abc123')).toBe(false);
    expect(verifyTelegramSecret(undefined, 'abc123')).toBe(false);
    expect(verifyTelegramSecret('abc123', undefined)).toBe(false); // fails closed
    expect(verifyTelegramSecret('abc123', '')).toBe(false);
  });
});

describe('isAllowedChat', () => {
  const prev = process.env.TELEGRAM_ALLOWED_CHATS;
  afterEach(() => {
    if (prev === undefined) delete process.env.TELEGRAM_ALLOWED_CHATS;
    else process.env.TELEGRAM_ALLOWED_CHATS = prev;
  });

  it('matches numeric chat ids (positive 1:1, negative groups)', () => {
    process.env.TELEGRAM_ALLOWED_CHATS = '-1001234567890, 987654321';
    expect(isAllowedChat(-1001234567890)).toBe(true); // group
    expect(isAllowedChat(987654321)).toBe(true); // 1:1
    expect(isAllowedChat('-1001234567890')).toBe(true); // string form
    expect(isAllowedChat(999)).toBe(false); // not in list
  });

  it('fails closed when the allowlist env is unset/empty/null chat', () => {
    delete process.env.TELEGRAM_ALLOWED_CHATS;
    expect(isAllowedChat(123)).toBe(false);
    process.env.TELEGRAM_ALLOWED_CHATS = '';
    expect(isAllowedChat(123)).toBe(false);
    process.env.TELEGRAM_ALLOWED_CHATS = '123';
    expect(isAllowedChat(null)).toBe(false);
    expect(isAllowedChat(undefined)).toBe(false);
  });
});

describe('cleanTelegramCommand', () => {
  it('strips the leading slash for /command style', () => {
    expect(cleanTelegramCommand('/help')).toBe('help');
    expect(cleanTelegramCommand('/jobs')).toBe('jobs');
  });
  it('strips @bot mentions in any position (and collapses whitespace)', () => {
    expect(cleanTelegramCommand('/help@yll_inventory_bot')).toBe('help');
    expect(cleanTelegramCommand('@yll_inventory_bot jobs')).toBe('jobs');
    expect(cleanTelegramCommand('move 1042 prepared @yll_inventory_bot')).toBe('move 1042 prepared');
    expect(cleanTelegramCommand('move @bot 1042 prepared')).toBe('move 1042 prepared');
  });
  it('leaves plain commands unchanged', () => {
    expect(cleanTelegramCommand('help')).toBe('help');
    expect(cleanTelegramCommand('move 1042 prepared')).toBe('move 1042 prepared');
    expect(cleanTelegramCommand('set 14147 200')).toBe('set 14147 200');
  });
  it('handles empty / null / whitespace-only input', () => {
    expect(cleanTelegramCommand('')).toBe('');
    expect(cleanTelegramCommand(null)).toBe('');
    expect(cleanTelegramCommand(undefined)).toBe('');
    expect(cleanTelegramCommand('   ')).toBe('');
    expect(cleanTelegramCommand('/')).toBe('');
  });
});
