// Customer Portal settings — PLACEHOLDER tab. The controls for the customer-
// facing quote portal (branding, copy, etc.) will live here; for now this is a
// stub so the tab exists in the Settings sub-nav.

import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';

export default function CustomerPortalSettingsPage() {
  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="customer-portal" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Customer Portal</h1>
          <p className="text-sm text-gray-500 mt-1">
            Settings for the customer-facing quote portal.
          </p>
        </div>
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-base font-medium text-gray-700">Coming soon</p>
          <p className="text-sm text-gray-500 mt-1">Customer portal settings will live here.</p>
        </div>
      </main>
    </OperatorShell>
  );
}
