// Operator accounts (Settings → Accounts) — ADMIN-ONLY (ledger #81 Slice 3).
//
// Server component: resolves the operator from the session and renders the CRUD
// UI only for admins. When the auth gate is dormant + Supabase auth is
// unconfigured, getOperator() is null → the "admins only" notice (the page is
// inert until go-live). A logged-in non-admin operator sees the same notice.

import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { getOperator } from '@/lib/auth/supabaseServer';
import { AccountsManager } from '@/components/settings/AccountsManager';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  const operator = await getOperator();
  const isAdmin = operator?.role === 'admin';

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="accounts" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Operator accounts</h1>
          <p className="text-sm text-gray-500 mt-1">
            Staff who can sign in to the operator tools. Admins can add or remove accounts, reset
            passwords, and change roles.
          </p>
        </div>

        {isAdmin && operator ? (
          <AccountsManager currentUserId={operator.id} />
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
            <p className="font-medium text-gray-900">Admins only</p>
            <p className="mt-1 leading-relaxed">
              Operator accounts are managed by admins — sign in with an admin account to manage staff
              access. Until the operator login system is turned on, this page is inactive.
            </p>
          </div>
        )}
      </main>
    </OperatorShell>
  );
}
