// Account settings (Settings → Accounts) — ledger #81 Slice 3.
//
// Server component. Any logged-in operator can change their OWN password here;
// ADMINS additionally get the staff-management table (add/remove operators,
// reset passwords, change roles). When the auth gate is dormant + Supabase auth
// is unconfigured, getOperator() is null → the sign-in notice (page is inert
// until go-live).

import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { getOperator } from '@/lib/auth/supabaseServer';
import { AccountsManager } from '@/components/settings/AccountsManager';
import { ChangeMyPassword } from '@/components/settings/ChangeMyPassword';
import { CrewLogins } from '@/components/settings/CrewLogins';
import { OfficeStaff } from '@/components/settings/OfficeStaff';

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
          <h1 className="text-xl font-semibold text-gray-900">Account</h1>
          <p className="text-sm text-gray-500 mt-1">
            {isAdmin
              ? 'Change your password, and add or remove staff accounts.'
              : 'Change your password.'}
          </p>
        </div>

        {operator ? (
          <div className="flex flex-col gap-8">
            <ChangeMyPassword name={operator.name} email={operator.email} />
            {isAdmin && (
              <>
                <section>
                  <h2 className="text-[15px] font-semibold text-gray-900 mb-3">Staff accounts</h2>
                  <AccountsManager currentUserId={operator.id} />
                </section>
                {/*
                  Office staff onboarding (row 354): turn an existing operator into
                  a time-clock user, replacing the hand-written SQL. Admin-only,
                  matching /api/admin/office-staff.
                */}
                <OfficeStaff />
                {/*
                  Was imported but never rendered, so the whole crew panel — login
                  creation (row 279/296) AND the Telegram link (row 318) — had no
                  reachable surface at all. Admin-only, matching every handler in
                  /api/admin/crew-accounts.
                */}
                <CrewLogins />
              </>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
            <p className="font-medium text-gray-900">Sign in to manage your account</p>
            <p className="mt-1 leading-relaxed">
              This page is inactive until the operator login system is turned on.
            </p>
          </div>
        )}
      </main>
    </OperatorShell>
  );
}
