import { getSupabaseServiceClient } from '@/lib/supabase';

/**
 * The crew door's audit trail (review round on PR #1094): who was sent a link,
 * who walked through, and which attempts were refused.
 *
 * Append-only and best effort, matching logAdvertisingActivity: an audit write
 * must never be the reason a crew member cannot see their day.
 */
export type CrewAccessAction = 'link_minted' | 'entered' | 'entry_refused';

export async function logCrewAccess(entry: {
  crewMemberId: string | null;
  actor: string;
  action: CrewAccessAction;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const db = getSupabaseServiceClient();
  if (!db) return;
  try {
    const { error } = await db.from('crew_access_events').insert({
      crew_member_id: entry.crewMemberId,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail ?? null,
    });
    if (error) console.error('logCrewAccess error:', error);
  } catch (error) {
    console.error('logCrewAccess threw:', error);
  }
}
