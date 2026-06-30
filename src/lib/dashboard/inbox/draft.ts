// Pure prompt builder for an AI-drafted inbox reply (#58 v2). No I/O — the route
// gathers context, this assembles the prompt, the route calls Claude. Guardrails
// (no specific prices/dates/scheduling) live here as defense-in-depth even though
// a human reviews + sends every draft.

import type { InboxSource } from './types';

export type DraftContext = {
  customerName: string | null;
  source: InboxSource;
  channel: string | null;
  /** Recent messages on the thread, oldest→newest. Empty for a fresh quote lead. */
  recentMessages: { fromCustomer: boolean; text: string }[];
  /** The quote $ total, for quote-lead follow-ups (context only — never quote it as a promise). */
  quoteTotal: number | null;
};

const SYSTEM = [
  'You draft short reply messages for Yule Love Lights, a Christmas/holiday lighting company,',
  'to send to a customer. Write warm, friendly, concise, professional replies.',
  'Hard rules — DO NOT state specific prices, dollar amounts, install or takedown dates, or',
  'scheduling promises. If the customer asks about price/timing, acknowledge and say a member of',
  'our team will confirm the exact details. Never invent facts. Keep it to 1–3 short sentences.',
  'Sign off as "the Yule Love Lights team" (no placeholders, no signature block).',
  'Output ONLY the reply text — no preamble, no quotes around it.',
].join(' ');

export function buildDraftPrompt(ctx: DraftContext): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(`Customer name: ${ctx.customerName ?? 'there'}.`);
  lines.push(`Channel: ${ctx.channel ?? 'message'}.`);
  if (ctx.source === 'quotetool') {
    lines.push(
      ctx.quoteTotal != null
        ? 'Context: this customer has an open quote with us and has not replied yet. Write a brief, friendly follow-up nudging them to review it. Do not state the quote amount.'
        : 'Context: this is a new lead with an open quote. Write a brief, friendly follow-up.',
    );
  }
  if (ctx.recentMessages.length) {
    lines.push('', 'Recent conversation (oldest first):');
    for (const m of ctx.recentMessages) lines.push(`${m.fromCustomer ? 'Customer' : 'Us (Yule Love Lights team)'}: ${m.text}`);
    lines.push('', 'Draft our reply to the latest customer message.');
  }
  return { system: SYSTEM, user: lines.join('\n') };
}
