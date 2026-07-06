// Pure parser for the GHL /opportunities/pipelines response, used by the
// Settings → HighLevel setup page to surface pipeline + stage IDs so the
// operator can fill the HIGHLEVEL_* env vars. Kept separate from the API client
// (highlevel.ts) so it's testable without network/env.
//
// GHL shape: { pipelines: [{ id, name, stages: [{ id, name, position }] }] }

export type PipelineStage = { id: string; name: string };
export type Pipeline = { id: string; name: string; stages: PipelineStage[] };

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback;

export function parsePipelines(raw: unknown): Pipeline[] {
  const pipelines = (raw as { pipelines?: unknown } | null)?.pipelines;
  if (!Array.isArray(pipelines)) return [];
  return pipelines.map((p) => {
    const pp = p as { id?: unknown; name?: unknown; stages?: unknown };
    const stages = Array.isArray(pp.stages) ? pp.stages : [];
    return {
      id: str(pp.id),
      name: str(pp.name, '(unnamed)'),
      stages: stages.map((s) => {
        const ss = s as { id?: unknown; name?: unknown };
        return { id: str(ss.id), name: str(ss.name, '(unnamed)') };
      }),
    };
  });
}

// ─── Best-guess env-var mapping ────────────────────────────────────────────
// Suggest which pipeline + stage each HIGHLEVEL_* env var should point to, by
// matching stage names against keyword hints. A SUGGESTION only — the operator
// confirms against their real pipeline (stage names vary, and future perm/event
// pipelines will need their own mapping). The tool is Christmas-only for now, so
// the primary pipeline is the one named like "Christmas" (but not "Commercial").

export type Guess = { pipelineName: string | null; stageName: string | null; value: string | null };

const PRIMARY_INCLUDE = 'christmas';
const PRIMARY_EXCLUDE = 'commercial';

// Ordered keyword hints per stage env var — first keyword that matches a stage
// (in order) wins, so more-specific phrases come first.
// QUOTE_CREATED is the stage the tool uses when it has to CREATE a brand-new card
// (contact had none) — it must be the pipeline's ENTRY stage (e.g. "Open"), NEVER
// an internal stage like "Make Quote".
const STAGE_HINTS: { envVar: string; keywords: string[] }[] = [
  { envVar: 'HIGHLEVEL_STAGE_QUOTE_CREATED', keywords: ['new lead', 'open'] },
  { envVar: 'HIGHLEVEL_STAGE_QUOTE_SENT', keywords: ['bid sent', 'sent'] },
  { envVar: 'HIGHLEVEL_STAGE_QUOTE_APPROVED', keywords: ['approved'] },
  { envVar: 'HIGHLEVEL_STAGE_QUOTE_SIGNED', keywords: ['approved', 'signed', 'booked'] },
];

export function guessAssignments(pipelines: Pipeline[]): Record<string, Guess> {
  const primary =
    pipelines.find((p) => {
      const n = p.name.toLowerCase();
      return n.includes(PRIMARY_INCLUDE) && !n.includes(PRIMARY_EXCLUDE);
    }) ??
    pipelines[0] ??
    null;

  const out: Record<string, Guess> = {
    HIGHLEVEL_PIPELINE_ID: primary
      ? { pipelineName: primary.name, stageName: null, value: primary.id }
      : { pipelineName: null, stageName: null, value: null },
  };

  for (const hint of STAGE_HINTS) {
    let match: PipelineStage | undefined;
    if (primary) {
      for (const kw of hint.keywords) {
        match = primary.stages.find((s) => s.name.toLowerCase().includes(kw));
        if (match) break;
      }
    }
    out[hint.envVar] = match
      ? { pipelineName: primary!.name, stageName: match.name, value: match.id }
      : { pipelineName: primary?.name ?? null, stageName: null, value: null };
  }
  return out;
}
