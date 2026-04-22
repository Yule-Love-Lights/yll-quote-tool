import { getSupabaseClient } from './supabase';
import { LineSegment, MiniLightDetection, PhotoAnalysisResult } from './photoAnalysis';

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
};

export async function saveCorrection(payload: CorrectionPayload): Promise<{ id: string } | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('photo_corrections')
    .insert({
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
    })
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
