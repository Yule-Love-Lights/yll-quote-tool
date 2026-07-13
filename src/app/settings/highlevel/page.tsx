// Settings → HighLevel — one-time integration setup helper.
//
// Lists the live GoHighLevel pipelines + stage IDs for this location so the
// operator can copy them into the HIGHLEVEL_* env vars (Vercel + .env.local).
// Without these set, "Send Quote" can't advance the CRM pipeline card (the send
// route records ghl_sync_error: "HIGHLEVEL_STAGE_QUOTE_SENT / HIGHLEVEL_PIPELINE_ID
// not set"). Read-only — it never writes to GHL or to env.
//
// WT-51: the env vars below only cover holiday's legacy quote-flow. Every
// service type's card actually moves via the HARDCODED map in
// ghlPipelineMap.ts — a renamed/deleted pipeline or stage there had no
// on-page diagnostic. The "Per-service-type pipeline map" section cross-
// checks each mapped id against the live pipelines fetched here and flags
// any id no longer found in the account.

import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { getOperator } from '@/lib/auth/supabaseServer';
import { isHighLevelConfigured, listPipelines } from '@/lib/integrations/highlevel';
import { parsePipelines, guessAssignments, type Pipeline } from '@/lib/integrations/highlevelPipelines';
import { listPipelineMapEntries } from '@/lib/integrations/ghlPipelineMap';
import { SERVICE_TYPE_LABELS } from '@/lib/serviceType';

export const dynamic = 'force-dynamic';

// The env vars the send/approve/attach routes read, with what each one is for.
const ENV_VARS: { name: string; desc: string }[] = [
  { name: 'HIGHLEVEL_PIPELINE_ID', desc: 'Your Holiday Lights sales pipeline' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_CREATED', desc: 'Stage for a brand-new card the tool has to create — use your ENTRY stage (e.g. 📭 Open), never an internal stage like Make Quote' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_SENT', desc: 'Stage: quote sent to the customer ("Bid Sent")' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_APPROVED', desc: 'Stage moved to when the deposit is PAID (Valor webhook); falls back to SIGNED' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_SIGNED', desc: 'Stage: contract signed' },
];

