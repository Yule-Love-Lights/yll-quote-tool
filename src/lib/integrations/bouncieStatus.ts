// src/lib/integrations/bouncieStatus.ts — everything Settings → Bouncie shows
// (ledger rows 403 + 430; Naldo 2026-08-27: "Bouncie should have its own
// section, like Telegram has its own").
//
// This is the health surface row 430 was still missing: whether the grant is
// alive, when a token last moved, and what the poller last saw — read in one
// place, so "connected" and "the grant died three weeks ago" stop looking
// identical. Read-only: nothing here writes anything.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { isBouncieOAuthConfigured } from '@/lib/integrations/bouncieAuth';
import { isBouncieWebhookConfigured } from '@/lib/integrations/bouncie';
import { STALE_POSITION_MINUTES } from '@/lib/integrations/vehicleProximity';

export type BouncieStatus = {
  /** The four OAuth env vars exist. Without them nothing below can work. */
  oauthConfigured: boolean;
  /** The webhook shared secret exists (phase 2; independent of OAuth). */
  webhookConfigured: boolean;
  grant: {
    present: boolean;
    accountEmail: string | null;
    /** When a token last moved — refreshes bump this, so a healthy poller keeps it recent. */
    updatedAt: string | null;
    /** When the current access token expires. Past + no recent update = the grant is likely dead. */
    accessTokenExpiresAt: string | null;
    /** Computed here, not in a component. Tokens refresh every ~2 minutes
     * while the poller runs, so the honest rule is simply: an EXPIRED access
     * token means the refreshes stopped and the grant is dead. An earlier
     * draft gave this a 24-hour grace window, which meant a dead grant showed
     * "Connected" for up to a day — the exact lie this page exists to prevent
     * (S68 technical lens). */
    healthy: boolean;
    /** More than one stored grant is an ambiguous state the auth layer refuses
     * to guess about; the page should say so rather than silently pick one. */
    multipleGrants: boolean;
  };
  vehicles: {
    label: string;
    imei: string | null;
    lastSeenAt: string | null;
    signal: 'live' | 'stale' | 'never';
  }[];
  errors: string[];
};

export async function loadBouncieStatus(now: Date = new Date()): Promise<BouncieStatus> {
  const out: BouncieStatus = {
    oauthConfigured: isBouncieOAuthConfigured(),
    webhookConfigured: isBouncieWebhookConfigured(),
    grant: { present: false, accountEmail: null, updatedAt: null, accessTokenExpiresAt: null, healthy: false, multipleGrants: false },
    vehicles: [],
    errors: [],
  };

  const sb = getSupabaseServiceClient();
  if (!sb) {
    out.errors.push('no service client');
    return out;
  }

  const grantRes = await sb
    .from('integration_tokens')
    .select('account_email, updated_at, access_token_expires_at')
    .eq('provider', 'bouncie')
    .order('updated_at', { ascending: false })
    .limit(2)
    .returns<{ account_email: string; updated_at: string | null; access_token_expires_at: string | null }[]>();
  if (grantRes.error) out.errors.push(`reading the grant: ${grantRes.error.message}`);
  const grant = grantRes.data?.[0];
  if (grant) {
    out.grant = {
      present: true,
      accountEmail: grant.account_email,
      updatedAt: grant.updated_at,
      accessTokenExpiresAt: grant.access_token_expires_at,
      healthy:
        grant.access_token_expires_at != null &&
        Date.parse(grant.access_token_expires_at) > now.getTime(),
      multipleGrants: (grantRes.data?.length ?? 0) > 1,
    };
  }

  const vehiclesRes = await sb
    .from('vehicles')
    .select('label, imei, last_seen_at')
    .eq('active', true)
    .order('label')
    .returns<{ label: string; imei: string | null; last_seen_at: string | null }[]>();
  if (vehiclesRes.error) out.errors.push(`reading vehicles: ${vehiclesRes.error.message}`);
  for (const v of vehiclesRes.data ?? []) {
    out.vehicles.push({
      label: v.label,
      imei: v.imei,
      lastSeenAt: v.last_seen_at,
      signal: !v.last_seen_at
        ? 'never'
        : now.getTime() - Date.parse(v.last_seen_at) <= STALE_POSITION_MINUTES * 60_000
          ? 'live'
          : 'stale',
    });
  }

  return out;
}
