// #268: detect + parse third-party lead-forwarding platform emails (e.g. GML
// Media's Zapier-relayed "New Lead from GML Media" forwards) so their real
// customer content isn't lost two ways: (1) misclassified `automated` by the
// forwarding platform's own bulk-mail signals — a no-reply-shaped sender, or
// (layer 3) an explicit sender-suppression entry the platform's own address
// picked up — and (2) attached to the FORWARDER's contact identity instead of
// the actual customer's, which makes the row un-findable by the customer's
// name/phone/email and un-resolvable by contacting them.
//
// Detection is fail-closed and requires THREE independent things, not two —
// #268's fix round (technical HIGH) tightened this after review found the
// original two-of-three design forgeable:
//   1. The sender's DOMAIN matches a known platform.
//   2. The sender's DISPLAY NAME also matches that platform.
//   3. The body yields at least a phone or an email for the forwarded
//      customer, extracted ONLY from within the known "Here ya go <name>:
//      ... Areas to light up:" template block (see templateScope below) —
//      never from anywhere else in the body.
// (1) and (2) used to be OR'd — either alone was enough. That's forgeable:
// zapiermail.com is Zapier's SHARED multi-tenant "Email by Zapier" relay, so
// ANY free Zapier account can send FROM that literal domain (domain alone
// proves nothing about who's sending), and a display name is attacker-chosen
// free text on most sending paths (name alone proves nothing either). All 7
// real prod rows (verified live against inbox_items, #268 fix round) carry
// BOTH the zapiermail.com domain AND the "GML Media" display name, so
// requiring both costs nothing for the legitimate platform and forces a
// forger to control both legs. (3) matters independently: PHONE_RE/EMAIL_RE
// used to scan the WHOLE body unanchored, so a platform-matching but
// off-template message (a receipt/digest that merely mentions a phone number,
// or a footer/signature after the real lead block) could still parse as if
// it were a lead — including, worst case, a REAL existing customer's phone
// number paired with an attacker-controlled email, which identity.ts's
// append-on-match would union straight into that customer's live contact.
// Scoping extraction to the template block closes that off.
//
// Residual, ACCEPTED risk (documented, not fixed here): an attacker who
// fully controls both the sending domain (a free Zapier account) AND the
// display name (most sending paths let the sender choose it) can still
// construct a complete, well-formed fake "Here ya go <name>: <phone> Email:
// <email> ..." block from scratch. That requires knowing a specific target's
// phone number in advance and impersonating GML Media on both legs — a much
// higher bar than either forgery alone, and the same class of risk any
// content-based parser over an unauthenticated channel accepts. If GML Media
// starts signing/authenticating its forwards (e.g. a verifiable sender
// domain), tighten further then.

import { normalizeEmail, normalizeName, normalizePhone } from './normalize';

export type LeadForwardPlatform = {
  id: string;
  /** Bare sender domain(s) that identify this platform. Bare-or-subdomain
   *  match (same rule as classify.ts's isInternalDomain). */
  senderDomains?: string[];
  /** Normalized (trimmed, lowercased) EXACT match against the From display
   *  name — a redundant signal to the domain, useful since some lead-forward
   *  senders vary their address's local part per connection (GML Media's is
   *  a fixed-but-opaque Zapier "Email by Zapier" token,
   *  `no-reply.mj1fi9@zapiermail.com`; a resend of the same Zap could get a
   *  different token). #268 fix round 3 (LOW 2): EXACT match, not substring —
   *  substring-contains let a lookalike name ("not gml media fan", "gml
   *  media fanpage") false-match. All 7 real prod rows are exactly
   *  "GML Media", so exact costs zero real-world recall. */
  displayNames?: string[];
  /**
   * Substring markers (case-insensitive) in the email SUBJECT that identify
   * this platform for DISPLAY purposes only (parseLeadForwardDisplay, #268
   * fix round 3) — the sender address/display name used by
   * matchLeadForwardPlatform above isn't available client-side (OpenInboxItem
   * only carries subject/preview, never the raw From header), so this is a
   * deliberately lower-confidence, DISPLAY-ONLY approximation with NO
   * write/mutation downstream: worst case a crafted subject shows a
   * phone/email hint in the UI, nothing more — it never reaches identity
   * resolution or a database write. Substring (not exact), since real
   * subjects vary ("New Lead from GML Media - <Name>" / "New Lead from GML
   * Media!").
   */
  displaySubjectContains?: string[];
};

// #268: ONE entry per known lead-forwarding platform — add the next one here.
//
// SECURITY / OPS NOTE (#268 fix round, admin MED): a successful match+parse
// here OVERRIDES dashboard.suppressedSenders and classify.ts's bulk-mail
// heuristics UNCONDITIONALLY (see gmail.ts's leadKind override) — there is
// deliberately NO in-product kill switch (no settings toggle, no per-platform
// enable flag). If a platform entry starts causing false positives (or is
// abused), the only off-lever is removing/editing its entry here and
// deploying — there is no faster way to disable it.
export const LEAD_FORWARD_PLATFORMS: readonly LeadForwardPlatform[] = [
  {
    id: 'gml-media',
    senderDomains: ['zapiermail.com'],
    displayNames: ['gml media'],
    displaySubjectContains: ['new lead from gml media'],
  },
];

