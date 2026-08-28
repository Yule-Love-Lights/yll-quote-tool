// The geocode fix-list (ledger row 403; Naldo's rule 2026-08-27).
//
// Every property here has an address that could not be verified to a specific
// house, so it has no coordinates — and a job at it CANNOT be scheduled until
// someone fixes the address below. That is deliberate: the alternative was jobs
// that silently produce no GPS timeline, which read exactly like a crew that
// never showed up.
//
// Server component loads the list; the row editor is a client component that
// PATCHes the address and reports whether the fix actually verified.

import { OperatorShell } from '@/components/OperatorShell';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { GeocodeFixRow } from '@/components/admin/GeocodeFixRow';

export const dynamic = 'force-dynamic';

type UnverifiedProperty = {
  id: string;
  customer_id: string;
  address: string | null;
  nickname: string | null;
  customers: { name: string | null } | null;
};

// null means the list could NOT be loaded — the page must say so, never show
// the all-clear. Until 2026-08-28 a failure here returned [] and the page told
// staff "nothing needs fixing" while 25 unschedulable properties existed (the
// select asked for customers.display_name, a column that does not exist; the
// real column is `name`, and PostgREST answered 400 to every request).
async function listUnverifiedProperties(): Promise<UnverifiedProperty[] | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  // customers is a real FK relation, so the nested select works here (unlike
  // jobs->properties, which has no FK — measured the hard way in S68).
  const { data, error } = await sb
    .from('properties')
    .select('id, customer_id, address, nickname, customers(name)')
    .is('lat', null)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .returns<UnverifiedProperty[]>();
  if (error) {
    console.error('[admin/geocoding] list failed:', error.message);
    return null;
  }
  return data ?? [];
}

export default async function GeocodingPage() {
  const rows = await listUnverifiedProperties();

  return (
    <OperatorShell active="jobs">
      <main className="max-w-3xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Addresses that need fixing</h1>
          <p className="text-sm text-gray-500 mt-1">
            These addresses could not be matched to a specific house, so their jobs cannot be
            scheduled until the address is corrected. Fix one and it re-checks automatically.
          </p>
        </div>

        {rows === null ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
            The list could not be loaded, so it may not be empty. Reload the page; if this
            keeps happening, tell whoever maintains the tool.
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-gray-200 p-6 text-sm text-gray-600">
            Every property has verified coordinates. Nothing needs fixing.
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <GeocodeFixRow
                key={row.id}
                propertyId={row.id}
                customerId={row.customer_id}
                customerName={row.customers?.name ?? '(no name)'}
                nickname={row.nickname}
                address={row.address ?? ''}
              />
            ))}
          </ul>
        )}
      </main>
    </OperatorShell>
  );
}
