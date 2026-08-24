import { describe, expect, it } from 'vitest';

import { isValidTelegramUserId, parseTelegramUserId } from './telegramUserId';

describe('isValidTelegramUserId', () => {
  it('accepts a positive integer id of realistic length', () => {
    expect(isValidTelegramUserId('123456789')).toBe(true);
    expect(isValidTelegramUserId('7')).toBe(true);
  });

  it('REJECTS an @handle — Telegram sends a number, so a handle would never match', () => {
    expect(isValidTelegramUserId('@sonson')).toBe(false);
    expect(isValidTelegramUserId('sonson')).toBe(false);
  });

  it('REJECTS a leading zero — String(Number) never produces one, so it can never match', () => {
    expect(isValidTelegramUserId('0123456789')).toBe(false);
    expect(isValidTelegramUserId('0')).toBe(false);
  });

  it('rejects blanks, signs, decimals and separators', () => {
    expect(isValidTelegramUserId('')).toBe(false);
    expect(isValidTelegramUserId('-123')).toBe(false);
    expect(isValidTelegramUserId('12.3')).toBe(false);
    expect(isValidTelegramUserId('1 2')).toBe(false);
  });
});

describe('parseTelegramUserId', () => {
  it('treats null and empty string as an explicit UNLINK', () => {
    expect(parseTelegramUserId(null)).toEqual({ ok: true, telegramUserId: null });
    expect(parseTelegramUserId('')).toEqual({ ok: true, telegramUserId: null });
    expect(parseTelegramUserId('   ')).toEqual({ ok: true, telegramUserId: null });
  });

  it('treats a MISSING key as a caller bug, never as an unlink', () => {
    // The distinction matters: silently unlinking someone because a key was
    // omitted would stop their texts clocking them in, with no error anywhere.
    expect(parseTelegramUserId(undefined)).toEqual({ ok: false, reason: 'missing' });
  });

  it('trims and returns a valid id', () => {
    expect(parseTelegramUserId(' 123456789 ')).toEqual({ ok: true, telegramUserId: '123456789' });
  });

  it('reports an invalid id distinctly from a missing one', () => {
    expect(parseTelegramUserId('@sonson')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseTelegramUserId('0123')).toEqual({ ok: false, reason: 'invalid' });
  });
});
