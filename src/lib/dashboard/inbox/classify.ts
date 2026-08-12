// Pure lead-vs-noise classification (#58 inbox triage v1). No I/O — adapters call
// this with the signals they have, then stamp NormalizedTouch.leadKind. Layer 1
// (from-us, by domain) is handled in the Gmail adapter's direction logic; this
// module is layer 2 (automated/marketing) + the shared isFromUs helper.

export type LeadKind = 'lead' | 'automated';

// #252: the ONE place internal/company-owned email domains are listed. Bare
// domain OR any subdomain matches — our own automated mail (marketing sends,
// "Quote viewed" alerts, the escalation email, the EOD digest) all goes out
// from sales@mail.yulelovelights.com, a subdomain. isFromUs always checks
// this list (in addition to any caller-supplied ourDomain) so the self-ingest
// filter holds even when a caller's own domain source (e.g. GMAIL_USER) is
// unset or misconfigured. Add new internal domains here — this is now the
// single source; gmail.ts and quotetool.ts both delegate to isFromUs instead
// of keeping their own copy (the drift #252 fixed).
export const INTERNAL_EMAIL_DOMAINS = ['yulelovelights.com'] as const;

const NO_REPLY_RE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|mailer|bounce|postmaster)@/i;
const AUTOMATED_PHRASES = [
  'unsubscribe',
  'no longer wish to receive',
  'opt out',
  'opt-out',
  'reply stop',
  'manage your preferences',
  'manage preferences',
];

/** Bare lowercased address out of a "Name <addr>" or bare string. */
function bareAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const angle = value.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : value).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

/** True when `domain` equals one of `internalDomains` or is a SUBDOMAIN of
 *  one (`.`-bounded, so `notyulelovelights.com` and
 *  `yulelovelights.com.evil.co` correctly do NOT match `yulelovelights.com`). */
function isInternalDomain(domain: string, internalDomains: readonly string[]): boolean {
  return internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function isFromUs(
  fromAddress: string | null | undefined,
  opts: { ourDomain?: string | null; internalAddrs?: string[] } = {},
): boolean {
  const addr = bareAddress(fromAddress);
  if (!addr) return false;
  // #252 LOW: strip one trailing dot (a technically-valid FQDN, e.g.
  // "sales@mail.yulelovelights.com.") before comparing, so it isn't missed by
  // isInternalDomain's exact/subdomain check below and slip past self-ingest.
  const domain = addr.slice(addr.lastIndexOf('@') + 1).replace(/\.$/, '');
  // #252: always check the static INTERNAL_EMAIL_DOMAINS list too, not only
  // opts.ourDomain — so this holds even when the caller's own domain source
  // (e.g. GMAIL_USER) is unset.
  const domains = opts.ourDomain ? [opts.ourDomain.trim().toLowerCase(), ...INTERNAL_EMAIL_DOMAINS] : INTERNAL_EMAIL_DOMAINS;
  if (isInternalDomain(domain, domains)) return true;
  return (opts.internalAddrs ?? []).some((a) => bareAddress(a) === addr);
}

export function classifyMessage(input: {
  fromAddress?: string | null;
  subject?: string | null;
  preview?: string | null;
  hasListUnsubscribe?: boolean;
}): LeadKind {
  if (input.hasListUnsubscribe) return 'automated';
  const addr = bareAddress(input.fromAddress);
  if (addr && NO_REPLY_RE.test(addr)) return 'automated';
  const haystack = `${input.subject ?? ''} ${input.preview ?? ''}`.toLowerCase();
  if (AUTOMATED_PHRASES.some((p) => haystack.includes(p))) return 'automated';
  return 'lead';
}
