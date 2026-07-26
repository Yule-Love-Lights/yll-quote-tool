// src/lib/integrations/botAudit.ts
// Audit trail for the staff text-ops bot (Phase 2 of the 2026-07-19 plan): who
// asked for what, and what happened. Every write attempt lands here — including
// the ones REFUSED for role — so an unexpected stock or CRM change is always
// traceable to a person and a message.
//
// Best-effort by contract: logging must never break or delay the action it
// describes, so every failure is swallowed after a console.error. An audit gap
// is a smaller problem than a crew member's install completion failing because
// the log table was briefly unavailable.

import { getSupabaseServiceClient } from '@/lib/supabase';
import type { BotRole } from './botRoles';

export type BotAuditOutcome = 'ran' | 'denied' | 'staged' | 'cancelled' | 'failed';

export async function logBotAction(entry: {
  chatId: string | null;
  userId: string | null;
  role: BotRole | null;
  tool: string;
  args?: Record<string, unknown>;
  outcome: BotAuditOutcome;
  detail?: string | null;
}): Promise<void> {
  try {
    const db = getSupabaseServiceClient();
    if (!db) return;
    const { error } = await db.from('bot_audit_log').insert({
      chat_id: entry.chatId,
      user_id: entry.userId,
      role: entry.role,
      tool: entry.tool,
      args: entry.args ?? {},
      outcome: entry.outcome,
      detail: entry.detail ?? null,
    });
    if (error) console.error('[botAudit] insert failed:', error);
  } catch (err) {
    console.error('[botAudit] insert threw:', err);
  }
}
