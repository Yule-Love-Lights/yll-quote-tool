// Pure email content for the escalation engine. The transport is the existing
// HighLevel sendEmail → internal contact (HIGHLEVEL_INTERNAL_CONTACT_ID,
// emailFrom = HIGHLEVEL_EMAIL_FROM = sales@yulelovelights.com); these builders
// just produce the subject + HTML so they're unit-testable.

export type EscalationEmailItem = { name: string; preview: string | null; waiting: string };

// Emails have no page origin, so a relative href resolves as a hostname in the
// mail client ("inbox" → NXDOMAIN). The absolute base is passed in by the server
// caller (appBaseUrl()) so this module stays env-free — it's also imported by
// client components for formatWaiting.
function inboxLink(baseUrl: string): string {
  return `<a href="${baseUrl.replace(/\/+$/, '')}/inbox">Open the inbox →</a>`;
}

/** Human-friendly elapsed time: "45m", "2h 5m", "1d 2h". */
export function formatWaiting(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

export function escalationEmailSubject(opts: { level: number; count: number }): string {
  const { level, count } = opts;
  const prefix = level >= 2 ? '🔴 URGENT' : '🟡 Heads up';
  return `${prefix}: ${count} customer message${plural(count)} still unanswered`;
}

function clip(s: string, n = 140): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function itemList(items: EscalationEmailItem[]): string {
  const rows = items
    .map(
      (i) =>
        `<li style="margin:0 0 10px"><strong>${i.name}</strong> — waiting ${i.waiting}` +
        // Clip the preview: enough context to triage, without putting a full
        // customer message body into a team-wide email.
        (i.preview ? `<br><span style="color:#555">${clip(i.preview)}</span>` : '') +
        `</li>`,
    )
    .join('');
  return `<ul style="padding-left:18px">${rows}</ul>`;
}

export function escalationEmailHtml(opts: {
  level: number;
  items: EscalationEmailItem[];
  baseUrl: string;
}): string {
  const heading = opts.level >= 2 ? 'These have been waiting too long' : 'A customer is waiting';
  return (
    `<div style="font-family:system-ui,sans-serif">` +
    `<h2>${heading}</h2>` +
    itemList(opts.items) +
    `<p>${inboxLink(opts.baseUrl)}</p>` +
    `</div>`
  );
}

export function eodDigestSubject(count: number): string {
  return `📋 End-of-day: ${count} unanswered customer message${plural(count)}`;
}

export function eodDigestHtml(items: EscalationEmailItem[], baseUrl: string): string {
  return (
    `<div style="font-family:system-ui,sans-serif">` +
    `<h2>Still unanswered at end of day (${items.length})</h2>` +
    itemList(items) +
    `<p>These roll into tomorrow's digest until handled. ${inboxLink(baseUrl)}</p>` +
    `</div>`
  );
}
