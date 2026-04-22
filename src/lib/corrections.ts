import { getSupabaseClient } from './supabase';
import {
  GarlandDetection,
  LineSegment,
  MiniLightDetection,
  PhotoAnalysisResult,
  SpritzerDetection,
  WreathDetection,
} from './photoAnalysis';

export type CorrectionPayload = {
  photoBase64: string;
  photoMediaType: string;
  originalAnalysis: PhotoAnalysisResult;
  correctedSantasFootage: number;
  correctedSantasDifficulty: 'easy' | 'medium' | 'hard';
  correctedSantasLines: LineSegment[];
  correctedGingerbreadFootage: number;
  correctedGingerbreadDifficulty: 'easy' | 'medium' | 'hard';
  correctedGingerbreadLines: LineSegment[];
  correctedMiniLightDetections: MiniLightDetection[];
  // New fields (optional for backwards compat with older clients):
  correctedC9Lines?: LineSegment[];
  correctedWinterWonderlandFootage?: number;
  correctedSatelliteSantasLines?: LineSegment[];
  correctedSatelliteGingerbreadLines?: LineSegment[];
  correctedSatelliteC9Lines?: LineSegment[];
  correctedWreathDetections?: WreathDetection[];
  correctedSpritzerDetections?: SpritzerDetection[];
  correctedGarlandDetections?: GarlandDetection[];
  notes?: string;
};

export type StoredCorrection = {
  id: string;
  photo_base64: string;
  photo_media_type: string;
  original_analysis: PhotoAnalysisResult;
  corrected_santas_footage: number;
  corrected_santas_difficulty: 'easy' | 'medium' | 'hard';
  corrected_santas_lines: LineSegment[];
  corrected_gingerbread_footage: number;
  corrected_gingerbread_difficulty: 'easy' | 'medium' | 'hard';
  corrected_gingerbread_lines: LineSegment[];
  corrected_mini_light_detections: MiniLightDetection[];
  corrected_c9_lines?: LineSegment[] | null;
  corrected_winter_wonderland_footage?: number | null;
  corrected_satellite_santas_lines?: LineSegment[] | null;
  corrected_satellite_gingerbread_lines?: LineSegment[] | null;
  corrected_satellite_c9_lines?: LineSegment[] | null;
  corrected_wreath_detections?: WreathDetection[] | null;
  corrected_spritzer_detections?: SpritzerDetection[] | null;
  corrected_garland_detections?: GarlandDetection[] | null;
};

export async function saveCorrection(payload: CorrectionPayload): Promise<{ id: string } | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  // Build insert payload — only include new columns when the caller
  // supplied them, so the query still matches whatever subset of columns
  // exists in photo_corrections (see migrations/2026-04-22-add-correction-fields.sql).
  const row: Record<string, unknown> = {
    photo_base64: payload.photoBase64,
    photo_media_type: payload.photoMediaType,
    original_analysis: payload.originalAnalysis,
    corrected_santas_footage: payload.correctedSantasFootage,
    corrected_santas_difficulty: payload.correctedSantasDifficulty,
    corrected_santas_lines: payload.correctedSantasLines,
    corrected_gingerbread_footage: payload.correctedGingerbreadFootage,
    corrected_gingerbread_difficulty: payload.correctedGingerbreadDifficulty,
    corrected_gingerbread_lines: payload.correctedGingerbreadLines,
    corrected_mini_light_detections: payload.correctedMiniLightDetections,
    notes: payload.notes ?? null,
  };
  if (payload.correctedC9Lines !== undefined) row.corrected_c9_lines = payload.correctedC9Lines;
  if (payload.correctedWinterWonderlandFootage !== undefined) row.corrected_winter_wonderland_footage = payload.correctedWinterWonderlandFootage;
  if (payload.correctedSatelliteSantasLines !== undefined) row.corrected_satellite_santas_lines = payload.correctedSatelliteSantasLines;
  if (payload.correctedSatelliteGingerbreadLines !== undefined) row.corrected_satellite_gingerbread_lines = payload.correctedSatelliteGingerbreadLines;
  if (payload.correctedSatelliteC9Lines !== undefined) row.corrected_satellite_c9_lines = payload.correctedSatelliteC9Lines;
  if (payload.correctedWreathDetections !== undefined) row.corrected_wreath_detections = payload.correctedWreathDetections;
  if (payload.correctedSpritzerDetections !== undefined) row.corrected_spritzer_detections = payload.correctedSpritzerDetections;
  if (payload.correctedGarlandDetections !== undefined) row.corrected_garland_detections = payload.correctedGarlandDetections;

  const { data, error } = await supabase
    .from('photo_corrections')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.error('saveCorrection error:', JSON.stringify(error), error?.message, error?.details, error?.hint);
    return null;
  }
  return { id: data.id };
}

export async function getRecentCorrections(limit = 3): Promise<StoredCorrection[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('photo_corrections')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('getRecentCorrections error:', error);
    return [];
  }
  return (data ?? []) as StoredCorrection[];
}

// Lightweight list for the admin review page — skips the large photo_base64
// column so the index page loads fast even with 100+ rows. Detail fetch
// still returns the full record via getCorrection().
export type CorrectionListItem = Omit<StoredCorrection, 'photo_base64' | 'original_analysis'> & {
  created_at: string;
  notes: string | null;
};

export async function listCorrections(limit = 200): Promise<CorrectionListItem[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('photo_corrections')
    .select('id, created_at, photo_media_type, corrected_santas_footage, corrected_santas_difficulty, corrected_santas_lines, corrected_gingerbread_footage, corrected_gingerbread_difficulty, corrected_gingerbread_lines, corrected_mini_light_detections, corrected_c9_lines, corrected_winter_wonderland_footage, corrected_satellite_santas_lines, corrected_satellite_gingerbread_lines, corrected_satellite_c9_lines, corrected_wreath_detections, corrected_spritzer_detections, corrected_garland_detections, notes')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listCorrections error:', error);
    return [];
  }
  return (data ?? []) as CorrectionListItem[];
}

export async function getCorrection(id: string): Promise<StoredCorrection | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('photo_corrections')
    .select('*')
    .eq('id', id)
    .single();
  if (error) {
    console.error('getCorrection error:', error);
    return null;
  }
  return data as StoredCorrection;
}

export async function deleteCorrection(id: string): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  const { error } = await supabase.from('photo_corrections').delete().eq('id', id);
  if (error) {
    console.error('deleteCorrection error:', error);
    return false;
  }
  return true;
}