export default async function HighLevelSettingsPage() {
  // #81 defense-in-depth (dormant until AUTH_GATE_ENABLED), same as the other
  // operator settings pages.
  if (process.env.AUTH_GATE_ENABLED === 'true' && !(await getOperator())) {
    redirect('/login?from=/settings/highlevel');
  }

  const configured = isHighLevelConfigured();
  let pipelines: Pipeline[] = [];
  let loadError: string | null = null;
  if (configured) {
    try {
      pipelines = parsePipelines(await listPipelines());
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load pipelines from HighLevel';
    }
  }
  // Best-guess mapping for each env var (suggestion only — confirm below).
  const guesses = guessAssignments(pipelines);

  // WT-51: the per-service-type map (ghlPipelineMap.ts), cross-checked
  // against the live pipelines fetched above so a renamed/deleted pipeline
  // or stage is flagged here instead of failing silently at send time.
  const mapEntries = listPipelineMapEntries();
  const findLivePipeline = (id: string) => (configured ? pipelines.find((p) => p.id === id) : undefined);

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="highlevel" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">HighLevel</h1>
          <p className="text-sm text-gray-500 mt-1">
            Copy the pipeline + stage IDs below into the matching environment variables (in Vercel and{' '}
            <code className="text-xs">.env.local</code>). Until they&apos;re set, &ldquo;Send Quote&rdquo; can&apos;t move
            the customer&apos;s pipeline card.
          </p>
        </div>

        {/* Env-var slots: what to fill + what's currently set. */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-3">
            Environment variables
          </h2>
          <div className="space-y-2">
            {ENV_VARS.map(({ name, desc }) => {
              const value = process.env[name];
              const set = !!value;
              const guess = guesses[name];
              // For the pipeline var the guess label is the pipeline name; for a
              // stage var it's the stage name.
              const guessLabel = name === 'HIGHLEVEL_PIPELINE_ID' ? guess?.pipelineName : guess?.stageName;
              return (
                <div
                  key={name}
                  className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm"
                  style={{ borderColor: 'var(--op-border)' }}
                >
                  <div className="min-w-0">
                    <code className="text-xs font-semibold text-gray-800">{name}</code>
                    <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                    {guess?.value && (
                      <p className="text-[11px] text-gray-600 mt-1">
                        Best guess: <span className="font-medium">{guessLabel}</span>{' '}
                        <code className="font-mono text-gray-500 break-all">{guess.value}</code>
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {set ? (
                      <>
                        <span className="text-[11px] font-semibold text-green-700">SET</span>
                        <p className="text-xs text-gray-400 font-mono break-all mt-0.5">{value}</p>
                      </>
                    ) : (
                      <span className="text-[11px] font-semibold text-red-600">NOT SET</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Live pipelines + stage IDs from GHL. */}
        <section>
          <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-3">
            Your HighLevel pipelines
          </h2>

          {!configured && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              HighLevel isn&apos;t connected yet — set <code className="text-xs">HIGHLEVEL_API_KEY</code> and{' '}
              <code className="text-xs">HIGHLEVEL_LOCATION_ID</code> first, then reload this page to see your
              pipelines.
            </p>
          )}

          {configured && loadError && (
            <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Couldn&apos;t load pipelines: {loadError}
            </p>
          )}

          {configured && !loadError && pipelines.length === 0 && (
            <p className="text-sm text-gray-500">No pipelines found for this HighLevel location.</p>
          )}

          {configured &&
            !loadError &&
            pipelines.map((p) => (
              <div
                key={p.id}
                className="mb-4 rounded-md border p-3"
                style={{ borderColor: 'var(--op-border)' }}
              >
                <div className="flex items-baseline justify-between gap-3 mb-2 pb-2 border-b border-gray-100">
                  <span className="text-sm font-semibold text-gray-900">{p.name}</span>
                  <code className="text-xs text-gray-500 font-mono break-all">{p.id}</code>
                </div>
                <ul className="space-y-1">
                  {p.stages.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-gray-700">{s.name}</span>
                      <code className="text-xs text-gray-500 font-mono break-all">{s.id}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </section>

        {/* Per-service-type pipeline map (ghlPipelineMap.ts) — WT-51. This is
            what actually moves a card on send/decline/deposit-paid/installed
            for EVERY service type (the env vars above only override holiday's
            legacy quote-flow stages). Flags any id no longer present in the
            live pipelines fetched above. */}
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-3">
            Per-service-type pipeline map
          </h2>
          <p className="text-xs text-gray-500 mb-3">
            Hardcoded in <code className="text-xs">ghlPipelineMap.ts</code>, one entry per service type.
            Renaming or deleting a pipeline/stage in HighLevel does not update this map — it has to be
            edited in code. A row flagged <span className="font-semibold text-red-600">NOT FOUND</span>{' '}
            means cards for that service type have silently stopped moving.
          </p>
          <div className="space-y-3">
            {mapEntries.map(({ serviceType, stages }) => {
              const livePipeline = findLivePipeline(stages.pipelineId);
              const rows: { label: string; id: string }[] = [
                { label: 'Pipeline', id: stages.pipelineId },
                { label: 'Entry', id: stages.entry },
                { label: 'Sent', id: stages.sent },
                { label: 'Deposit paid', id: stages.depositPaid },
                { label: 'Installed', id: stages.installed },
                { label: 'Declined', id: stages.declined },
              ];
              return (
                <div
                  key={serviceType}
                  className="rounded-md border p-3"
                  style={{ borderColor: 'var(--op-border)' }}
                >
                  <div className="flex items-baseline justify-between gap-3 mb-2 pb-2 border-b border-gray-100">
                    <span className="text-sm font-semibold text-gray-900">
                      {SERVICE_TYPE_LABELS[serviceType]}
                    </span>
                    <span className="text-xs text-gray-500">
                      {!configured
                        ? 'unverified — HighLevel not connected'
                        : loadError
                          ? 'unverified — pipelines failed to load'
                          : (livePipeline?.name ?? 'NOT FOUND in live account')}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {rows.map(({ label, id }, i) => {
                      const canVerify = configured && !loadError;
                      const found = i === 0 ? !!livePipeline : !!livePipeline?.stages.some((s) => s.id === id);
                      return (
                        <li key={label} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-gray-700">{label}</span>
                          <span className="flex items-center gap-2">
                            <code className="text-xs text-gray-500 font-mono break-all">{id}</code>
                            {canVerify && !found && (
                              <span className="text-[11px] font-semibold text-red-600 shrink-0">
                                NOT FOUND
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </OperatorShell>
  );
}
