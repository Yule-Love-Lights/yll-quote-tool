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

// #214: build an attach identity from STORED quote-row columns, translating
// the row's display sentinels back to null. saveQuote persists a blank name
// as 'Anonymous' and a blank address as '(no address)' (quotes.ts
// blankToNull ?? sentinel) — display conveniences that must never become
// identity evidence. Without this, a stored-row re-attach (send/mark-sent's
// lazy attach, and every #214 verify-or-reattach site) would derive
// match_key `name:anonymous` for a contactless quote — folding EVERY such
// quote onto one shared "Anonymous" customer row — and compareFields would
// read the literal sentinel as a real name, forcing false disagreements
// (dup-row rejects) against a candidate row that carries the person's real
// name. Insert-time attach never had this problem (it passes the raw form
// values, pre-sentinel); this helper gives stored-row callers the same
// clean identity.
export function quoteRowToIdentity(row: QuoteIdentityRow): QuoteIdentityRow {
  const name = norm(row.customer_name);
  const address = norm(row.customer_address);
  return {
    id: row.id,
    highlevel_contact_id: norm(row.highlevel_contact_id),
    customer_name: name === 'Anonymous' ? null : name,
    customer_email: norm(row.customer_email),
    customer_phone: norm(row.customer_phone),
    customer_address: address === '(no address)' ? null : address,
  };
}

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

// #213 (3-lens review, fix 2 — tech HIGH): does `identity` CONFLICT with
// `row` on the HighLevel contact id — both non-null, and DIFFERENT? An HL id
// is CRM-issued and unique, so two different ones can only ever mean two
// different real contacts. This is a hard VETO in classifyCandidate's total
// order below: it beats even a 2-field email+phone agreement (a shared
// household email/phone alongside two genuinely different hl ids is still
// two different people, and a merge here would permanently self-contradict
// the row: match_key stays hl:<the OTHER id> while this write clobbers the
// hl_contact_id COLUMN to ours).
function hlConflicts(identity: CustomerIdentity, row: Pick<CustomerRow, 'hl_contact_id'>): boolean {
  const a = norm(identity.hl_contact_id);
  const b = norm(row.hl_contact_id);
  return !!a && !!b && a !== b;
}

// #213: does `identity` agree with `row` on the HighLevel contact id — both
// non-null and EQUAL? An HL id is CRM-issued and unique — unlike email/
// phone/name, which are self-reported and, per #198's review, shareable
// within a household — so agreement here is ALWAYS enough on its own to
// adopt (design point 1). Complementary to hlConflicts above, not redundant
// with it: both-null and one-null-one-set are neither agreement nor
// conflict — classifyCandidate checks hlConflicts FIRST, so this only ever
// runs once a conflict has already been ruled out.
function hlAgrees(identity: CustomerIdentity, row: Pick<CustomerRow, 'hl_contact_id'>): boolean {
  const a = norm(identity.hl_contact_id);
  const b = norm(row.hl_contact_id);
  return !!a && !!b && a === b;
}

// #213: which of {email, phone, name} agree vs. actively DISAGREE between
// `identity` and an existing `row` — present AND compared after normalizing.
// A field missing on EITHER side is neither an agreement nor a disagreement:
// it's simply unknown (see classifyCandidate rule 4 — "absence isn't
// evidence of a different person; disagreement is").
function compareFields(
  identity: CustomerIdentity,
  row: Pick<CustomerRow, 'email' | 'phone' | 'name'>,
): { agreeing: string[]; disagreeing: string[] } {
  const agreeing: string[] = [];
  const disagreeing: string[] = [];
  const email = norm(identity.email)?.toLowerCase() ?? null;
  const rowEmail = norm(row.email)?.toLowerCase() ?? null;
  if (email && rowEmail) (email === rowEmail ? agreeing : disagreeing).push('email');
  const phone = normalizePhone(identity.phone);
  const rowPhone = normalizePhone(row.phone);
  if (phone && rowPhone) (phone === rowPhone ? agreeing : disagreeing).push('phone');
  const name = normNameForCompare(identity.name);
  const rowName = normNameForCompare(row.name);
  if (name && rowName) (name === rowName ? agreeing : disagreeing).push('name');
  return { agreeing, disagreeing };
}

