// #190 (prod incident, quote ef73b2de): QuoteBuilder's applyAnalysisResult
// used to gate its satellite-state application on whether the AI's result
// carried non-empty satelliteSantasLines/satelliteGingerbreadLines. But a
// street-photo-only analysis (/api/analyze-photo — reanalyzeCurrent + the
// manual-upload handler) shows the model ONE image and no satellite, yet its
// output schema always asks for those two line arrays — the model can (and
// did) hallucinate coordinates for a satellite image it never saw. Gating on
// "lines present" then let a street-only re-analyze null out a live
// satellite scale (satelliteFeetPerPixel) and stomp good seeded lines with
// fabricated ones.
//
// The fix: satellite evidence is the SCALE/IMAGE, not the lines. Only an
// actual satellite payload (the base64 image or its known feet-per-pixel
// scale — both of which only ever come from /api/analyze-address, which
// pulls real Google Static Maps imagery) counts as "this analysis carried
// satellite data." Extracted as a pure predicate so the decision is
// unit-testable without rendering QuoteBuilder.
export function hasSatellitePayload(data: {
  satelliteBase64?: string | null;
  satelliteFeetPerPixel?: number | null;
}): boolean {
  return data.satelliteBase64 != null || data.satelliteFeetPerPixel != null;
}
