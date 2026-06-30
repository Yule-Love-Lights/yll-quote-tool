// Configurable inbox settings stored in app_settings (#58 v3).
// Kept in-area (dashboard/inbox/) to avoid touching Jason's appSettings.ts.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { clampFollowUpDays } from './lifecycle';

const FOLLOW_UP_DAYS_KEY = 'dashboard.followUpDays';

/** The configured follow-up-reminder window in days. Safe default 3 on any error. */
export async function getFollowUpDays(): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 3;
  const { data, error } = await sb.from('app_settings').select('value').eq('key', FOLLOW_UP_DAYS_KEY).maybeSingle();
  if (error || !data) return 3;
  return clampFollowUpDays((data as { value?: unknown }).value);
}

export async function setFollowUpDays(days: number): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  await sb.from('app_settings').upsert({ key: FOLLOW_UP_DAYS_KEY, value: clampFollowUpDays(days) }, { onConflict: 'key' });
}