// #213 (round-2 adversarial delta-verify, fix 1 — HIGH, replaces the
// original rule 4 predicate): which of {email, phone, name} are POPULATED
// (non-null after normalizing) on a given identity/row — used to check
// whether `identity` CONTRIBUTES a field the candidate `row` has no value
// for at all (as opposed to merely disagreeing on a shared one).
function populatedFieldSet(x: { email?: string | null; phone?: string | null; name?: string | null }): Set<string> {
  const s = new Set<string>();
  if (norm(x.email)) s.add('email');
  if (normalizePhone(x.phone)) s.add('phone');
  if (norm(x.name)) s.add('name');
  return s;
}

function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// #213 (3-lens review, fix 3 — staff HIGH, design refinement over the
// original #213 rule; rule 4's predicate corrected by a round-2 adversarial
// delta-verify, HIGH): the FULL adopt/reject decision for whether `identity`
// may adopt an existing `row`, in ONE fixed total order:
//   1. hl-CONFLICT (hlConflicts) → hard VETO, never adopt. Beats every other
//      signal, including a 2-field agreement (fix 2).
//   2. hl-AGREE (hlAgrees) → adopt unconditionally (design point 1).
//   3. >=2 of {email, phone, name} agree → adopt.
//   4. >=1 field agrees AND ZERO fields populated on BOTH sides disagree AND
//      `identity`'s populated field-set is a SUBSET of `row`'s populated
//      field-set → adopt. Absence isn't evidence of a different person (a
//      row that's never had a name can't "conflict" with one identity
//      happens to provide) — but the SUBSET check matters: a RICH identity
//      (e.g. email+phone+name) hitting a SPARSE row (email only) on just
//      the one shared field would otherwise adopt and newest-win would
//      stamp the identity's uncorroborated phone/name onto the row — the
//      exact wrong-merge class this ticket exists to close, just reached
//      asymmetrically (rich-into-sparse) instead of symmetrically
//      (sparse-into-sparse). An identity that contributes NO field the row
//      lacks can't cause that: either it's an identical-or-sparser repeat
//      (subset holds, e.g. two quotes that only ever carry the same phone,
//      or a lead's email-only identity meeting its own fuller past profile
//      — both converge deterministically instead of splitting on race
//      timing or bouncing a legitimate repeat), or it's actively
//      contributing something new and unproven, which this rule now
//      declines to trust.
//   5. Otherwise → reject — the money case (e.g. same phone, DIFFERENT
//      name, or a rich identity's uncorroborated extra field): a shared
//      household field must never silently attach this quote's identity —
//      and, via #199, its NCE money terms — to the wrong customer.
function classifyCandidate(
  identity: CustomerIdentity,
  row: Pick<CustomerRow, 'hl_contact_id' | 'email' | 'phone' | 'name'>,
): { adopt: boolean; vetoed: boolean; agreeing: string[]; disagreeing: string[] } {
  if (hlConflicts(identity, row)) return { adopt: false, vetoed: true, agreeing: [], disagreeing: [] };
  if (hlAgrees(identity, row)) return { adopt: true, vetoed: false, agreeing: [], disagreeing: [] };
  const { agreeing, disagreeing } = compareFields(identity, row);
  const adopt =
    agreeing.length >= 2 ||
    (agreeing.length >= 1 &&
      disagreeing.length === 0 &&
      isSubsetOf(populatedFieldSet(identity), populatedFieldSet(row)));
  return { adopt, vetoed: false, agreeing, disagreeing };
}

// #213: a short, staff-readable summary of why a candidate was REJECTED —
// feeds the candidate-merge warning (WT-55).
function describeRejection(d: { vetoed: boolean; agreeing: string[]; disagreeing: string[] }): string {
  if (d.vetoed) return 'hl_contact_id conflict';
  const bits: string[] = [];
  if (d.agreeing.length) bits.push(`${d.agreeing.join('+')} agreed`);
  if (d.disagreeing.length) bits.push(`${d.disagreeing.join('+')} conflicted`);
  return bits.length ? bits.join(', ') : 'no agreeing field';
}

