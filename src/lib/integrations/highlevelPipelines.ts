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
