import { describe, expect, it } from 'vitest';

import {
  advertisingAppMetadata,
  advertisingMetadataIsSafe,
  validateAdvertisingCredentials,
} from './advertisingAccounts';
import { isAdvertisingAccount } from '@/lib/auth/supabaseServer';

describe('advertising account guards', () => {
  it('minted metadata reads as advertising to the population lock', () => {
    const meta = advertisingAppMetadata('Joe Signs');
    expect(isAdvertisingAccount(meta)).toBe(true);
    expect(advertisingMetadataIsSafe(meta)).toBe(true);
  });

  it('refuses metadata that would escalate', () => {
    expect(advertisingMetadataIsSafe({ role: 'admin', name: 'x' })).toBe(false);
    expect(advertisingMetadataIsSafe({ role: 'operator', name: 'x' })).toBe(false);
    expect(advertisingMetadataIsSafe({ name: 'x' })).toBe(false);
  });

  it('validates credentials: real email, 8+ char password', () => {
    expect(validateAdvertisingCredentials({ email: 'joe@x.com', password: 'longenough' }).ok).toBe(true);
    expect(validateAdvertisingCredentials({ email: 'not-an-email', password: 'longenough' }).ok).toBe(false);
    expect(validateAdvertisingCredentials({ email: 'joe@x.com', password: 'short' }).ok).toBe(false);
  });
});
