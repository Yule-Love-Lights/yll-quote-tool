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
  /** Customer tenure (#178) staff-editable override years — see
   *  migrations/2026-07-28-customers-manual-years.sql. `unknown` because a raw
   *  jsonb column could hold old/hand-edited junk; validate before use
   *  (src/lib/customerTenure.ts's deriveTenureYears does this). */
  manual_years?: unknown;
  /** NCE + YLL Neighbor tags (#198) — see migrations/2026-08-05-nce-customer-
   *  tags.sql. Set directly by staff (customer profile add/remove chips) or
   *  forward-only-propagated from a tagged quote (never cleared by
   *  propagation — only a staff remove clears these). */
  is_nce: boolean;
  is_yll_neighbor: boolean;
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

// W2-009: every match key this identity COULD resolve under, in the SAME
// precedence order as customerMatchKey, but WITHOUT short-circuiting after
// the first hit. A quote's identity often carries more than one field (e.g.
// an HL-linked quote still has the customer's email) — customerMatchKey only
// returns the winning (highest-precedence) key, so a same-person history that
// mixes an HL-linked quote with an email/phone-only quote hashes to TWO
// different keys and used to create TWO customer rows (the #306 backfill's
// exact input). findOrCreateCustomer uses this to also check for an existing
// customer under any of this identity's OTHER keys before creating a new row.
export function secondaryMatchKeys(c: CustomerIdentity): string[] {
  const keys: string[] = [];
  const email = norm(c.email);
  if (email) keys.push(`email:${email.toLowerCase()}`);
  const phone = normalizePhone(c.phone);
  if (phone) keys.push(`phone:${phone}`);
  const name = norm(c.name);
  if (name) keys.push(`name:${name.toLowerCase()}`);
  return keys;
}

// Precedence rank of a match_key's PREFIX (lower = higher precedence), same
// order as customerMatchKey (hl > email > phone > name). Used by the W2-009
// merge to decide whether an incoming identity's key should REPLACE an
// existing customer's stored match_key (only when it out-ranks it) — an
// existing higher-precedence key is never downgraded.
function keyPrecedenceRank(matchKey: string | null | undefined): number {
  if (!matchKey) return 99;
  const prefix = matchKey.slice(0, matchKey.indexOf(':'));
  const order = ['hl', 'email', 'phone', 'name'];
  const i = order.indexOf(prefix);
  return i === -1 ? 99 : i;
}

// A value is safe to interpolate into a PostgREST .or() filter string only if
// it can't contain a comma/paren/dot that would inject extra filter clauses.
// Mirrors the guard in lib/dashboard/inbox/store.ts (same PostgREST .or()
// injection concern). hl_contact_id is alphanumeric-ish; email/phone/name are
// free text, so those go through a dedicated allowlist instead of this one.
const SAFE_OR_VALUE_RE = /^[A-Za-z0-9_@.+-]+$/;
function safeOrValue(v: string): boolean {
  return SAFE_OR_VALUE_RE.test(v) && !v.includes(',') && !v.includes('(') && !v.includes(')');
}