export type ParsedLeadForward = {
  platformId: string;
  name: string | null;
  /** E.164. */
  phone: string | null;
  /** Normalized/lowercased. */
  email: string | null;
  street: string | null;
  city: string | null;
};

function bareDomain(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function matchesDomain(domain: string, allow: string[]): boolean {
  return allow.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Which known lead-forward platform (if any) this sender belongs to. Requires
 * BOTH the domain AND the display name to match (#268 fix round, technical
 * HIGH) — see the top-of-file note for why either alone is forgeable
 * (zapiermail.com is a shared multi-tenant relay; a display name is
 * attacker-chosen free text on most sending paths). All 7 real prod GML rows
 * carry both, so this costs zero real-world recall. The display-name match is
 * EXACT (normalized), not substring (#268 fix round 3, LOW 2) — see
 * LeadForwardPlatform.displayNames's doc.
 */
export function matchLeadForwardPlatform(
  fromAddress: string | null | undefined,
  displayName: string | null | undefined,
): LeadForwardPlatform | null {
  const domain = bareDomain(fromAddress);
  const name = (displayName ?? '').trim().toLowerCase();
  for (const platform of LEAD_FORWARD_PLATFORMS) {
    const domainHit = !!domain && !!platform.senderDomains?.length && matchesDomain(domain, platform.senderDomains);
    const nameHit = !!name && !!platform.displayNames?.length && platform.displayNames.some((s) => name === s);
    if (domainHit && nameHit) return platform;
  }
  return null;
}

/**
 * Which known lead-forward platform (if any) this SUBJECT belongs to —
 * DISPLAY-ONLY sibling of matchLeadForwardPlatform for callers (client
 * components) that only have subject/preview, not the raw sender. See
 * LeadForwardPlatform.displaySubjectContains's doc for why this is
 * deliberately lower-confidence and why that's an acceptable trade here.
 */
export function matchLeadForwardPlatformBySubject(subject: string | null | undefined): LeadForwardPlatform | null {
  const s = (subject ?? '').trim().toLowerCase();
  if (!s) return null;
  for (const platform of LEAD_FORWARD_PLATFORMS) {
    if (platform.displaySubjectContains?.some((m) => s.includes(m))) return platform;
  }
  return null;
}

// Both observed live shapes carry the same core block regardless of what
// precedes it in the body — a direct forward starts with it; our own Gmail
// "reacted" re-ingest just quotes it after "... wrote:" — so these all run
// against a SCOPED slice of the body (templateScope, below), never the raw
// body directly:
//   Here ya go <anything>: <Full Name> +1XXXXXXXXXX Email: <email> Street
//   Address: <addr> City: <city> Areas to light up: ...
const TEMPLATE_START_RE = /Here ya go[^:]*:/i;
const TEMPLATE_END_RE = /Areas to light up:/i;
// #268 fix round 3 (MED): cap applied ONLY when TEMPLATE_END_RE isn't found.
// Real fixtures put the phone+"Email:" block within ~80 chars of the "Here ya
// go" marker; 300 leaves generous headroom for longer names/emails while
// still bounding how far a footer/signature beyond the real template can
// leak in. This matters more than it looks: Gmail's own snippet truncation
// (~200 chars total) means the reaction-quoted shape ROUTINELY never reaches
// "Areas to light up:" at all (its ~100-char "reacted via Gmail... wrote:"
// preamble eats most of the budget) — so without this cap, the "no closing
// marker → run to end of body" fallback was doing far more work than the
// top-of-file design doc implied, on the MOST COMMON real shape (4 of 7 live
// rows are reaction-quoted).
const TEMPLATE_MAX_LEN_WITHOUT_CLOSING_MARKER = 300;
const PHONE_RE = /\+1\d{10}/;
const EMAIL_RE = /Email:\s*(\S+@\S+)/i;
const NAME_RE = /Here ya go[^:]*:\s*(.+?)\s*(?=\+1\d{10})/i;
const STREET_RE = /Street Address:\s*(.+?)\s*(?:City:|Areas to light up:|$)/i;
const CITY_RE = /City:\s*(.+?)\s*(?:Areas to light up:|$)/i;

/**
 * Slice the body down to the known lead-forward template block — from the
 * "Here ya go <anything>:" marker (inclusive, so NAME_RE's own match still
 * works) up to "Areas to light up:" if present, else to the end of the body.
 * Returns null when the marker isn't found at all (no known template — not a
 * lead-forward, regardless of anything else in the body).
 *
 * #268 fix round (technical HIGH): PHONE_RE/EMAIL_RE used to scan the WHOLE
 * body unanchored. That let a platform-matching but off-template message —
 * a receipt/digest that merely mentions a phone number, or a footer/
 * signature AFTER the real lead block — parse as if it were a lead, up to
 * and including a REAL existing customer's phone number paired with an
 * unrelated (or attacker-controlled) email from elsewhere in the body, which
 * identity.ts's append-on-match would union straight into that customer's
 * live dashboard contact. Bounding every field extraction to this one scoped
 * slice closes that off — content before "Here ya go" or after "Areas to
 * light up:" is never visible to the extractors below.
 */
function templateScope(body: string): string | null {
  const start = body.match(TEMPLATE_START_RE);
  if (!start || start.index == null) return null;
  const tail = body.slice(start.index);
  const end = tail.match(TEMPLATE_END_RE);
  if (end && end.index != null) return tail.slice(0, end.index);
  // No closing marker — cap instead of running to the end of the body (#268
  // fix round 3, MED). See TEMPLATE_MAX_LEN_WITHOUT_CLOSING_MARKER's doc.
  return tail.slice(0, TEMPLATE_MAX_LEN_WITHOUT_CLOSING_MARKER);
}

/** Match `re` against `scope`, trim, and strip any trailing punctuation a lazy
 *  capture dragged in (e.g. a period butted up against the next label). */
function extractField(scope: string, re: RegExp): string | null {
  const value = scope.match(re)?.[1]?.trim().replace(/[.,;]+$/, '');
  return value || null;
}

/** Shared by parseLeadForward and parseLeadForwardDisplay — pull the phone
 *  and/or email out of an already-template-scoped slice. */
function extractPhoneEmail(scope: string): { phone: string | null; email: string | null } {
  const phoneRaw = scope.match(PHONE_RE)?.[0] ?? null;
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const emailRaw = extractField(scope, EMAIL_RE);
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  return { phone, email };
}

/**
 * Parse a lead-forward message. Returns null unless the sender matches a
 * known platform (domain AND display name — see matchLeadForwardPlatform)
 * AND the body's TEMPLATE-SCOPED block (see templateScope) yields at least a
 * phone or an email — that's the fail-closed invariant: a platform match with
 * no in-template customer info (the forwarder's own receipts/digests, or a
 * stray phone/email elsewhere in the body) is NOT a lead-forward and the
 * caller should fall back to today's classification behavior.
 */
export function parseLeadForward(input: {
  fromAddress?: string | null;
  displayName?: string | null;
  body?: string | null;
}): ParsedLeadForward | null {
  const platform = matchLeadForwardPlatform(input.fromAddress, input.displayName);
  if (!platform) return null;
  const scope = templateScope(input.body ?? '');
  if (scope == null) return null; // no known template found anywhere in the body
  const { phone, email } = extractPhoneEmail(scope);
  if (!phone && !email) return null; // fail closed: no reachable customer info parsed
  const name = extractField(scope, NAME_RE);
  const street = extractField(scope, STREET_RE);
  const city = extractField(scope, CITY_RE);
  return {
    platformId: platform.id,
    name: name ? normalizeName(name) : null,
    phone,
    email,
    street,
    city,
  };
}

export type ParsedLeadForwardDisplay = {
  platformId: string;
  phone: string | null;
  email: string | null;
};

/**
 * DISPLAY-ONLY sibling of parseLeadForward for client components (InboxList)
 * that only have `subject`/`preview` on OpenInboxItem — never the raw sender
 * address/display name parseLeadForward relies on.
 *
 * #268 fix round 3 (technical HIGH, fix-introduced by round 2's FIX B):
 * gating the "Forwarded lead" reply affordance on the CONTACT's phone
 * (`dashboard_contacts.primary_phone`, a cross-channel MERGED field) was
 * unsound TODAY, not just future risk. Reproduced trace: a customer submits
 * a quote (quotetool.ts populates phone+email together) → later emails
 * sales@ normally from the same address → store.ts's resolveIdentity
 * matches the existing contact by email, appendIdentifiers keeps the
 * existing phone (the Gmail touch's OWN identity never had one) → the UI
 * sees a phone on a genuine, replyable Gmail thread and would render the
 * FALSE "email replies go to the platform's no-reply relay" warning —
 * exactly the common returning-customer shape, likely a bigger population
 * than the 7 GML rows this feature exists for.
 *
 * This function fixes that by being MESSAGE-level instead of contact-level:
 * it re-derives the same phone/email the #268 ingest-time parser would have
 * extracted, straight from THIS row's own subject+preview — it never reads
 * the contact at all, so a contact-merge from an unrelated channel can't
 * affect it.
 *
 * Deliberately lower-confidence than parseLeadForward (a subject substring,
 * not sender domain+display-name equality — see
 * LeadForwardPlatform.displaySubjectContains's doc) because the sender isn't
 * available here. That trade is fine: this function only controls what TEXT
 * renders in the UI. No write/mutation ever reads its result — worst case a
 * crafted subject shows a phone/email hint that isn't really a lead-forward;
 * there's no path from here to identity resolution or a database write.
 */
export function parseLeadForwardDisplay(
  subject: string | null | undefined,
  preview: string | null | undefined,
): ParsedLeadForwardDisplay | null {
  const platform = matchLeadForwardPlatformBySubject(subject);
  if (!platform) return null;
  const scope = templateScope(preview ?? '');
  if (scope == null) return null;
  const { phone, email } = extractPhoneEmail(scope);
  if (!phone && !email) return null;
  return { platformId: platform.id, phone, email };
}
