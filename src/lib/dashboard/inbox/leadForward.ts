// #268: detect + parse third-party lead-forwarding platform emails (e.g. GML
// Media's Zapier-relayed "New Lead from GML Media" forwards) so their real
// customer content isn't lost two ways: (1) misclassified `automated` by the
// forwarding platform's own bulk-mail signals — a no-reply-shaped sender, or
// (layer 3) an explicit sender-suppression entry the platform's own address
// picked up — and (2) attached to the FORWARDER's contact identity instead of
// the actual customer's, which makes the row un-findable by the customer's
// name/phone/email and un-resolvable by contacting them.
//
// Detection is fail-closed: a message only counts as a lead-forward when BOTH
// (1) the sender matches a KNOWN platform (domain and/or display name — never
// the exact address, since a platform can rotate the local part per
// connection) AND (2) the body yields at least a phone or an email for the
// forwarded customer. Either alone is not enough — a platform match with no
// parseable customer (the forwarder's own receipt/digest mail) falls through
// to today's classify.ts + suppression behavior unchanged.

import { normalizeEmail, normalizeName, normalizePhone } from './normalize';

export type LeadForwardPlatform = {
  id: string;
  /** Bare sender domain(s) that identify this platform. Bare-or-subdomain
   *  match (same rule as classify.ts's isInternalDomain). */
  senderDomains?: string[];
  /** Case-insensitive substrings of the From display name that also identify
   *  this platform — a redundant signal to the domain, useful since some
   *  lead-forward senders vary their address's local part per connection
   *  (GML Media's is a fixed-but-opaque Zapier "Email by Zapier" token,
   *  `no-reply.mj1fi9@zapiermail.com`; a resend of the same Zap could get a
   *  different token). */
  displayNameContains?: string[];
};

// #268: ONE entry per known lead-forwarding platform — add the next one here.
export const LEAD_FORWARD_PLATFORMS: readonly LeadForwardPlatform[] = [
  {
    id: 'gml-media',
    senderDomains: ['zapiermail.com'],
    displayNameContains: ['gml media'],
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

/** Which known lead-forward platform (if any) this sender belongs to. */
export function matchLeadForwardPlatform(
  fromAddress: string | null | undefined,
  displayName: string | null | undefined,
): LeadForwardPlatform | null {
  const domain = bareDomain(fromAddress);
  const name = (displayName ?? '').trim().toLowerCase();
  for (const platform of LEAD_FORWARD_PLATFORMS) {
    const domainHit = !!domain && !!platform.senderDomains?.length && matchesDomain(domain, platform.senderDomains);
    const nameHit = !!name && !!platform.displayNameContains?.length && platform.displayNameContains.some((s) => name.includes(s));
    if (domainHit || nameHit) return platform;
  }
  return null;
}

// Both observed live shapes carry the same core block regardless of what
// precedes it in the body — a direct forward starts with it; our own Gmail
// "reacted" re-ingest just quotes it after "... wrote:" — so these scan the
// whole body rather than anchoring to its start:
//   Here ya go <anything>: <Full Name> +1XXXXXXXXXX Email: <email> Street
//   Address: <addr> City: <city> Areas to light up: ...
const PHONE_RE = /\+1\d{10}/;
const EMAIL_RE = /Email:\s*(\S+@\S+)/i;
const NAME_RE = /Here ya go[^:]*:\s*(.+?)\s*(?=\+1\d{10})/i;
const STREET_RE = /Street Address:\s*(.+?)\s*(?:City:|Areas to light up:|$)/i;
const CITY_RE = /City:\s*(.+?)\s*(?:Areas to light up:|$)/i;

/** Match `re` against `body`, trim, and strip any trailing punctuation a lazy
 *  capture dragged in (e.g. a period butted up against the next label). */
function extractField(body: string, re: RegExp): string | null {
  const value = body.match(re)?.[1]?.trim().replace(/[.,;]+$/, '');
  return value || null;
}

/**
 * Parse a lead-forward message. Returns null unless the sender matches a
 * known platform AND the body yields at least a phone or an email — that's
 * the fail-closed invariant: a platform match alone (the forwarder's own
 * receipts/digests, which carry no customer phone/email) is NOT a lead-forward
 * and the caller should fall back to today's classification behavior.
 */
export function parseLeadForward(input: {
  fromAddress?: string | null;
  displayName?: string | null;
  body?: string | null;
}): ParsedLeadForward | null {
  const platform = matchLeadForwardPlatform(input.fromAddress, input.displayName);
  if (!platform) return null;
  const body = input.body ?? '';
  const phoneRaw = body.match(PHONE_RE)?.[0] ?? null;
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  const emailRaw = extractField(body, EMAIL_RE);
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  if (!phone && !email) return null; // fail closed: no reachable customer info parsed
  const name = extractField(body, NAME_RE);
  const street = extractField(body, STREET_RE);
  const city = extractField(body, CITY_RE);
  return {
    platformId: platform.id,
    name: name ? normalizeName(name) : null,
    phone,
    email,
    street,
    city,
  };
}