// Phone → the NATIONAL number (drops formatting AND the NANP country code).
// Null when there are no digits.
//
// GHL stores US numbers in E.164 ('+16315550100', 11 digits) while every form
// stores 10; a plain digit-strip kept the leading 1, so the same person hashed
// to two different match_keys (phone:16315550100 vs phone:6315550100) and got
// TWO customer rows, losing rebook/property history (the same bug class fixed in
// leadService's household guard, S42). Strip ONLY the 11-digit leading-1 NANP
// code — a blind last-10 slice would merge unrelated international numbers onto
// a US one. Anything else is left intact so it simply fails to match.
export function normalizePhone(v: string | null | undefined): string | null {
  const t = norm(v);
  if (!t) return null;
  const digits = t.replace(/\D/g, '');
  if (!digits.length) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
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

// #213 (S34 #198 review, customer lens): name normalization for the identity-
// agreement compare below — trim, lowercase, collapse internal whitespace.
// Deliberately a SEPARATE helper from customerMatchKey/secondaryMatchKeys'
// own name-key derivation (unchanged — the dashboard's customerKey and every
// existing match_key also depend on those), so this stricter compare can't
// shift any other dedup behavior.
function normNameForCompare(v: string | null | undefined): string | null {
  const t = norm(v);
  if (!t) return null;
  return t.toLowerCase().replace(/\s+/g, ' ');
}

// #213: does `identity` agree with `row` on the HighLevel contact id? An HL
// id is CRM-issued and unique — unlike email/phone/name, which are self-
// reported and, per #198's review, shareable within a household — so
// agreement here is ALWAYS enough on its own to adopt (design point 1:
// unchanged from pre-#213 behavior). Both sides must be non-null and equal;
// a row that merely HAS an hl id while `identity` names a different one (or
// none at all) does not count.
function hlAgrees(identity: CustomerIdentity, row: Pick<CustomerRow, 'hl_contact_id'>): boolean {
  const a = norm(identity.hl_contact_id);
  const b = norm(row.hl_contact_id);
  return !!a && !!b && a === b;
}

// #213: which of {email, phone, name} agree — present AND equal after
// normalizing — between `identity` and an existing `row`. A field missing on
// EITHER side never counts as agreement (it's simply unknown, not a match),
// so a row that's only ever had an email can't "agree" on a phone identity
// merely adds, and two people who share only a phone (different names) never
// reach 2. The field that led to `row` being found as a candidate at all is
// always included here (by construction — see findOrCreateCustomer), so this
// is never empty when called on an actual candidate.
function agreeingFields(
  identity: CustomerIdentity,
  row: Pick<CustomerRow, 'email' | 'phone' | 'name'>,
): string[] {
  const fields: string[] = [];
  const email = norm(identity.email)?.toLowerCase() ?? null;
  const rowEmail = norm(row.email)?.toLowerCase() ?? null;
  if (email && rowEmail && email === rowEmail) fields.push('email');
  const phone = normalizePhone(identity.phone);
  const rowPhone = normalizePhone(row.phone);
  if (phone && rowPhone && phone === rowPhone) fields.push('phone');
  const name = normNameForCompare(identity.name);
  const rowName = normNameForCompare(row.name);
  if (name && rowName && name === rowName) fields.push('name');
  return fields;
}

// #213: a deterministic, collision-avoiding match_key for a row created
// because a candidate WAS found but REJECTED (single-field, non-hl — see
// findOrCreateCustomer, WT-55). Plain `customerMatchKey(identity)` would
// collide with the rejected candidate's OWN match_key whenever the rejection
// came from the exact-match phase — that row already legitimately owns that
// key, so reusing it isn't a race, it's a certainty (customers.match_key is
// UNIQUE). secondaryMatchKeys already lists every one of this identity's own
// populated non-hl field-keys (email, phone, name) in a fixed order, so
// joining them is specific enough that only an IDENTICAL repeat of this exact
// identity reproduces the same string — a genuine repeat still resolves back
// to the row created here via the standard insert/unique-violation-reselect
// recovery below, while two different people who merely share one field keep
// landing on separate rows. (Never hl-based: a rejection only ever happens
// for a non-hl match — see findOrCreateCustomer.)
function disambiguatedMatchKey(identity: CustomerIdentity): string {
  return `dup:${secondaryMatchKeys(identity).join('|')}`;
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
//
// W2-009: match_key precedence alone (hl > email > phone > name) splits ONE
// real customer into TWO rows when their quote history mixes an HL-linked
// quote with an email/phone-only quote — each hashes to a DIFFERENT key.
// Before creating a brand-new row, also check the identity's SECONDARY keys
// (secondaryMatchKeys) for an existing customer to merge into. On a
// secondary-key hit we PREFER LINKING to that existing customer over creating
// a second one (the safest de-dup: never lose history to a fresh row) and, if
// our key out-ranks the existing row's stored key (e.g. we now know the HL id
// a previously email-only row didn't), upgrade match_key + backfill the newly
// -known fields so a future lookup on EITHER identity resolves here. An
// existing higher-or-equal-precedence key is never downgraded.
//
// #213 (S34 #198 review, customer lens): a candidate found ONLY via a single
// agreeing field (email OR phone OR name alone, no hl) is NEVER adopted —
// a shared household email/phone would otherwise silently attach this
// quote's identity (and, via #199, its NCE money terms) to the WRONG
// customer. An hl_contact_id agreement stays authoritative and unconditional
// (it's a CRM-issued unique id, not self-reported); anything else needs >=2
// of {email, phone, name} to agree before adopting — see agreeingFields/
// hlAgrees above. A single-field "hit" instead creates a NEW row (under a
// disambiguatedMatchKey so it can't collide with the row it declined to
// adopt) and logs a candidate-merge pair for staff to reconcile by hand —
// see WT-55 (a future customer-merge UI; no such UI exists yet, so this is
// currently a loud log line, not a queue).
export async function findOrCreateCustomer(
  identity: CustomerIdentity,
): Promise<{ id: string } | null> {
  const key = customerMatchKey(identity);
  if (!key) return null;
  const sb = svc();
  if (!sb) return null;

  // #213: a candidate that was found but did NOT clear the adopt bar (single
  // field, non-hl) is remembered here so the create path below can (a) avoid
  // colliding with its match_key and (b) log the candidate-merge pair once
  // the new row exists. Overwritten (not accumulated) if a LATER search phase
  // also finds-and-rejects a (possibly different) candidate — the last one
  // classified is what gets logged; see the phase-2 comment below for why
  // phase 2 always still runs even after a phase-1 rejection.
  let rejected: { id: string; field: string } | undefined;

  const existing = await sb
    .from('customers')
    .select('id, name, email, phone, hl_contact_id')
    .eq('match_key', key)
    .maybeSingle<Pick<CustomerRow, 'id' | 'name' | 'email' | 'phone' | 'hl_contact_id'>>();
  if (existing.data) {
    const row = existing.data;
    // #213: an exact match_key hit is only safe to adopt unconditionally when
    // it's hl-based (design point 1). When identity has no hl id, `key` is
    // email/phone/name-derived and this equality is itself only ONE agreeing
    // field — exactly the household-share risk #198's review flagged. Require
    // the same >=2-field corroboration as the secondary path below.
    if (hlAgrees(identity, row) || agreeingFields(identity, row).length >= 2) {
      // W2-026 (Jason 2026-07-06: NEWEST-WIN) — a repeat quote for an existing
      // customer refreshes the stored contact fields to this newer quote's values
      // (when present), so name/email/phone don't go stale. match_key is unchanged
      // on this exact-match path, so only the display/contact columns move. Only
      // write when something actually changed (no needless write per quote).
      const next = {
        name: norm(identity.name) ?? row.name,
        email: norm(identity.email) ?? row.email,
        phone: norm(identity.phone) ?? row.phone,
        hl_contact_id: norm(identity.hl_contact_id) ?? row.hl_contact_id,
      };
      if (
        next.name !== row.name ||
        next.email !== row.email ||
        next.phone !== row.phone ||
        next.hl_contact_id !== row.hl_contact_id
      ) {
        const { error: updErr } = await sb.from('customers').update(next).eq('id', row.id);
        if (updErr) console.error('findOrCreateCustomer newest-win update error:', updErr);
      }
      return { id: row.id as string };
    }
    const fields = agreeingFields(identity, row);
    rejected = { id: row.id, field: fields[0] ?? key.slice(0, key.indexOf(':')) };
  }

  // W2-009 secondary-identity search, BOTH directions:
  //  (a) an existing row's match_key equals one of THIS identity's lower-
  //      precedence keys (e.g. we're hl-linked now, an email-only row exists), or
  //  (b) an existing row's raw hl_contact_id/email/phone column equals one of
  //      THIS identity's populated fields, however that row itself was keyed
  //      (e.g. an hl-linked row already exists and we're an email-only quote
  //      for the same person).
  // Only alphanumeric-ish/email/phone-shaped values are interpolated into the
  // .or() filter (safeOrValue) — same PostgREST-injection guard used by
  // lib/dashboard/inbox/store.ts's findCandidates.
  //
  // customers-or-sanitize: secondaryKeys are the free-text name/email/phone
  // match keys (e.g. `name:${name}`), NOT column values — a name containing a
  // comma or paren would corrupt a hand-built `match_key.in.(...)` string. Use
  // the client's parameterized .in() for those instead (a separate query, run
  // FIRST — a name-only identity's ONLY merge route, since there's no safe
  // raw hl/email/phone column value to fall back on for it).
  //
  // #213: this phase ALWAYS runs now, even after a phase-1 rejection above —
  // not just when phase 1 found nothing. A phase-1 exact-key candidate that
  // fails corroboration on ITS key field doesn't mean no >=2-field candidate
  // exists under a DIFFERENT key (e.g. identity is now email+phone+name; an
  // email-only row shares only email, but a SEPARATE phone-keyed row for the
  // same real person shares phone+name) — worth the extra query to not miss
  // a legitimate merge.
  const secondaryKeys = secondaryMatchKeys(identity).filter((k) => k !== key);
  const orConds: string[] = [];
  const hl = norm(identity.hl_contact_id);
  if (hl && safeOrValue(hl)) orConds.push(`hl_contact_id.eq.${hl}`);
  const email = norm(identity.email);
  if (email && safeOrValue(email)) orConds.push(`email.eq.${email}`);
  const phoneRaw = norm(identity.phone);
  if (phoneRaw && safeOrValue(phoneRaw)) orConds.push(`phone.eq.${phoneRaw}`);

  let merge: CustomerRow | undefined;
  if (secondaryKeys.length) {
    const { data: byKey } = await sb
      .from('customers')
      .select('*')
      .in('match_key', secondaryKeys);
    merge = (byKey as CustomerRow[] | null)?.[0];
  }
  if (!merge && orConds.length) {
    const { data: candidates } = await sb.from('customers').select('*').or(orConds.join(','));
    merge = (candidates as CustomerRow[] | null)?.[0];
  }
  if (merge) {
    // #213: same >=2-field-or-hl gate as the exact-match phase above.
    if (hlAgrees(identity, merge) || agreeingFields(identity, merge).length >= 2) {
      // Never DOWNGRADE an existing higher-(or-equal-)precedence match_key —
      // only adopt `key` on the merged row when it out-ranks what's stored.
      const mergeKeyRank = keyPrecedenceRank(merge.match_key);
      const ourKeyRank = keyPrecedenceRank(key);
      const nextMatchKey = ourKeyRank < mergeKeyRank ? key : merge.match_key;
      const { error: updErr } = await sb
        .from('customers')
        .update({
          match_key: nextMatchKey,
          hl_contact_id: norm(identity.hl_contact_id) ?? merge.hl_contact_id,
          name: norm(identity.name) ?? merge.name,
          email: norm(identity.email) ?? merge.email,
          phone: norm(identity.phone) ?? merge.phone,
        })
        .eq('id', merge.id);
      if (updErr) console.error('findOrCreateCustomer merge-upgrade error:', updErr);
      return { id: merge.id };
    }
    const fields = agreeingFields(identity, merge);
    rejected = { id: merge.id, field: fields[0] ?? 'unknown' };
  }

  // #213: no candidate cleared the adopt bar. When one WAS found and
  // rejected, plain `key` may already be taken by it — a certainty (not a
  // race) for the phase-1 exact-match case, since that's literally how it was
  // found — so use a disambiguated key instead, keeping this insert targeted
  // at a genuinely new row rather than colliding with (and, via the existing
  // unique-violation retry below, silently re-adopting) the very row just
  // declined. The candidate-merge pair is logged below once the new row's id
  // is known.
  const insertKey = rejected ? disambiguatedMatchKey(identity) : key;

  const ins = await sb
    .from('customers')
    .insert({
      match_key: insertKey,
      hl_contact_id: norm(identity.hl_contact_id),
      name: norm(identity.name),
      email: norm(identity.email),
      phone: norm(identity.phone),
    })
    .select('id')
    .single();

  let newId: string | null = null;
  if (!ins.error && ins.data) {
    newId = ins.data.id as string;
  } else {
    // Lost the insert race (another writer created the same match_key — a
    // genuine concurrent race for a first-time `key`, or, for a rejected
    // candidate's disambiguated key, a repeat of this same identity that also
    // took this branch) → re-select.
    const retry = await sb.from('customers').select('id').eq('match_key', insertKey).maybeSingle();
    if (retry.data) newId = retry.data.id as string;
  }

  if (!newId) {
    console.error('findOrCreateCustomer error:', ins.error);
    return null;
  }
  if (rejected) {
    console.warn(
      `findOrCreateCustomer: candidate merge NOT applied (single-field match on ${rejected.field}) — ` +
        `existing customer ${rejected.id} vs new customer ${newId}. Review for a manual merge (WT-55).`,
    );
  }
  return { id: newId };
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
    .select('id, address, lat, lng')
    .eq('customer_id', customerId)
    .eq('address_key', address_key)
    .maybeSingle<Pick<PropertyRow, 'id' | 'address' | 'lat' | 'lng'>>();
  if (existing.data) {
    // W2-026 (newest-win) — same normalized address_key, so refresh the display
    // address + geo to this quote's newer values when present (formatting/geo can
    // drift between quotes for the same place). Only write on a real change.
    const row = existing.data;
    const nextAddress = norm(address) ?? row.address;
    const nextLat = geo?.lat ?? row.lat;
    const nextLng = geo?.lng ?? row.lng;
    if (nextAddress !== row.address || nextLat !== row.lat || nextLng !== row.lng) {
      const { error: updErr } = await sb
        .from('properties')
        .update({ address: nextAddress, lat: nextLat, lng: nextLng })
        .eq('id', row.id);
      if (updErr) console.error('findOrCreateProperty newest-win update error:', updErr);
    }
    return { id: row.id as string };
  }

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

  // Forward-heal (S34, #198 follow-up — live finding: 166/168 customers rows
  // had hl_contact_id NULL). findOrCreateCustomer's own merge/insert
  // branches already stamp hl_contact_id whenever THEY run with an
  // hl-carrying identity, but a quote's customer_id, once resolved, is never
  // re-run through findOrCreateCustomer just because the quote LATER gains
  // an hl_contact_id via a different path (the builder's HL-contact-pick
  // autocomplete only writes quotes.highlevel_contact_id via
  // /api/integrations/highlevel/attach — it never touches customers at
  // all). Every attachQuoteToCustomer call (initial save, the one-shot
  // backfill, the #198 send-time re-attach) is a fresh chance to close that
  // gap. Race-safe, one round trip: .is('hl_contact_id', null) means this
  // can only ever affect a row that's STILL unlinked at write time — a row
  // already linked to a DIFFERENT id is never touched (0 rows match, a
  // silent no-op). Never overwrites — that's the secondary-key merge's job
  // inside findOrCreateCustomer (#213's territory, untouched here).
  // Best-effort: never blocks the quote-link write below.
  const hlContactId = norm(q.highlevel_contact_id);
  if (hlContactId) {
    try {
      const { error: healErr } = await sb
        .from('customers')
        .update({ hl_contact_id: hlContactId })
        .eq('id', customer.id)
        .is('hl_contact_id', null);
      if (healErr) {
        console.warn(`attachQuoteToCustomer: hl_contact_id heal failed for customer ${customer.id}:`, healErr);
      }
    } catch (err) {
      console.warn(`attachQuoteToCustomer: hl_contact_id heal threw for customer ${customer.id}:`, err);
    }
  }

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

// Read-only lookup by HighLevel contact id — unlike findOrCreateCustomer this
// NEVER creates a row (used to resolve a picked/prefilled HL contact's
// existing tags for inheritance, #198; merely viewing/picking a contact must
// not conjure a customer row that attachQuoteToCustomer hasn't earned yet).
export async function getCustomerByHlContactId(hlContactId: string): Promise<CustomerRow | null> {
  const trimmed = norm(hlContactId);
  if (!trimmed) return null;
  const sb = svc();
  if (!sb) return null;
  const { data, error } = await sb
    .from('customers')
    .select('*')
    .eq('hl_contact_id', trimmed)
    .maybeSingle();
  if (error) {
    console.error('getCustomerByHlContactId error:', error);
    return null;
  }
  return (data as CustomerRow | null) ?? null;
}

// Bulk tag lookup for the customers LIST page (#198) — one query for every
// customer row shown, keyed by id, so the page doesn't N+1. Ids with no
// matching row (or that don't resolve, e.g. a walk-in with no customer_id)
// are simply absent from the returned map.
export async function listCustomerTagsByIds(
  ids: string[],
): Promise<Map<string, { isNce: boolean; isYllNeighbor: boolean }>> {
  const uniqueIds = Array.from(new Set(ids.filter((id) => id)));
  const map = new Map<string, { isNce: boolean; isYllNeighbor: boolean }>();
  if (!uniqueIds.length) return map;
  const sb = svc();
  if (!sb) return map;
  const { data, error } = await sb
    .from('customers')
    .select('id, is_nce, is_yll_neighbor')
    .in('id', uniqueIds);
  if (error) {
    console.error('listCustomerTagsByIds error:', error);
    return map;
  }
  for (const row of (data ?? []) as Array<{ id: string; is_nce: boolean; is_yll_neighbor: boolean }>) {
    map.set(row.id, { isNce: row.is_nce, isYllNeighbor: row.is_yll_neighbor });
  }
  return map;
}

// Forward-only tag propagation (#198): a tagged quote auto-tags its linked
// customer. Only ever WRITES true — a false/absent flag here is simply
// omitted from the update, so this can never clear a tag another quote (or a
// staff edit) already set. Best-effort: swallows its own DB error (logs and
// returns) so a propagation failure can never fail the caller's real action
// (a send, a toggle, a save) — every call site can fire this without its own
// try/catch, though several wrap it anyway for defense in depth, matching
// this file's attachQuoteToCustomer convention.
//
// REASSERTION (review fix, staff/admin MED, S34 #198 review): because this
// only ever writes true, a staff CLEAR on the customer profile
// (setCustomerTags, which CAN set false) is NOT durable against a linked
// quote that's still tagged — the next event that re-fires propagation for
// that SAME quote (a resend, a retry-eligible toggle, another Calculate that
// re-touches the chip) will flip the customer tag back to true. There is no
// tracking of "staff deliberately cleared this" here — a customer-level
// clear is only fully durable once every linked tagged quote is ALSO
// untagged. Both quote-level toggles' OFF confirm copy and
// CustomerTagsEditor's clear control disclose this; no state machine added.
export async function propagateQuoteTagsToCustomer(
  customerId: string,
  tags: { isNce?: boolean; isYllNeighbor?: boolean },
): Promise<void> {
  const patch: Record<string, true> = {};
  if (tags.isNce) patch.is_nce = true;
  if (tags.isYllNeighbor) patch.is_yll_neighbor = true;
  if (Object.keys(patch).length === 0) return;
  const sb = svc();
  if (!sb) return;
  const { error } = await sb.from('customers').update(patch).eq('id', customerId);
  if (error) {
    console.error(`propagateQuoteTagsToCustomer: update failed for customer ${customerId}:`, error);
  }
}

// Staff add/remove update (#198) — the direct write behind POST
// /api/customers/[customerId]/tags. Unlike propagateQuoteTagsToCustomer above
// (forward-only, fire-and-forget), this is a real partial update that CAN
// clear a tag, and the caller (the route) needs to distinguish a DB error
// (500) from an unknown customer id (404) — so this returns the raw
// {data, error} pair rather than collapsing both into null the way
// getCustomer does; a pure extract of the route's own Supabase call shape,
// no behavior change for its one caller.
export async function setCustomerTags(
  customerId: string,
  tags: { isNce?: boolean; isYllNeighbor?: boolean },
): Promise<{
  data: { id: string; is_nce: boolean; is_yll_neighbor: boolean } | null;
  error: { message: string } | null;
}> {
  const patch: Record<string, boolean> = {};
  if (tags.isNce !== undefined) patch.is_nce = tags.isNce;
  if (tags.isYllNeighbor !== undefined) patch.is_yll_neighbor = tags.isYllNeighbor;
  const sb = svc();
  if (!sb) return { data: null, error: { message: 'Supabase not configured' } };
  const { data, error } = await sb
    .from('customers')
    .update(patch)
    .eq('id', customerId)
    .select('id, is_nce, is_yll_neighbor')
    .maybeSingle<{ id: string; is_nce: boolean; is_yll_neighbor: boolean }>();
  return { data, error };
}
