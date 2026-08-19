import { describe, expect, it } from 'vitest';

import { cronDenial, verifyCronRequest } from './cronAuth';

const SECRET = 'a-long-enough-cron-secret';

describe('verifyCronRequest', () => {
  it('accepts the right bearer token', () => {
    expect(verifyCronRequest(`Bearer ${SECRET}`, SECRET)).toBe('ok');
  });

  it('rejects a wrong token as UNAUTHORIZED, not unconfigured', () => {
    expect(verifyCronRequest('Bearer nope', SECRET)).toBe('unauthorized');
    expect(verifyCronRequest(undefined, SECRET)).toBe('unauthorized');
    expect(verifyCronRequest(null, SECRET)).toBe('unauthorized');
  });

  it('reports a MISSING secret as unconfigured — the distinction that matters', () => {
    // This is the case that let the sibling project run dark for 8+ days.
    expect(verifyCronRequest(`Bearer ${SECRET}`, undefined)).toBe('unconfigured');
    expect(verifyCronRequest(`Bearer ${SECRET}`, '')).toBe('unconfigured');
  });

  it('accepts a SHORT but real secret, because length is not what this guard decides', () => {
    // An earlier draft rejected anything under 16 chars as a placeholder. That
    // would have 503'd every cron in prod if the real secret were shorter.
    expect(verifyCronRequest('Bearer short1', 'short1')).toBe('ok');
  });

  it('does not accept a token that merely shares a prefix or length', () => {
    expect(verifyCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe('unauthorized');
    expect(verifyCronRequest(`Bearer ${'x'.repeat(SECRET.length)}`, SECRET)).toBe('unauthorized');
  });
});

describe('cronDenial', () => {
  it('returns null when authorized', () => {
    expect(cronDenial(`Bearer ${SECRET}`, SECRET)).toBeNull();
  });

  it('401s a wrong token', () => {
    expect(cronDenial('Bearer nope', SECRET)?.status).toBe(401);
  });

  it('503s AND names the variable when unconfigured', async () => {
    const res = cronDenial(`Bearer ${SECRET}`, undefined);
    expect(res?.status).toBe(503);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain('CRON_SECRET');
  });

  it('a monitor can tell a dead cron from a bad caller by status alone', () => {
    expect(cronDenial('Bearer wrong', SECRET)?.status).toBe(401);
    expect(cronDenial('Bearer wrong', undefined)?.status).toBe(503);
  });
});
