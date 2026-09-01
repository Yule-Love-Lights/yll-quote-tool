// Who can see what (Naldo, 2026-09-01, built for Jason).
//
// Admin only, and gated server-side like every other admin page: the menu row
// that opens it is hidden from operators, but hiding a row is cosmetic and
// this redirect is the actual refusal.
//
// The content is a declared table in src/lib/auth/rolePermissions.ts, and
// rolePermissions.test.ts proves that table against the real routes and the
// real perimeter. That is deliberate: a permissions page nobody checks goes
// stale silently and then gets believed.

import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { ROLES } from '@/lib/auth/rolePermissions';

export const dynamic = 'force-dynamic';

const GATE_NOTE: Record<string, string> = {
  admin: 'Admin only',
  operator: 'Any signed-in office account',
  advertising: 'Advertising account only',
  'crew-link': 'Signed link, not a login',
};

export default async function PermissionsPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  return (
    <OperatorShell active="settings">
      <main className="max-w-4xl mx-auto">
        <div className="mb-8">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Who can see what</h1>
          <p className="text-sm text-gray-500 mt-1">
            The four groups of people who use this tool, and exactly what each one reaches.
          </p>
        </div>

        {/* The thing most likely to be misread, said once at the top rather
            than buried in the crew section. */}
        <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold mb-1">Three different ways in, not one.</p>
          <p>
            Office and Admin are the same kind of account separated by a single flag. Advertising is
            its own account type, fenced to its own screens. Crew is not an account at all: crew
            logins were retired and are now refused outright, and field crew arrive on a signed link
            instead.
          </p>
        </div>

        <div className="flex flex-col gap-8">
          {ROLES.map((r) => (
            <section
              key={r.id}
              className="rounded-lg border border-gray-200 bg-white overflow-hidden"
            >
              <div className="border-b border-gray-200 px-5 py-4">
                <h2 className="text-base font-semibold text-gray-900">{r.name}</h2>
                <p className="mt-1 text-sm text-gray-600">{r.whoTheyAre}</p>
                <p className="mt-2 text-sm">
                  <span className="font-medium text-gray-800">How they sign in: </span>
                  <span className="text-gray-600">{r.howTheySignIn}</span>
                </p>
              </div>

              <div className="px-5 py-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">
                  Can
                </h3>
                <ul className="flex flex-col gap-3">
                  {r.can.map((cap) => (
                    <li key={cap.label} className="text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-gray-900">{cap.label}</span>
                        {cap.page && (
                          <code className="text-xs text-gray-500">{cap.page}</code>
                        )}
                        {cap.gate && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                            {GATE_NOTE[cap.gate] ?? cap.gate}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-gray-600">{cap.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-gray-200 bg-gray-50 px-5 py-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-3">
                  Cannot
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {r.cannot.map((line) => (
                    <li key={line} className="text-sm text-gray-600">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </div>

        <p className="mt-8 text-xs text-gray-400">
          This page describes the perimeter and the route gates. Every claim on it is checked
          against the real routes by a test, so it fails the build rather than going quietly out of
          date. It is not a statement about row-level access inside the database.
        </p>
      </main>
    </OperatorShell>
  );
}
