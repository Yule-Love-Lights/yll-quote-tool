// #110 W5-014 (refactor): the ~30-line "assemble few-shot → analyzePhoto →
// result/analysisError/fewShotCount/breakdown" block was duplicated near-
// verbatim across analyze-photo/route.ts and analyze-address/route.ts. The
// only real delta between the two callers is which options (satellite, mode)
// they pass through to analyzePhoto — everything else (the try/catch fail-
// safe shape, the returned metadata) is identical. Extracted here so both
// routes call one function instead of maintaining two copies.

import { analyzePhoto, ANALYZER_UNAVAILABLE_MESSAGE, type AnalyzeOptions, type PhotoAnalysisResult } from './photoAnalysis';
import { assembleFewShot } from './fewShot';

export type AnalyzeWithFewShotResult = {
  result: PhotoAnalysisResult | null;
  analysisUnavailable: boolean;
  analysisError: string | undefined;
  fewShotCount: number;
  // `degraded` = similarity was expected (Voyage configured + a query image
  // present) but fell back to recency anyway (a likely Voyage outage, not
  // the benign small-library/unconfigured case). Carried through from
  // assembleFewShot's breakdown so callers can tell the two apart (WT-33).
  fewShotBreakdown: { ranking?: 'similarity' | 'recency'; degraded?: boolean } | undefined;
};

// FAIL-SAFE (analyzer outage): if Claude/few-shot assembly fails, callers still
// get their photo/imagery back (they hold `base64`/`mediaType` themselves) —
// this only ever returns result: null + a user-facing message, never throws.
export async function runAnalyzeWithFewShot(
  base64: string,
  mediaType: string,
  houseStyleHint: string | undefined,
  options: Omit<AnalyzeOptions, 'houseStyleHint' | 'corpusBiasNote'>,
  logPrefix: string,
): Promise<AnalyzeWithFewShotResult> {
  let result: PhotoAnalysisResult | null = null;
  let analysisError: string | undefined;
  let fewShotCount = 0;
  let fewShotBreakdown: { ranking?: 'similarity' | 'recency' } | undefined;
  try {
    const { examples, references, biasNote, breakdown } = await assembleFewShot(
      houseStyleHint,
      { base64, mediaType },
    );
    result = await analyzePhoto(base64, mediaType, examples, {
      ...options,
      references,
      houseStyleHint,
      corpusBiasNote: biasNote,
    });
    fewShotCount = examples.length;
    fewShotBreakdown = breakdown;
  } catch (err) {
    console.error(`${logPrefix} AI analysis failed — returning photo for manual design:`, err);
    analysisError = ANALYZER_UNAVAILABLE_MESSAGE;
  }
  return { result, analysisUnavailable: result === null, analysisError, fewShotCount, fewShotBreakdown };
}
