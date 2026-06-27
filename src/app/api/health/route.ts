import { NextResponse } from 'next/server';
import { isSupabaseConfigured, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { isClaudeConfigured } from '@/lib/claude';
import { isGoogleMapsConfigured } from '@/lib/googleMaps';

export const runtime = 'nodejs';
// Always evaluate env at request time — config can differ between deploys and
// an uptime monitor must see the live state, not a build-time snapshot.
export const dynamic = 'force-dynamic';

// Lightweight health/readiness probe for an uptime monitor (#41/#78/#100 audit
// fix). Returns ONLY boolean "is X configured" flags — never the secret values
// themselves — so it's safe to expose publicly. It reports presence of config,
// not live upstream reachability (a deeper liveness check would burn API quota
// on every poll); see decisionsForReviewer for the scope choice.
export async function GET() {
  const services = {
    supabase: isSupabaseConfigured(),
    supabaseService: isSupabaseServiceConfigured(),
    highLevel: isHighLevelConfigured(),
    claude: isClaudeConfigured(),
    googleMaps: isGoogleMapsConfigured(),
  };

  // "ok" = the core data layer (Supabase) is wired up. Integrations being
  // unconfigured is informational, not a hard failure for the probe.
  const ok = services.supabase;

  return NextResponse.json(
    { ok, services, timestamp: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
