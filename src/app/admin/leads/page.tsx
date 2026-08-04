import LeadsAdminClient from './LeadsAdminClient';

// Thin server wrapper: reads the server-only HIGHLEVEL_LOCATION_ID env var
// (no NEXT_PUBLIC_ prefix — a 'use client' file can't read it directly) so the
// client component can build each row's "View in HighLevel" link. All the
// actual page logic lives in LeadsAdminClient.tsx.
export default async function LeadsAdminPage() {
  const hlLocationId = process.env.HIGHLEVEL_LOCATION_ID ?? null;
  return <LeadsAdminClient hlLocationId={hlLocationId} />;
}