// #213 (round-2 adversarial delta-verify, fix 4 — LOW): the SAME candidate
// can legitimately get classified (and rejected) more than once across
// phases — e.g. the exact-match phase and the secondary/OR search can both
// surface the same row, and round-2 fix 2 above means a single search can
// now surface it twice too. Dedup by id before the final candidate-merge
// warning so staff see one line per row, not a repeated one; keep whichever
// detail string is longest (the "richest") if they ever differ.
function dedupRejected(rejected: Array<{ id: string; detail: string }>): Array<{ id: string; detail: string }> {
  const byId = new Map<string, string>();
  for (const r of rejected) {
    const existing = byId.get(r.id);
    if (!existing || r.detail.length > existing.length) byId.set(r.id, r.detail);
  }
  return Array.from(byId, ([id, detail]) => ({ id, detail }));
}

// #213 (3-lens review, fix 5 — tech MED): a deterministic, collision-
// avoiding match_key for a row created because a candidate was found but
// REJECTED — see findOrCreateCustomer, WT-55. Plain `customerMatchKey
// (identity)` would collide with the rejected candidate's OWN match_key
// whenever the rejection came from the exact-match phase — that row already
// legitimately owns that key, so reusing it isn't a race, it's a certainty
// (customers.match_key is UNIQUE).
//
// Encodes EVERY one of this identity's own populated fields — INCLUDING
// hl_contact_id (never itself sufficient for the "authoritative" adopt
// decision unless it AGREES with a candidate, but still needed here): without
// it, two DIFFERENT hl-carrying identities that happen to share every other
// field (email+phone+name — e.g. two GHL contacts both showing a business's
// shared "info@" email/phone) would compute the SAME disambiguated key and
// collide forever, since findOrCreateCustomer's retry-recovery loop would
// keep hl-vetoing (fix 2) the same recovered row on every attempt. Folding
// hl in gives them distinct keys instead, so each gets its own clean row.
//
// JSON-encoded, not a hand-joined string: a raw `|`-delimiter join would let
// a crafted or simply unlucky name containing `|` smuggle a fake extra field
// and collide two different identities' keys. JSON.stringify unambiguously
// escapes every component, so key equality can only ever mean true field-by-
// field equality.
//
// Deterministic per identity, so a genuine repeat of this exact (rejected)
// identity reproduces the SAME string — the row created here is what a
// repeat resolves back to via the standard insert/unique-violation-reselect
// recovery, while two different people who merely share one field keep
// landing on separate rows.
function disambiguatedMatchKey(identity: CustomerIdentity): string {
  const parts: Array<[string, string]> = [];
  const hl = norm(identity.hl_contact_id);
  if (hl) parts.push(['hl', hl]);
  const email = norm(identity.email);
  if (email) parts.push(['email', email.toLowerCase()]);
  const phone = normalizePhone(identity.phone);
  if (phone) parts.push(['phone', phone]);
  const name = norm(identity.name);
  if (name) parts.push(['name', name.toLowerCase()]);
  return `dup:${JSON.stringify(parts)}`;
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
// #213 (S34 #198 review, customer lens; total order refined by a 3-lens
// review pass — see classifyCandidate): a candidate that doesn't clear the
// adopt bar is NEVER adopted — a shared household email/phone would
// otherwise silently attach this quote's identity (and, via #199, its NCE
// money terms) to the WRONG customer. It instead creates a NEW row (under a
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

  // #213 (fix 6): every candidate found-but-rejected across every phase
  // (exact-match, secondary/OR search, and the create-path retry-recovery
  // below) is accumulated here, not just the last one — the final
  // candidate-merge warning names ALL of them.
  const rejected: Array<{ id: string; detail: string }> = [];

  // #213: adopt `row` — upgrade match_key to `key` only when it out-ranks
  // what's stored (never downgrades an existing higher-or-equal-precedence
  // key, the original W2-009 rule) and backfill any newly-known fields.
  // Shared by the secondary/OR-search adopt below AND the fix-1 retry-
  // recovery adopt further down: a recovered row's match_key already equals
  // whatever key was searched for, so this is a no-op key-wise UNLESS that
  // key was the `dup:` disambiguation key, in which case it correctly
  // upgrades to a clean key now that the adopt is confirmed safe.
  //
  // #213 (round-2 adversarial delta-verify, fix 3 — MED): the key upgrade
  // itself can hit UNIQUE — `key` (the plain hl/email/phone/name key) is
  // sometimes already legitimately owned by an EARLIER-rejected candidate
  // (that's exactly why THIS row is still on a disambiguated key). That's
  // not a transient race: it's a permanent structural fact that will recur
  // on every future adopt of this same row, for as long as the earlier
  // candidate's row exists — so it must never be logged as an error. Retry
  // the SAME write with only the key change dropped (row stays on its
  // existing key; the contact-field backfill still applies), and log once
  // at info, not error.
  async function adopt(
    row: Pick<CustomerRow, 'id' | 'match_key' | 'hl_contact_id' | 'name' | 'email' | 'phone'>,
  ): Promise<{ id: string }> {
    const rowKeyRank = keyPrecedenceRank(row.match_key);
    const ourKeyRank = keyPrecedenceRank(key);
    const nextMatchKey = ourKeyRank < rowKeyRank ? key : row.match_key;
    const contactFields = {
      hl_contact_id: norm(identity.hl_contact_id) ?? row.hl_contact_id,
      name: norm(identity.name) ?? row.name,
      email: norm(identity.email) ?? row.email,
      phone: norm(identity.phone) ?? row.phone,
    };
    // sb is narrowed non-null above, but that narrowing doesn't cross into a
    // nested function's body — `adopt` only ever runs synchronously within
    // this same call, after the same guard, so the assertion is sound here.
    const { error: updErr } = await sb!
      .from('customers')
      .update({ match_key: nextMatchKey, ...contactFields })
      .eq('id', row.id);
    if (updErr) {
      if (updErr.code === '23505' && nextMatchKey !== row.match_key) {
        const { error: retryErr } = await sb!.from('customers').update(contactFields).eq('id', row.id);
        if (retryErr) {
          console.error('findOrCreateCustomer merge-upgrade error (contact-field retry):', retryErr);
        } else {
          console.info(
            `findOrCreateCustomer: customer ${row.id} stays on its existing key — ${key} is already owned by a previously-rejected candidate (expected).`,
          );
        }
      } else {
        console.error('findOrCreateCustomer merge-upgrade error:', updErr);
      }
    }
    return { id: row.id };
  }

  const existing = await sb
    .from('customers')
    .select('id, name, email, phone, hl_contact_id')
    .eq('match_key', key)
    .maybeSingle<Pick<CustomerRow, 'id' | 'name' | 'email' | 'phone' | 'hl_contact_id'>>();
  if (existing.data) {
    const row = existing.data;
    // #213: an exact match_key hit is only a safe signal ON ITS OWN when
    // it's hl-based (classifyCandidate rule 2). When identity has no hl id,
    // `key` is email/phone/name-derived and this equality is itself only ONE
    // agreeing field — run it through the same total-order decision as every
    // other candidate below.
    const decision = classifyCandidate(identity, row);
    if (decision.adopt) {
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
    rejected.push({ id: row.id, detail: describeRejection(decision) });
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
  // fails corroboration on ITS key field doesn't mean no adopt-worthy
  // candidate exists under a DIFFERENT key (e.g. identity is now email+
  // phone+name; an email-only row shares only email, but a SEPARATE phone-
  // keyed row for the same real person shares phone+name) — worth the extra
  // query to not miss a legitimate merge.
  const secondaryKeys = secondaryMatchKeys(identity).filter((k) => k !== key);
  const orConds: string[] = [];
  const hl = norm(identity.hl_contact_id);
  if (hl && safeOrValue(hl)) orConds.push(`hl_contact_id.eq.${hl}`);
  const email = norm(identity.email);
  if (email && safeOrValue(email)) orConds.push(`email.eq.${email}`);
  const phoneRaw = norm(identity.phone);
  if (phoneRaw && safeOrValue(phoneRaw)) orConds.push(`phone.eq.${phoneRaw}`);

  // #213 (round-2 adversarial delta-verify, fix 2 — HIGH): a REJECTED .in()
  // hit must not suppress the OR-fallback below — a different, adoptable
  // candidate can still exist there (e.g. an EARLIER no-hl disambiguated row
  // for the SAME real person, findable only by a raw email/phone column,
  // while .in() instead surfaced an unrelated row that merely shares this
  // identity's derived secondary key). Both searches now iterate every row
  // they return (not just the first) and classify each in turn, so a
  // rejected candidate sorting first in a result set can't hide an
  // adoptable one sorting after it — adopt the first candidate, from either
  // search, that actually passes; push every reject along the way.
  if (secondaryKeys.length) {
    const { data: byKey } = await sb.from('customers').select('*').in('match_key', secondaryKeys);
    for (const row of (byKey as CustomerRow[] | null) ?? []) {
      const decision = classifyCandidate(identity, row);
      if (decision.adopt) return await adopt(row);
      rejected.push({ id: row.id, detail: describeRejection(decision) });
    }
  }
  if (orConds.length) {
    const { data: candidates } = await sb.from('customers').select('*').or(orConds.join(','));
    for (const row of (candidates as CustomerRow[] | null) ?? []) {
      const decision = classifyCandidate(identity, row);
      if (decision.adopt) return await adopt(row);
      rejected.push({ id: row.id, detail: describeRejection(decision) });
    }
  }

  // #213 (3-lens review, fix 1 — tech HIGH): create, with the SAME
  // classification gate applied to whatever the unique-violation retry
  // recovers below — NOT a blind trust. The old code trusted a recovered row
  // unconditionally: when `candidateKey` starts as the PLAIN key (no
  // candidate seen above — e.g. two brand-new quotes for two DIFFERENT
  // people who happen to share one field, racing each other, exactly the
  // backfill's own documented concurrent Promise.all pattern), two different
  // people could silently merge with ZERO warning via this exact race — the
  // failure this whole ticket exists to close.
  //
  // Bounded loop, not open-ended: a plain-key collision is a genuine race
  // against (at most, per attempt) one other writer, resolved by classifying
  // the recovered row and switching to the disambiguated key on reject. A
  // disambiguated-key collision is PROVABLY always a re-classify-as-adopt —
  // that key fully encodes hl+email+phone+name (disambiguatedMatchKey), so
  // any row sharing it shares EVERY field this identity does, which always
  // clears classifyCandidate's rule 3 or 4. The headroom past 2 attempts is
  // defensive, not relied on.
  let candidateKey = rejected.length ? disambiguatedMatchKey(identity) : key;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ins = await sb
      .from('customers')
      .insert({
        match_key: candidateKey,
        hl_contact_id: norm(identity.hl_contact_id),
        name: norm(identity.name),
        email: norm(identity.email),
        phone: norm(identity.phone),
      })
      .select('id')
      .single();
    if (!ins.error && ins.data) {
      const newId = ins.data.id as string;
      if (rejected.length) {
        const pairs = dedupRejected(rejected)
          .map((r) => `${r.id} (${r.detail})`)
          .join('; ');
        console.warn(
          `findOrCreateCustomer: candidate merge NOT applied for new customer ${newId} — rejected: ${pairs}. Review for a manual merge (WT-55).`,
        );
      }
      return { id: newId };
    }

    // Lost the insert race → recover, then CLASSIFY (fix 1) before trusting it.
    const retry = await sb
      .from('customers')
      .select('id, match_key, name, email, phone, hl_contact_id')
      .eq('match_key', candidateKey)
      .maybeSingle<Pick<CustomerRow, 'id' | 'match_key' | 'name' | 'email' | 'phone' | 'hl_contact_id'>>();
    if (!retry.data) {
      console.error('findOrCreateCustomer error:', ins.error);
      return null;
    }
    const decision = classifyCandidate(identity, retry.data);
    if (decision.adopt) return await adopt(retry.data);
    rejected.push({ id: retry.data.id, detail: describeRejection(decision) });
    candidateKey = disambiguatedMatchKey(identity);
  }
  console.error(`findOrCreateCustomer: exhausted create/recover attempts for key ${key}`);
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
  // findOrCreateProperty) already makes concurrent same-key creates safe.
  // Keeps a large first-run backfill well under a function timeout without
  // the unbounded fan-out of a single Promise.all(rows.map(...)).
  //
  // #213 fix 3 (precise guarantee, post 3-lens review): overlapping quotes
  // for the SAME customer within a chunk dedup onto ONE row UNCONDITIONALLY
  // when their identities are IDENTICAL (nothing populated on both sides can
  // disagree — classifyCandidate's zero-disagreement rule always adopts).
  // When two overlapping quotes' identities instead CONFLICT on a field both
  // carry (e.g. same phone, different name — the household-share risk #213
  // exists to catch), findOrCreateCustomer correctly REJECTS the merge and
  // creates a separate row instead, exactly as it would outside a backfill —
  // this loop adds concurrency, not a looser identity rule.
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
