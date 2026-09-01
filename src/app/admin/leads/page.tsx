import { redirect } from 'next/navigation';

import { getSessionRole } from '@/lib/auth/sessionRole';

import LeadsAdminClient from './LeadsAdminClient';

// Thin server wrapper: reads the server-only HIGHLEVEL_LOCATION_ID env var
// (no NEXT_PUBLIC_ prefix — a 'use client' file can't read it directly) so the
// client component can build each row's "View in HighLevel" link. All the
// actual page logic lives in LeadsAdminClient.tsx.
export default async function LeadsAdminPage() {
  // Admin only, matching every sibling admin page (/admin/crew-links,
  // /admin/fleet/clocks, /admin/advertising/*). This page was the ONE that had
  // no server-side gate: /api/admin/leads is requireAdmin, so an operator
  // navigating here saw the shell and then a red error, and the permissions
  // page claimed they could not see it at all. Found by the premerge admin
  // lens, 2026-09-01. No PII was exposed; the claim was still false, and the
  // honest fix is to make the page match its own API rather than to soften
  // the sentence.
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  const hlLocationId = process.env.HIGHLEVEL_LOCATION_ID ?? null;
  return <LeadsAdminClient hlLocationId={hlLocationId} />;
}
