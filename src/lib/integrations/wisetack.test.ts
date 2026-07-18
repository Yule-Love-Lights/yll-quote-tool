// #154 interim — Wisetack prequal config (env-read helpers). Same env
// save/restore pattern the committed plan (Task 1.1) specifies.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isWisetackFinancingEnabled, getWisetackPrequalUrl } from './wisetack';

describe('wisetack prequal config', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.WISETACK_FINANCING_ENABLED;
    delete process.env.WISETACK_PREQUAL_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  describe('isWisetackFinancingEnabled', () => {
    it("is on only when the flag is exactly 'true'", () => {
      process.env.WISETACK_FINANCING_ENABLED = 'true';
      expect(isWisetackFinancingEnabled()).toBe(true);
    });
    it('anything else is off (unset, false, 1, TRUE)', () => {
      expect(isWisetackFinancingEnabled()).toBe(false);
      process.env.WISETACK_FINANCING_ENABLED = 'false';
      expect(isWisetackFinancingEnabled()).toBe(false);
      process.env.WISETACK_FINANCING_ENABLED = '1';
      expect(isWisetackFinancingEnabled()).toBe(false);
      process.env.WISETACK_FINANCING_ENABLED = 'TRUE';
      expect(isWisetackFinancingEnabled()).toBe(false);
    });
  });

  describe('getWisetackPrequalUrl', () => {
    it('returns the trimmed URL when set', () => {
      process.env.WISETACK_PREQUAL_URL = '  https://wisetack.us/#/example/prequalify  ';
      expect(getWisetackPrequalUrl()).toBe('https://wisetack.us/#/example/prequalify');
    });
    it('returns null when unset or blank (feature off regardless of the flag)', () => {
      expect(getWisetackPrequalUrl()).toBeNull();
      process.env.WISETACK_PREQUAL_URL = '   ';
      expect(getWisetackPrequalUrl()).toBeNull();
    });
  });
});
