// Bot team settings (Settings → Bot team) — text-ops bot roster, ledger #168.
//
// Server component. ADMIN-only, mirroring Settings → Accounts: the crew/staff/
// admin roster for the Telegram ops bot lives here so roles change without a
// Vercel redeploy. When the auth gate is dormant + Supabase auth is unconfigured
// getOperator() is null → the sign-in notice (page inert until go-live).

import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { getOperator } from '@/lib/auth/supabaseServer';
import { BotTeamManager } from '@/components/settings/BotTeamManager';

export const dynamic = 'force-dynamic';

export default async function BotTeamPage() {
  const operator = await getOperator();
  const isAdmin = operator?.role === 'admin';

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="bot-team" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Bot team</h1>
          <p className="text-sm text-gray-500 mt-1">
            Who can use the Telegram ops bot, and what they&rsquo;re allowed to do.
          </p>
        </div>

        {operator ? (
          isAdmin ? (
            <BotTeamManager />
          ) : (
            <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
              <p className="font-medium text-gray-900">Admins only</p>
              <p className="mt-1 leading-relaxed">
                Managing the bot team is limited to admin accounts. Ask Naldo or Jason.
              </p>
            </div>
          )
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
            <p className="font-medium text-gray-900">Sign in to manage the bot team</p>
            <p className="mt-1 leading-relaxed">
              This page is inactive until the operator login system is turned on.
            </p>
          </div>
        )}
      </main>
    </OperatorShell>
  );
}
