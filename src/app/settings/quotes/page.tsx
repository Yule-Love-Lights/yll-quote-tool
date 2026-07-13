// Quotes settings (Settings → Quotes) — its own sub-category, alongside
// Training / Customer Portal / Accounts. Home of the #93 "Make New Test Quote"
// entry + the saved-quotes dev tools (delete test data / delete all).

import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { getOperator } from '@/lib/auth/supabaseServer';
import { QuotesSettings } from '@/components/settings/QuotesSettings';
import { HolidayRatesSettings } from '@/components/settings/HolidayRatesSettings';
import { EventRatesSettings } from '@/components/settings/EventRatesSettings';
import { PermanentRatesSettings } from '@/components/settings/PermanentRatesSettings';
import { PermanentBistroRatesSettings } from '@/components/settings/PermanentBistroRatesSettings';
import { PermanentWarrantySettings } from '@/components/settings/PermanentWarrantySettings';
import { PortalSwatchEditor } from '@/components/settings/PortalSwatchEditor';

export const dynamic = 'force-dynamic';

export default async function QuotesSettingsPage() {
  // #81 defense-in-depth (dormant until AUTH_GATE_ENABLED): this page carries
  // destructive dev tools, so gate it behind operator auth like the rest of the
  // operator surface. No-op until the flag is on (then the middleware perimeter +
  // this check both apply).
  if (process.env.AUTH_GATE_ENABLED === 'true' && !(await getOperator())) {
    redirect('/login?from=/settings/quotes');
  }

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="quotes" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Quotes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Make a fully-simulated test quote to exercise the whole flow, plus developer tools for the
            saved-quotes table.
          </p>
        </div>
        <QuotesSettings />

        <hr className="my-8 border-gray-200" />
        <HolidayRatesSettings />

        <hr className="my-8 border-gray-200" />
        <EventRatesSettings />

        <div className="mt-6">
          <PermanentRatesSettings />
        </div>

        <div className="mt-6">
          <PermanentBistroRatesSettings />
        </div>

        <div className="mt-6">
          <PermanentWarrantySettings />
        </div>

        <div className="mt-6">
          {/* #88 P6b-4 — permanent portal color presets (its own list, separate
              from the holiday swatches on Settings → Customer Portal). */}
          <PortalSwatchEditor
            settingsKey="permanentSwatches"
            title="Permanent light colors"
            description="The color presets a permanent-lighting customer picks from on the portal (they can also build their own from any color). Rename, reorder, remove, or add — built from your existing bulb colors. “As Designed” always stays first."
          />
        </div>
      </main>
    </OperatorShell>
  );
}
