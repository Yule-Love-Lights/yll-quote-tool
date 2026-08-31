// Bouncie settings (Settings → Bouncie) — the fleet GPS integration's own
// section, in the same shape as Telegram's and HighLevel's (Naldo, 2026-08-27:
// every integration gets its own section, no scattered pieces).
//
// This page is also the connection HEALTH surface ledger row 430 called for:
// grant present/absent, when a token last moved, and what the poller last saw
// per vehicle — so "connected" and "the grant quietly died" stop looking
// identical, and a connection failure lands HERE with its reason rather than
// on a generic accounts page.

import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';
import { loadBouncieStatus } from '@/lib/integrations/bouncieStatus';
import { BouncieConnectNotice } from '@/components/settings/BouncieConnectNotice';

export const dynamic = 'force-dynamic';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function BouncieSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (authGateEngaged() && !(await getOperator())) {
    redirect('/login?from=/settings/bouncie');
  }
  const params = (await searchParams) ?? {};
  const bouncie = Array.isArray(params.bouncie) ? params.bouncie[0] : params.bouncie;
  const status = await loadBouncieStatus();


  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="bouncie" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Bouncie (fleet GPS)</h1>
          <p className="text-sm text-gray-500 mt-1">
            The vehicle trackers: connection health, device status, and where the day&apos;s data
            shows up. Positions are polled every 2 minutes; customer addresses never leave this
            system.
          </p>
        </div>

        <BouncieConnectNotice status={bouncie} />

        {status.errors.length > 0 && (
          <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
            Some of this page could not load: {status.errors.join('; ')}
          </div>
        )}

        <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Connection</h2>
          {!status.oauthConfigured ? (
            <p className="text-sm text-gray-600">
              <span className="font-medium text-gray-900">Not configured.</span> Set{' '}
              <code className="text-xs">BOUNCIE_CLIENT_ID</code>,{' '}
              <code className="text-xs">BOUNCIE_CLIENT_SECRET</code>,{' '}
              <code className="text-xs">BOUNCIE_REDIRECT_URI</code> and{' '}
              <code className="text-xs">TOKEN_ENCRYPTION_KEY</code> in Vercel, redeploy, then
              reload this page.
            </p>
          ) : !status.grant.present ? (
            <div className="text-sm text-gray-600">
              <p className="mb-3">
                <span className="font-medium text-gray-900">Not connected.</span> The app is
                configured, but nobody has authorized it against a Bouncie account yet.
              </p>
              <a
                href="/api/integrations/bouncie/start"
                className="inline-block rounded px-4 py-2 text-sm font-medium text-white"
                style={{ background: 'var(--brand-evergreen-3)' }}
              >
                Connect Bouncie
              </a>
            </div>
          ) : (
            <div className="text-sm text-gray-600 space-y-1">
              <p>
                <span
                  className="font-medium"
                  style={{ color: status.grant.healthy ? 'var(--brand-evergreen-3)' : '#b91c1c' }}
                >
                  {status.grant.healthy ? 'Connected' : 'Connected, but the grant looks stale'}
                </span>{' '}
                as <span className="font-medium text-gray-900">{status.grant.accountEmail}</span>
              </p>
              {status.grant.multipleGrants && (
                <p className="text-amber-700">
                  More than one Bouncie connection is stored, which the system refuses to guess
                  between. Reconnect below to make the right one current, and mention it so the
                  extra row gets cleaned up.
                </p>
              )}
              <p>Token last refreshed: {fmt(status.grant.updatedAt)}</p>
              <p>Access token valid until: {fmt(status.grant.accessTokenExpiresAt)}</p>
              {!status.grant.healthy && (
                <p className="text-red-700 mt-2">
                  Tokens normally refresh all day while the poller runs. A stale grant usually
                  means the connection died — reconnect below.
                </p>
              )}
              <p className="pt-2">
                <a href="/api/integrations/bouncie/start" className="underline">
                  Reconnect
                </a>{' '}
                <span className="text-gray-400">
                  (safe any time; replaces the stored connection)
                </span>
              </p>
            </div>
          )}
        </section>

        <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Webhook (event receiver)</h2>
          <p className="text-sm text-gray-600">
            {status.webhookConfigured ? (
              <span>
                <span className="font-medium" style={{ color: 'var(--brand-evergreen-3)' }}>
                  Configured.
                </span>{' '}
                Bouncie can push events to this system (trip starts and ends, device
                connect/disconnect, battery).
              </span>
            ) : (
              <span>
                <span className="font-medium text-gray-900">Not configured.</span> Set{' '}
                <code className="text-xs">BOUNCIE_WEBHOOK_SECRET</code> in Vercel and register the
                webhook on the Bouncie portal with the same value.
              </span>
            )}
          </p>
        </section>

        <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Devices</h2>
          {status.vehicles.length === 0 ? (
            <p className="text-sm text-gray-600">No vehicles registered yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {status.vehicles.map((v) => (
                <li key={v.label} className="flex items-baseline justify-between">
                  <span className="font-medium text-gray-900">
                    {v.label}
                    <span className="text-gray-400 font-normal"> · {v.imei ?? 'no device'}</span>
                  </span>
                  {v.signal === 'live' && (
                    <span style={{ color: 'var(--brand-evergreen-3)' }}>
                      reporting · {fmt(v.lastSeenAt)}
                    </span>
                  )}
                  {v.signal === 'stale' && (
                    <span className="text-amber-700">no signal since {fmt(v.lastSeenAt)}</span>
                  )}
                  {v.signal === 'never' && <span className="text-gray-500">never reported</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Where the data shows up</h2>
          <ul className="space-y-1">
            <li>
              <a href="/admin/schedule" className="underline">
                Schedule page
              </a>{' '}
              — live positions, beside the day&apos;s jobs. The fleet view moved here on
              2026-08-31 and shows on today only.
            </li>
            <li>
              <a href="/admin/geocoding" className="underline">
                Addresses needing fixes
              </a>{' '}
              — properties that cannot be scheduled until corrected.
            </li>
          </ul>
          <p className="mt-3 text-gray-500">
            The crew&apos;s own clock stays the payroll record. GPS never writes payroll.
          </p>
        </section>
      </main>
    </OperatorShell>
  );
}
