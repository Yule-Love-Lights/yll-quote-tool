import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAutoChargeEnabled, chargeBalanceOnFile } from './valorBalance';

const ENV = 'VALOR_AUTO_CHARGE_ENABLED';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

describe('isAutoChargeEnabled', () => {
  it('is false by default (no Valor capability confirmed)', () => {
    expect(isAutoChargeEnabled()).toBe(false);
  });

  it('is true for truthy flag values', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' on ']) {
      process.env[ENV] = v;
      expect(isAutoChargeEnabled()).toBe(true);
    }
  });
});

describe('chargeBalanceOnFile (stub — gated on Valor confirmation)', () => {
  it('reports not-enabled when the flag is off — makes no charge', async () => {
    const r = await chargeBalanceOnFile({ vaultToken: 'tok', amountUsd: 500, orderRef: 'q1' });
    expect(r).toMatchObject({ ok: false, reason: 'not-enabled' });
  });

  it('reports no-card when enabled but the quote has no saved token', async () => {
    process.env[ENV] = 'true';
    const r = await chargeBalanceOnFile({ vaultToken: null, amountUsd: 500, orderRef: 'q1' });
    expect(r).toMatchObject({ ok: false, reason: 'no-card' });
  });

  it('reports error (not implemented) when enabled with a token — never silently no-ops a real collection', async () => {
    process.env[ENV] = 'true';
    const r = await chargeBalanceOnFile({ vaultToken: 'tok', amountUsd: 500, orderRef: 'q1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('error');
  });
});
