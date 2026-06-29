// src/lib/integrations/telegramMessages.ts
// PURE formatters for the proactive inventory Telegram pings (#82 follow-up).
// No IO, no process.env — callers pass baseUrl. Plain text (the bot sends with no
// parse_mode); sendTelegramMessage hard-slices at 4000 chars as a final backstop,
// but capList keeps long lists from being cut mid-line.

// Structural input shapes (a MaterialRow / UnboundConcept from
// materialsProjection satisfies these, so call sites pass those directly).
type PrepMaterial = { sku: string; name: string; qty: number; onHand: number | null; short: boolean };
type PrepUnbound = { label: string; qty: number };

const MAX_BULLETS = 40;

// Keep at most `max` bullets; if there are more, append a "…+N more" line so the
// message never gets truncated mid-line by Telegram's 4000-char limit.
export function capList(bullets: string[], max = MAX_BULLETS): string[] {
  if (bullets.length <= max) return bullets;
  return [...bullets.slice(0, max), `…+${bullets.length - max} more`];
}

function stockFlag(m: PrepMaterial): string {
  if (m.onHand === null) return '➖ not tracked';
  if (m.short) return `⚠️ short (${m.onHand} on hand)`;
  return '✅ in stock';
}

export function prepJobMessage(args: {
  customerName: string | null;
  jobNumber: number | null;
  materials: PrepMaterial[];
  unbound: PrepUnbound[];
  baseUrl: string;
}): string {
  const who = args.customerName?.trim() || 'Customer';
  const jobTag = args.jobNumber != null ? ` (Job #${args.jobNumber})` : '';
  const lines = [`🔔 New job to prep — ${who}${jobTag}`];

  const bullets = [
    ...args.materials.map((m) => `• ${m.name} (${m.sku}) ×${m.qty} — ${stockFlag(m)}`),
    ...args.unbound.map((u) => `• ${u.label} ×${u.qty} — ⚠️ no SKU bound`),
  ];

  if (bullets.length === 0) {
    lines.push('No tracked materials projected.');
  } else {
    lines.push('Deposit just paid. Materials needed:');
    lines.push(...capList(bullets));
  }
  lines.push(`Prep → ${args.baseUrl}/inventory/jobs`);
  return lines.join('\n');
}

export function lowStockMessage(args: {
  items: { name: string; sku: string; onHand: number; reorderPoint: number }[];
  baseUrl: string;
}): string {
  const lines = [`⚠️ Low stock — ${args.items.length} new item(s) need ordering`];
  lines.push(
    ...capList(args.items.map((i) => `• ${i.name} (${i.sku}): ${i.onHand} on hand (reorder ${i.reorderPoint})`)),
  );
  lines.push(`Order → ${args.baseUrl}/inventory/orders`);
  return lines.join('\n');
}

export function poSentMessage(args: {
  lines: { name: string; sku: string; order: number }[];
  jobCount: number;
  baseUrl: string;
}): string {
  const out = [`📦 Purchase order sent to supplier — ${args.jobCount} job(s)`];
  out.push(...capList(args.lines.map((l) => `• ${l.name} (${l.sku}) ×${l.order}`)));
  out.push(`Details → ${args.baseUrl}/inventory/orders`);
  return out.join('\n');
}
