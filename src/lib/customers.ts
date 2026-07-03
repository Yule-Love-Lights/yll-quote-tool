import { getSupabaseClient, getSupabaseServiceClient } from './supabase';

// Stable Customer + Property identity (ledger #83, Phase 5).
//
// Today a "customer" is computed on the fly per request (the dashboard folds the
// quotes table by HL contact → email → phone → name; src/lib/dashboard/metrics.ts
// customerKey). This module promotes that to a PERSISTENT `customers` row with
// one-or-more `properties`, so quotes/jobs/invoices can reference a stable id and
// "rebook last season" (src/lib/rebook.ts) has something durable to clone from.
//
// Schema: migrations/2026-06-27-customers-properties.sql. Service-role only (the
// tables have RLS disabled, like quotes/designs).
//
// Pure helpers (customerMatchKey/normalizePhone/normalizeAddress) carry the dedup
// rules and are unit-tested without a DB. The DB helpers are thin find-or-create
// wrappers, race-safe via the UNIQUE(match_key) / UNIQUE(customer_id,address_key)
// indexes (select-then-insert, re-select on a unique-violation race).

export type CustomerIdentity = {
  hl_contact_id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type CustomerRow = {
  id: string;
  match_key: string | null;
  hl_contact_id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
};

export type PropertyRow = {
  id: string;
  customer_id: string;
  address: string | null;
  address_key: string;
  lat: number | null;
  lng: number | null;
  created_at: string;
  updated_at: string;
};

// The identity-bearing columns of a quote row (the backfill + attach inputs).
export type QuoteIdentityRow = {
  id: string;
  highlevel_contact_id?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
};

function norm(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length ? t : null;
}

// ─── Pure dedup rules ───────────────────────────────────────────────────────

// Stable dedup key with the SAME precedence as the dashboard's customerKey
// (HL contact id → email → phone → name), but normalized (lowercased email/name,
// digits-only phone) so trivial formatting differences collapse to one customer.
// Returns null when a quote carries NO identity at all — those are deliberately
// NOT promoted to a customer row (each would be a junk singleton).
export function customerMatchKey(c: CustomerIdentity): string | null {
  const hl = norm(c.hl_contact_id);
  if (hl) return `hl:${hl}`;
  const email = norm(c.email);
  if (email) return `email:${email.toLowerCase()}`;
  const phone = normalizePhone(c.phone);
  if (phone) return `phone:${phone}`;
  const name = norm(c.name);
  if (name) return `name:${name.toLowerCase()}`;
  return null;
}

// Phone → digits only (drops formatting: spaces, dashes, parens, +). Null when
// there are no digits.
export function normalizePhone(v: string | null | undefined): string | null {
  const t = norm(v);
  if (!t) return null;
  const digits = t.replace(/\D/g, '');
  return digits.length ? digits : null;
}

// Address → dedup key: lowercased, punctuation (.,#) to spaces, whitespace
// collapsed. "123 Main St." and "123  main st" map to the same property. Empty
// string for a blank address (a customer's single "(no address)" property).
export function normalizeAddress(v: string | null | undefined): string {
  const t = norm(v);
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

function svc() {
  // Service-role first (RLS disabled); fall back to the anon client in case the
  // service key isn't configured locally.
  return getSupabaseServiceClient() ?? getSupabaseClient();
}

// Find-or-create the stable customer for an identity. Idempotent + race-safe via
// UNIQUE(match_key). Returns null when the identity has no stable key, or on a
// hard DB error.
export async function findOrCreateCustomer(
  identity: CustomerIdentity,
): Promise<{ id: string } | null> {
  const key = customerMatchKey(identity);
  if (!key) return null;
  const sb = svc();
  if (!sb) return null;

  const existing = await sb.from('customers').select('id').eq('match_key', key).maybeSingle();
  if (existing.data) return { id: existing.data.id as string };

  const ins = await sb
    .from('customers')
    .insert({
      match_key: key,
      hl_contact_id: norm(identity.hl_contact_id),
      name: norm(identity.name),
      email: norm(identity.email),
      phone: norm(identity.phone),
    })
    .select('id')
    .single();
  if (!ins.error && ins.data) return { id: ins.data.id as string };

  // Lost the insert race (another writer created the same match_key) → re-select.
  const retry = await sb.from('customers').select('id').eq('match_key', key).maybeSingle();
  if (retry.data) return { id: retry.data.id as string };
  console.error('findOrCreateCustomer error:', ins.error);
  return null;
}

// Find-or-create one property for a customer, keyed on the normalized address.
// Idempotent + race-safe via UNIQUE(customer_id, address_key).
export async function findOrCreateProperty(
  customerId: string,
  address: string | null | undefined,
  geo?: { lat?: number | null; lng?: number | null },
): Promise<{ id: string } | null> {
  const sb = svc();
  if (!sb) return null;
  const address_key = normalizeAddress(address);

  const existing = await sb
    .from('properties')
    .select('id')
    .eq('customer_id', customerId)
    .eq('address_key', address_key)
    .maybeSingle();
  if (existing.data) return { id: existing.data.id as string };

  const ins = await sb
    .from('properties')
    .insert({
      customer_id: customerId,
      address: norm(address),
      address_key,
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
    })
    .select('id')
    .single();
  if (!ins.error && ins.data) return { id: ins.data.id as string };

  const retry = await sb
    .from('properties')
    .select('id')
    .eq('customer_id', customerId)
    .eq('address_key', address_key)
    .maybeSingle();
  if (retry.data) return { id: retry.data.id as string };
  console.error('findOrCreateProperty error:', ins.error);
  return null;
}

// Link ONE quote to a stable customer + property (find-or-create both, then set
// quotes.customer_id/property_id). Idempotent: re-running resolves to the same
// customer/property. Returns null when the quote has no identity (left unlinked).
//
// W2-027: the three writes (customer, property, quote-link) are non-atomic —
// true atomicity needs a DB function, out of scope here. The load-bearing
// write (the quote-link update, the one that makes the customer/property
// actually reachable) is already LAST, so a failure can only ever leave an
// orphaned customer+property (safe: re-running this function finds them via
// find-or-create and retries the link) rather than a quote pointing at
// nothing. The one gap was silent diagnostics on that partial-failure case —
// logged below so it's visible in ops, not just "returns null".
export async function attachQuoteToCustomer(
  q: QuoteIdentityRow,
): Promise<{ customerId: string; propertyId: string } | null> {
  const customer = await findOrCreateCustomer({
    hl_contact_id: q.highlevel_contact_id,
    name: q.customer_name,
    email: q.customer_email,
    phone: q.customer_phone,
  });
  if (!customer) return null;

  const property = await findOrCreateProperty(customer.id, q.customer_address);
  if (!property) return null;

  const sb = svc();
  if (!sb) return null;
  const { error } = await sb
    .from('quotes')
    .update({ customer_id: customer.id, property_id: property.id })
    .eq('id', q.id);
  if (error) {
    console.error(
      `attachQuoteToCustomer link error (quote ${q.id} — customer ${customer.id} + property ${property.id} now orphaned, no quote points at them; safe to retry):`,
      error,
    );
    return null;
  }
  return { customerId: customer.id, propertyId: property.id };
}

// One-shot, idempotent promotion of every identity-bearing, not-yet-linked quote
// into the customers/properties tables. Safe to re-run (scans only quotes WHERE
// customer_id IS NULL; find-or-create dedups). Returns a summary.
//
// Test quotes (is_test=true, ledger #93) are EXCLUDED: this is the only path
// that writes persisted customers/properties rows, and those tables aren't FK-
// cascaded from quotes — so promoting a test quote would both leak it into the
// customer list and leave an orphan that "Delete test data" can't reach.
export async function backfillCustomersFromQuotes(
  limit = 5000,
): Promise<{ scanned: number; linked: number; skipped: number }> {
  const sb = svc();
  if (!sb) return { scanned: 0, linked: 0, skipped: 0 };

  const { data, error } = await sb
    .from('quotes')
    .select('id, highlevel_contact_id, customer_name, customer_email, customer_phone, customer_address')
    .is('customer_id', null)
    // is_test IS NOT TRUE → real quotes only (false + any legacy NULL during a
    // migration window); excludes test quotes. Null-safe on purpose.
    .not('is_test', 'is', true)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) {
    console.error('backfillCustomersFromQuotes read error:', error);
    return { scanned: 0, linked: 0, skipped: 0 };
  }

  const rows = (data ?? []) as QuoteIdentityRow[];
  // W2-011: quotes are mutually independent (each links its own customer/
  // property), so nothing forces strictly-serial processing. Process in
  // bounded-concurrency chunks instead of one-at-a-time — the find-or-create
  // UNIQUE-index race-recovery (customers.ts findOrCreateCustomer/
  // findOrCreateProperty) already makes concurrent same-key creates safe, so
  // overlapping quotes for the same customer within a chunk still dedup
  // correctly. Keeps a large first-run backfill well under a function timeout
  // without the unbounded fan-out of a single Promise.all(rows.map(...)).
  const CHUNK_SIZE = 8;
  let linked = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(chunk.map((q) => attachQuoteToCustomer(q)));
    for (const res of results) {
      if (res) linked++;
      else skipped++;
    }
  }
  return { scanned: rows.length, linked, skipped };
}

// ─── Reads (for the future customer/property UI + rebook) ───────────────────

export async function getCustomer(id: string): Promise<CustomerRow | null> {
  const sb = svc();
  if (!sb) return null;
  const { data, error } = await sb.from('customers').select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error('getCustomer error:', error);
    return null;
  }
  return (data as CustomerRow | null) ?? null;
}

export async function listCustomers(limit = 500): Promise<CustomerRow[]> {
  const sb = svc();
  if (!sb) return [];
  const { data, error } = await sb
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listCustomers error:', error);
    return [];
  }
  return (data ?? []) as CustomerRow[];
}

export async function getPropertiesForCustomer(customerId: string): Promise<PropertyRow[]> {
  const sb = svc();
  if (!sb) return [];
  const { data, error } = await sb
    .from('properties')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('getPropertiesForCustomer error:', error);
    return [];
  }
  return (data ?? []) as PropertyRow[];
}
