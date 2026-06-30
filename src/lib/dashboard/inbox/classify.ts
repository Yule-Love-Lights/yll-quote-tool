// Pure lead-vs-noise classification (#58 inbox triage v1). No I/O — adapters call
// this with the signals they have, then stamp NormalizedTouch.leadKind. Layer 1
// (from-us, by domain) is handled in the Gmail adapter's direction logic; this
// module is layer 2 (automated/marketing) + the shared isFromUs helper.

export type LeadKind = 'lead' | 'automated';

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

export function isFromUs(
  fromAddress: string | null | undefined,
  opts: { ourDomain?: string | null; internalAddrs?: string[] },
): boolean {
  const addr = bareAddress(fromAddress);
  if (!addr) return false;
  const domain = opts.ourDomain?.trim().toLowerCase();
  if (domain && addr.endsWith(`@${domain}`)) return true;
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
