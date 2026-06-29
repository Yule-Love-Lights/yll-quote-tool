import { getSupabaseClient, getSupabaseServiceClient } from './supabase';

export type ReferenceAssetType = 'spritzer' | 'wreath' | 'garland';

export type ReferenceAssetPayload = {
  assetType: ReferenceAssetType;
  size: string;           // e.g. "24", "30noble", "9ft"
  tier?: string | null;   // e.g. "bow", "fullDecor", "labor"
  base64: string;
  mediaType: string;
  caption?: string | null;
};

export type StoredReferenceAsset = {
  id: string;
  created_at: string;
  asset_type: ReferenceAssetType;
  size: string;
  tier: string | null;
  base64: string;
  media_type: string;
  caption: string | null;
  active: boolean;
};

export type ReferenceListItem = Omit<StoredReferenceAsset, 'base64'> & {
  thumbnail: string; // small inline preview (first ~N chars are fine; keep full for now)
};

export async function saveReferenceAsset(
  payload: ReferenceAssetPayload,
): Promise<{ id: string } | null> {
  // Service client first so reads/writes bypass RLS (enabled on reference_assets,
  // #90); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('reference_assets')
    .insert({
      asset_type: payload.assetType,
      size: payload.size,
      tier: payload.tier ?? null,
      base64: payload.base64,
      media_type: payload.mediaType,
      caption: payload.caption ?? null,
      active: true,
    })
    .select('id')
    .single();

  if (error) {
    console.error('saveReferenceAsset error:', JSON.stringify(error), error?.message);
    return null;
  }
  return { id: data.id };
}

export async function listReferenceAssets(): Promise<StoredReferenceAsset[]> {
  // Service client first so reads/writes bypass RLS (enabled on reference_assets,
  // #90); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('reference_assets')
    .select('*')
    .order('asset_type', { ascending: true })
    .order('size', { ascending: true });
  if (error) {
    console.error('listReferenceAssets error:', error);
    return [];
  }
  return (data ?? []) as StoredReferenceAsset[];
}

export async function deleteReferenceAsset(id: string): Promise<boolean> {
  // Service client first so reads/writes bypass RLS (enabled on reference_assets,
  // #90); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return false;
  const { error } = await supabase.from('reference_assets').delete().eq('id', id);
  if (error) {
    console.error('deleteReferenceAsset error:', error);
    return false;
  }
  return true;
}

// Returns at most `perType` of each asset_type, only active items.
// These get injected into every Claude analysis call as "this is what X looks like" context.
export async function getReferenceAssetsForAnalysis(
  perType = 2,
): Promise<StoredReferenceAsset[]> {
  // Service client first so reads/writes bypass RLS (enabled on reference_assets,
  // #90); anon fallback for dev.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('reference_assets')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: false });
  if (error) return [];
  const all = (data ?? []) as StoredReferenceAsset[];
  const grouped: Record<ReferenceAssetType, StoredReferenceAsset[]> = {
    spritzer: [],
    wreath: [],
    garland: [],
  };
  for (const a of all) {
    const bucket = grouped[a.asset_type];
    if (bucket && bucket.length < perType) bucket.push(a);
  }
  return [...grouped.wreath, ...grouped.spritzer, ...grouped.garland];
}
