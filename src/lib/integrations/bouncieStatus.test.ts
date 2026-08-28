// Settings → Bouncie's data — the health surface for ledger row 430.
//
// The one behaviour worth pinning hardest: an EXPIRED access token means the
// grant is dead, with no grace window. Tokens refresh every ~2 minutes while
// the poller runs, so "expired" and "the refreshes stopped" are the same fact,
// and an earlier draft's 24-hour grace meant a dead grant showed "Connected"
// for up to a day — the exact lie the page exists to prevent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { db } = vi.hoisted(() => {
  const db = {
    grants: [] as { account_email: string; updated_at: string | null; access_token_expires_at: string | null }[],
    vehicles: [] as { label: string; imei: string | null; last_seen_at: string | null }[],
    errors: {} as Record<string, { message: string } | undefined>,
  };
  return { db };
});

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, not: self, order: self, limit: self,
        returns: async () => {
          const error = db.errors[table] ?? null;
          if (error) return { data: null, error };
          if (table === 'integration_tokens') return { data: db.grants, error: null };
          if (table === 'vehicles') return { data: db.vehicles, error: null };
          return { data: [], error: null };
        },
      });
      return chain;
    },
  }),
}));

import { loadBouncieStatus } from './bouncieStatus';

const NOW = new Date('2026-08-28T15:00:00.000Z');
const saved: Record<string, string | undefined> = {};
const OAUTH_VARS = ['BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_REDIRECT_URI', 'BOUNCIE_WEBHOOK_SECRET'];

beforeEach(() => {
  for (const k of OAUTH_VARS) {
    saved[k] = process.env[k];
    process.env[k] = 'set';
  }
  db.grants = [];
  db.vehicles = [];
  db.errors = {};
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function grant(over: Record<string, unknown> = {}) {
  return {
    account_email: 'info@yulelovelights.com',
    updated_at: '2026-08-28T14:58:00.000Z',
    access_token_expires_at: '2026-08-28T15:50:00.000Z', // 50 min ahead of NOW
    ...over,
  };
}

describe('grant health', () => {
  it('a live token reads healthy', async () => {
    db.grants = [grant()];
    const s = await loadBouncieStatus(NOW);
    expect(s.grant).toMatchObject({ present: true, healthy: true, accountEmail: 'info@yulelovelights.com' });
  });

  it('an EXPIRED token reads dead IMMEDIATELY — no grace window', async () => {
    // Expired 30 minutes ago. Refreshes happen every ~2 minutes while alive,
    // so this grant has already missed ~15 of them.
    db.grants = [grant({ access_token_expires_at: '2026-08-28T14:30:00.000Z' })];
    const s = await loadBouncieStatus(NOW);
    expect(s.grant.healthy).toBe(false);
  });

  it('a token with no recorded expiry reads unhealthy rather than trusted', async () => {
    db.grants = [grant({ access_token_expires_at: null })];
    expect((await loadBouncieStatus(NOW)).grant.healthy).toBe(false);
  });

  it('no grant at all: present false, healthy false', async () => {
    const s = await loadBouncieStatus(NOW);
    expect(s.grant).toMatchObject({ present: false, healthy: false });
  });

  it('SURFACES a second stored grant instead of silently picking one', async () => {
    // The auth layer refuses to guess between grants; the status page must at
    // least say the ambiguity exists.
    db.grants = [grant(), grant({ account_email: 'other@example.com' })];
    expect((await loadBouncieStatus(NOW)).grant.multipleGrants).toBe(true);
  });
});

describe('vehicle signal', () => {
  it('classifies live, stale and never', async () => {
    db.vehicles = [
      { label: 'Van', imei: '1', last_seen_at: '2026-08-28T14:55:00.000Z' }, // 5 min: live
      { label: 'Truck', imei: '2', last_seen_at: '2026-08-28T13:00:00.000Z' }, // 2h: stale
      { label: 'Spare', imei: null, last_seen_at: null }, // never
    ];
    const s = await loadBouncieStatus(NOW);
    expect(s.vehicles.map((v) => v.signal)).toEqual(['live', 'stale', 'never']);
  });
});

describe('read failures surface, never silently empty', () => {
  it('a grant-read error lands in errors', async () => {
    db.errors.integration_tokens = { message: 'boom' };
    const s = await loadBouncieStatus(NOW);
    expect(s.errors[0]).toMatch(/reading the grant/);
  });

  it('a vehicles-read error lands in errors', async () => {
    db.errors.vehicles = { message: 'boom' };
    const s = await loadBouncieStatus(NOW);
    expect(s.errors[0]).toMatch(/reading vehicles/);
  });
});

describe('config flags', () => {
  it('follows the env vars', async () => {
    expect((await loadBouncieStatus(NOW)).oauthConfigured).toBe(true);
    delete process.env.BOUNCIE_CLIENT_SECRET;
    expect((await loadBouncieStatus(NOW)).oauthConfigured).toBe(false);
    delete process.env.BOUNCIE_WEBHOOK_SECRET;
    expect((await loadBouncieStatus(NOW)).webhookConfigured).toBe(false);
  });
});
