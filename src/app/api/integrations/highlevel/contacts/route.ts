// Search HighLevel contacts by name / email / phone. Powers the
// "attach this quote to an existing contact" autocomplete on the new-quote
// admin page.
//
// GET /api/integrations/highlevel/contacts?q=<query>&limit=<n>
//
// Response:
//   { contacts: CrmContact[] }   — on success
//   { error: string }            — on config / network failure (HTTP 500/503)
//
// We strip the `raw` field before responding — it contains internal GHL
// metadata (custom field IDs, internal tags, etc.) we don't want leaking
// to the browser.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { searchContacts, isHighLevelConfigured, HighLevelError } from '@/lib/integrations/highlevel';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isHighLevelConfigured()) {
    return NextResponse.json(
      { error: 'HighLevel not configured. Set HIGHLEVEL_API_KEY and HIGHLEVEL_LOCATION_ID in .env.local' },
      { status: 503 },
    );
  }

  // Light rate limit — autocomplete can fire on every keystroke, but GHL's
  // API is rate-limited on their side and we don't want to burn quota.
  const rl = rateLimitResponse(req, { bucket: 'ghl-contacts', limit: 30, windowMs: 60_000 });
  if (rl) return rl;

  const url = new URL(req.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 50);

  if (query.length < 2) {
    return NextResponse.json({ contacts: [] });
  }

  try {
    const contacts = await searchContacts(query, limit);
    // Strip raw before responding — see module header note.
    const sanitized = contacts.map(c => ({ ...c, raw: undefined }));
    return NextResponse.json({ contacts: sanitized });
  } catch (err) {
    console.error('[api/integrations/highlevel/contacts] search failed:', err);
    if (err instanceof HighLevelError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
