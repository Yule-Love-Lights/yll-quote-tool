// Quotes settings (Settings → Quotes) — its own sub-category, alongside
// Training / Customer Portal / Accounts. Home of the #93 "Make New Test Quote"
// entry + the saved-quotes dev tools (delete test data / delete all).

import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { getOperator } from '@/lib/auth/supabaseServer';
import { QuotesSettings } from '@/components/settings/QuotesSettings';
import { EventRatesSettings } from '@/components/settings/EventRatesSettings';
import { PermanentRatesSettings } from '@/components/settings/PermanentRatesSettings';
import { PermanentBistroRatesSettings } from '@/components/settings/PermanentBistroRatesSettings';
import { WarrantySettings } from '@/components/settings/WarrantySettings';
import { PortalSwatchEditor } from '@/components/settings/PortalSwatchEditor';
import { DEFAULT_PERMANENT_WARRANTY } from '@/lib/permanent/types';
import {
  DEFAULT_HOLIDAY_WARRANTY,
  DEFAULT_EVENT_WARRANTY,
  DEFAULT_BISTRO_WARRANTY,
} from '@/lib/warranty/types';

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
        <EventRatesSettings />

        <div className="mt-6">
          <PermanentRatesSettings />
        </div>

        <div className="mt-6">
          <PermanentBistroRatesSettings />
        </div>

        <div className="mt-6">
          <WarrantySettings
            settingsKey="holidayWarranty"
            title="Holiday “Your Protection” card"
            description="The eyebrow, heading, and five guarantee bullets on the holiday portal’s protection card. Leave a bullet blank to hide it. Saving a copy change bumps the terms version: quotes that customers have already approved keep the version they agreed to, so an edit here never changes a booked customer’s terms."
            defaultWarranty={DEFAULT_HOLIDAY_WARRANTY}
            bulletHints={[
              'Slot 1, wrench badge: the maintenance / 48-hour fix guarantee.',
              'Slot 2, bulb badge: free bulb-burnout replacement.',
              'Slot 3, calendar badge: the takedown window.',
              'Slot 4, house badge: no roof damage (clips only).',
              'Slot 5, shield badge: liability insurance, licensed and bonded.',
            ]}
          />
        </div>

        <div className="mt-6">
          <WarrantySettings
            settingsKey="eventWarranty"
            title="Event “Your Protection” card"
            description="The eyebrow, heading, and five guarantee bullets on the event portal’s protection card. Leave a bullet blank to hide it. Saving a copy change bumps the terms version: quotes that customers have already approved keep the version they agreed to, so an edit here never changes a booked customer’s terms."
            defaultWarranty={DEFAULT_EVENT_WARRANTY}
            bulletHints={[
              'Slot 1, wrench badge: same-day fix if something goes dark.',
              'Slot 2, bulb badge: every bulb tested before and the day of the event.',
              'Slot 3, calendar badge: takedown handled after the event.',
              'Slot 4, house badge: no damage to the home, venue, or landscaping.',
              'Slot 5, shield badge: licensed and insured.',
            ]}
          />
        </div>

        <div className="mt-6">
          <WarrantySettings
            settingsKey="bistroWarranty"
            title="Bistro “Your Protection” card"
            description="The eyebrow, heading, and four guarantee bullets on the permanent-bistro portal’s protection card. Leave a bullet blank to hide it. Saving a copy change bumps the terms version: quotes that customers have already approved keep the version they agreed to, so an edit here never changes a booked customer’s terms."
            defaultWarranty={DEFAULT_BISTRO_WARRANTY}
            bulletHints={[
              'Slot 1, shield badge: the workmanship warranty.',
              'Slot 2, bulb badge: commercial-grade, weather-rated hardware.',
              'Slot 3, wrench badge: service call if something goes dark.',
              'Slot 4, credit-card badge: nothing charged until quote approval.',
            ]}
          />
        </div>

        <div className="mt-6">
          <WarrantySettings
            settingsKey="permanentWarranty"
            title="Permanent “Your Protection” card"
            description="The eyebrow, heading, and six guarantee bullets on the permanent portal’s protection card. Leave a bullet blank to hide it. Saving a copy change bumps the terms version — quotes that customers have already approved keep the version they agreed to, so an edit here never changes a booked customer’s terms."
            defaultWarranty={DEFAULT_PERMANENT_WARRANTY}
            bulletHints={[
              'Slot 1 · ∞ badge — the lifetime materials warranty (the legal term).',
              'Slot 2 · phone badge — app / color control.',
              'Slot 3 · eye-off badge — invisible by day.',
              'Slot 4 · house badge — no roof damage.',
              'Slot 5 · palette badge — everyday + holiday color.',
              'Slot 6 · shield badge — insurance / licensed + bonded.',
            ]}
          />
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
