import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mintCrewToken,
  verifyCrewToken,
  CREW_LINK_TTL_MS,
  CREW_SESSION_TTL_MS,
} from './crewLink';

const SECRET = 'test-secret-value-for-crew-links';
const CREW = '11111111-2222-3333-4444-555555555555';
const NOW = Date.parse('2026-08-29T12:00:00Z');

describe('crew link tokens', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CREW_LINK_SECRET;
    process.env.CREW_LINK_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREW_LINK_SECRET;
    else process.env.CREW_LINK_SECRET = prev;
  });

  it('mints a link token that verifies back to its crew member', () => {
    const token = mintCrewToken('link', CREW, NOW);
    expect(verifyCrewToken('link', token, NOW)).toEqual({ ok: true, crewMemberId: CREW });
  });

  it('fails CLOSED with no secret configured, minting and verifying alike', () => {
    const token = mintCrewToken('link', CREW, NOW);
    delete process.env.CREW_LINK_SECRET;
    expect(() => mintCrewToken('link', CREW, NOW)).toThrow(/CREW_LINK_SECRET/);
    expect(verifyCrewToken('link', token, NOW)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('refuses a token signed with a different secret', () => {
    const token = mintCrewToken('link', CREW, NOW);
    process.env.CREW_LINK_SECRET = 'a-different-secret-entirely';
    expect(verifyCrewToken('link', token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a tampered crew id even when the envelope still parses', () => {
    const token = mintCrewToken('link', CREW, NOW);
    const [prefix, payload, sig] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.c = '99999999-9999-9999-9999-999999999999';
    const forged = `${prefix}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`;
    expect(verifyCrewToken('link', forged, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('expires a link token the millisecond after its window closes', () => {
    const token = mintCrewToken('link', CREW, NOW);
    expect(verifyCrewToken('link', token, NOW + CREW_LINK_TTL_MS)).toEqual({ ok: true, crewMemberId: CREW });
    expect(verifyCrewToken('link', token, NOW + CREW_LINK_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  // Domain separation: a 15-minute link handed out over Telegram must not be
  // usable as a 30-day session cookie, and a stolen session cookie must not be
  // replayable into the entry route.
  it('never accepts a link token as a session, or a session token as a link', () => {
    const link = mintCrewToken('link', CREW, NOW);
    const session = mintCrewToken('session', CREW, NOW);
    expect(verifyCrewToken('session', link, NOW)).toEqual({ ok: false, reason: 'wrong_purpose' });
    expect(verifyCrewToken('link', session, NOW)).toEqual({ ok: false, reason: 'wrong_purpose' });
  });

  it('gives a session a longer life than a link, and both are finite', () => {
    expect(CREW_SESSION_TTL_MS).toBeGreaterThan(CREW_LINK_TTL_MS);
    const session = mintCrewToken('session', CREW, NOW);
    expect(verifyCrewToken('session', session, NOW + CREW_SESSION_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it.each(['', 'garbage', 'c1.only-two.parts.extra', 'c1..', 'c1.%%%.%%%'])(
    'refuses malformed token %j without throwing',
    (bad) => {
      expect(verifyCrewToken('link', bad, NOW).ok).toBe(false);
    },
  );
});
