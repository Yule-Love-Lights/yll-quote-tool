// Settings → HighLevel — one-time integration setup helper.
//
// Lists the live GoHighLevel pipelines + stage IDs for this location so the
// operator can copy them into the HIGHLEVEL_* env vars (Vercel + .env.local).
// Without these set, "Send Quote" can't advance the CRM pipeline card (the send
// route records ghl_sync_error: "HIGHLEVEL_STAGE_QUOTE_SENT / HIGHLEVEL_PIPELINE_ID
// not set"). Read-only — it never writes to GHL or to env.

import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';
import {
  isHighLevelConfigured,
  listPipelines,
  getContactDndState,
  type ContactDndState,
} from '@/lib/integrations/highlevel';
import { parsePipelines, guessAssignments, type Pipeline } from '@/lib/integrations/highlevelPipelines';
import { resolvePipelineStages, quoteLinkFieldEnvVar } from '@/lib/integrations/ghlPipelineMap';
import { SERVICE_TYPES, SERVICE_TYPE_LABELS } from '@/lib/serviceType';
import { highLevelContactUrlFromEnv } from '@/lib/highLevelLinks';
import { getSupabaseServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// The env vars the send/approve/attach/decline/inbox/referral/lead routes read,
// with what each one is for. Grouped: legacy holiday-only pipeline/stage vars
// (pre per-vertical map) → per-service-type quote-link contact fields → shared
// send-channel + internal-alert vars → website lead-capture vars (a separate
// flow from quote-send, see src/lib/leads/leadService.ts).
const ENV_VARS: { name: string; desc: string }[] = [
  { name: 'HIGHLEVEL_PIPELINE_ID', desc: 'Your Holiday Lights sales pipeline' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_CREATED', desc: 'Stage for a brand-new card the tool has to create — use your ENTRY stage (e.g. 📭 Open), never an internal stage like Make Quote' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_SENT', desc: 'Stage: quote sent to the customer ("Bid Sent")' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_APPROVED', desc: 'Stage moved to when the deposit is PAID (Valor webhook); falls back to SIGNED' },
  { name: 'HIGHLEVEL_STAGE_QUOTE_SIGNED', desc: 'Stage: contract signed' },
  { name: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY', desc: 'Contact field for the holiday quote link, merged into GHL drip texts/emails as {{contact.*}}' },
  { name: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT', desc: 'Same, for permanent quotes' },
  { name: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT', desc: 'Same, for event quotes' },
  { name: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_BISTRO', desc: 'Same, for permanent-bistro quotes' },
  { name: 'HIGHLEVEL_SMS_FROM_NUMBER', desc: 'Outbound SMS "from" number for referral, balance, approval and internal-alert texts (falls back to email if unset or no phone on file)' },
  { name: 'HIGHLEVEL_EMAIL_FROM', desc: '"From" address for the same outbound sends, and the fallback channel when SMS is unset' },
  { name: 'HIGHLEVEL_INTERNAL_CONTACT_ID', desc: 'Internal GHL contact that staff-facing alert emails send to (inbox escalations, low stock, decline, cancel, request-changes, deposit received)' },
  { name: 'HIGHLEVEL_LEADS_ALERT_CONTACT_ID', desc: 'Contact HighLevel routes lead + site-form alert emails to; falls back to HIGHLEVEL_INTERNAL_CONTACT_ID above when unset' },
  { name: 'HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK', desc: 'Contact field for a referring customer\'s personal link (stamp is skipped when unset)' },
  { name: 'HIGHLEVEL_CONTACT_FIELD_SERVICE', desc: 'Contact field written with a website lead\'s selected service' },
];

// Stage keys shared by every ServiceType's PipelineStages (pipelineId is
// handled separately since it's shown as its own row).
const STAGE_LABELS = {
  entry: 'Entry (new card)',
  sent: 'Sent',
  depositPaid: 'Deposit paid',
  installed: 'Installed',
  declined: 'Declined',
} as const;
type StageKey = keyof typeof STAGE_LABELS;

// The three-state DND health render, shared by the internal contact's row
// and the leads-alert contact's row (fix round, staff lens asked for a
// clickable fix link — added here so both rows get it, not just one).
// `unsetNote` lets the leads-alert row say something more specific than the
// internal contact's generic "not set" wording, since an unset leads-alert
// var isn't a misconfiguration on its own (it falls back to the internal
// contact) — plain copy, no "dndSettings" jargon on screen.
function DndHealthBlock({
  configured,
  contactId,
  contactUrl,
  unsetNote,
  dndState,
  dndCheckError,
}: {
  configured: boolean;
  contactId: string | undefined;
  contactUrl: string | null;
  unsetNote: string;
  dndState: ContactDndState | null;
  dndCheckError: string | null;
}) {
  if (!configured) {
    return (
      <p className="text-[11px] font-semibold text-amber-700 mt-2">Email DND: could not verify (HighLevel not connected)</p>
    );
  }
  if (!contactId) {
    return <p className="text-[11px] font-semibold text-amber-700 mt-2">Email DND: {unsetNote}</p>;
  }
  if (dndCheckError) {
    return <p className="text-[11px] font-semibold text-amber-700 mt-2">Email DND: could not verify ({dndCheckError})</p>;
  }
  if (dndState === null) {
    return (
      <p className="text-[11px] font-semibold text-amber-700 mt-2">Email DND: could not verify (contact not found in HighLevel)</p>
    );
  }
  if (dndState.emailDnd) {
    return (
      <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2">
        <p className="text-[11px] font-semibold text-red-700">
          ⚠️ Email DND is ON for this contact — every staff alert email (deposit received, approval, decline, low
          stock, inbox escalation...) is being refused by HighLevel right now.
        </p>
        <p className="text-[11px] text-red-700 mt-1">
          HighLevel: {dndState.message ?? 'no message'}
          {dndState.code ? ` (code ${dndState.code})` : ''}
        </p>
        <p className="text-[11px] text-red-700 mt-1">Fix: switch Email DND off on this contact in HighLevel.</p>
        {contactUrl ? (
          <p className="text-[11px] mt-1">
            <a href={contactUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-red-700 underline">
              Open this contact in HighLevel →
            </a>
          </p>
        ) : null}
      </div>
    );
  }
  return <p className="text-[11px] font-semibold text-green-700 mt-2">Email DND: off</p>;
}

export default async function HighLevelSettingsPage() {
  // #81 defense-in-depth — engaged by default; dormant only on the explicit
  // AUTH_GATE_ENABLED=false opt-out (ledger #347), same as the other operator
  // settings pages.
  if (authGateEngaged() && !(await getOperator())) {
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

  // 2026-09-02 incident: the internal alert contact's Email DND flipped on in
  // GHL and every staff alert email (deposit received, approval, decline...)
  // was silently refused for two days — the only prior signal was a
  // console.warn nobody was watching. Live health check, rendered inline on
  // the HIGHLEVEL_INTERNAL_CONTACT_ID row below (and, fix round, the leads-
  // alert contact's own row). Three states, all rendered (never nothing):
  // dndState.emailDnd true → red, false → a quiet green "off", and
  // unconfigured/unreachable → amber "could not verify" — a silent-empty
  // read here is exactly the class this repo has been bitten by before
  // (AGENTS.md Pitfalls, S74 geocoding).
  const internalContactId = process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  let dndState: ContactDndState | null = null;
  let dndCheckError: string | null = null;
  if (configured && internalContactId) {
    try {
      dndState = await getContactDndState(internalContactId);
    } catch (err) {
      dndCheckError = err instanceof Error ? err.message : 'Failed to check DND status';
    }
  }

  // Fix round (admin lens, row: leads-alert contact): the lead/site-form
  // alert routes (src/lib/leads/leadAlerts.ts, src/lib/siteForms/
  // siteFormAlerts.ts) read HIGHLEVEL_LEADS_ALERT_CONTACT_ID, falling back to
  // HIGHLEVEL_INTERNAL_CONTACT_ID when unset — confirmed by reading both
  // consumers, not guessed. Same DND check, run only when this var is
  // actually set (an unset var isn't its own contact — its rows are already
  // covered by the internal contact's own check above).
  const leadsAlertContactId = process.env.HIGHLEVEL_LEADS_ALERT_CONTACT_ID;
  let leadsDndState: ContactDndState | null = null;
  let leadsDndCheckError: string | null = null;
  if (configured && leadsAlertContactId) {
    try {
      leadsDndState = await getContactDndState(leadsAlertContactId);
    } catch (err) {
      leadsDndCheckError = err instanceof Error ? err.message : 'Failed to check DND status';
    }
  }

  // Fix round (admin lens): the deposit_notify_failed_at/deposit_notify_error
  // marker the Valor webhook stamps (src/app/api/integrations/valor/webhook/
  // route.ts's internalEmail()) had zero readers — it existed only to be
  // queried by hand. Surface the last 20 non-test rows right on this page, by
  // the exact same route this page already uses for everything else
  // (service-role read, server-side, no client fetch). A failed read renders
  // an amber "could not read" line, NEVER a false "none" — the check-the-
  // check pitfall this repo has been bitten by before (AGENTS.md).
  type FailedNotifyRow = {
    id: string;
    quote_number: number | null;
    customer_name: string | null;
    deposit_notify_failed_at: string;
    deposit_notify_error: string | null;
  };
  let failedNotifies: FailedNotifyRow[] = [];
  let failedNotifiesError: string | null = null;
  const sb = getSupabaseServiceClient();
  if (!sb) {
    failedNotifiesError = 'database not configured';
  } else {
    const { data, error } = await sb
      .from('quotes')
      .select('id, quote_number, customer_name, deposit_notify_failed_at, deposit_notify_error')
      .eq('is_test', false)
      .not('deposit_notify_failed_at', 'is', null)
      .order('deposit_notify_failed_at', { ascending: false })
      .limit(20);
    if (error) {
      failedNotifiesError = error.message;
    } else {
      failedNotifies = (data ?? []) as FailedNotifyRow[];
    }
  }

  // Fix round (staff lens): a direct link into HighLevel for the red DND
  // panel's fix instruction, so "open this contact" isn't a manual search.
  const internalContactUrl = highLevelContactUrlFromEnv(internalContactId ?? null);
  const leadsAlertContactUrl = highLevelContactUrlFromEnv(leadsAlertContactId ?? null);

  // Cross-check the hardcoded per-vertical pipeline map (ghlPipelineMap.ts)
  // against the live pipelines just fetched above, so a renamed/deleted
  // pipeline or stage in GHL shows up here instead of silently failing to
  // move cards (see permanent_bistro history — this happened once already).
  const havePipelineData = configured && !loadError;
  const livePipelinesById = new Map(pipelines.map((p) => [p.id, p]));
  const verticalRows = SERVICE_TYPES.map((type) => {
    // envOverrides:false — show the map's OWN ids, not holiday's legacy env
    // overrides (those are already covered by the ENV_VARS section above).
    const stages = resolvePipelineStages(type, { envOverrides: false });
    const livePipeline = livePipelinesById.get(stages.pipelineId);
    const liveStageIds = new Set(livePipeline?.stages.map((s) => s.id));
    return {
      type,
      stages,
      livePipeline,
      pipelineStale: havePipelineData && !livePipeline,
      stageRows: (Object.keys(STAGE_LABELS) as StageKey[]).map((key) => ({
        key,
        id: stages[key],
        stale: havePipelineData && !!livePipeline && !liveStageIds.has(stages[key]),
      })),
      quoteLinkEnvVar: quoteLinkFieldEnvVar(type),
    };
  });

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
                    {name === 'HIGHLEVEL_INTERNAL_CONTACT_ID' && (
                      <>
                        <DndHealthBlock
                          configured={configured}
                          contactId={internalContactId}
                          contactUrl={internalContactUrl}
                          unsetNote="could not verify (this var isn't set)"
                          dndState={dndState}
                          dndCheckError={dndCheckError}
                        />
                        {/* Fix round (admin lens): make deposit_notify_failed_at
                            readable, not write-only. Zero → a quiet one-liner;
                            some → the last 20, newest first, each linking to
                            the quote; a failed read → amber, never a false
                            "none". */}
                        <div className="mt-2 pt-2 border-t border-gray-100">
                          {failedNotifiesError ? (
                            <p className="text-[11px] font-semibold text-amber-700">
                              Failed deposit alerts: could not read ({failedNotifiesError})
                            </p>
                          ) : failedNotifies.length === 0 ? (
                            <p className="text-[11px] text-gray-500">No bookings with a failed staff alert.</p>
                          ) : (
                            <div>
                              <p className="text-[11px] font-semibold text-gray-700 mb-1">
                                Bookings whose &ldquo;deposit received&rdquo; staff alert failed ({failedNotifies.length}):
                              </p>
                              <ul className="space-y-1">
                                {failedNotifies.map((row) => (
                                  <li key={row.id} className="text-[11px] text-gray-700">
                                    <a href={`/quote/${row.id}`} className="font-semibold underline">
                                      Quote #{row.quote_number ?? row.id.slice(0, 8)}
                                    </a>{' '}
                                    · {row.customer_name ?? 'Unknown customer'} ·{' '}
                                    {new Date(row.deposit_notify_failed_at).toLocaleString('en-US', {
                                      dateStyle: 'medium',
                                      timeStyle: 'short',
                                    })}{' '}
                                    · {row.deposit_notify_error ?? 'no error recorded'}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                    {name === 'HIGHLEVEL_LEADS_ALERT_CONTACT_ID' && (
                      <DndHealthBlock
                        configured={configured}
                        contactId={leadsAlertContactId}
                        contactUrl={leadsAlertContactUrl}
                        unsetNote="not set — lead alerts fall back to the internal contact above"
                        dndState={leadsDndState}
                        dndCheckError={leadsDndCheckError}
                      />
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

        {/* Per-vertical pipeline map: the hardcoded ghlPipelineMap.ts ids, cross-checked
            against the live pipelines fetched below so a renamed/deleted GHL pipeline or
            stage shows up here instead of cards silently getting stuck. */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-3">
            Per-vertical pipeline map (code)
          </h2>
          <p className="text-xs text-gray-500 mb-3">
            Each service type&apos;s pipeline + stage ids are hardcoded in{' '}
            <code className="text-xs">src/lib/integrations/ghlPipelineMap.ts</code>, not env vars — holiday
            is the one exception, where the four legacy env vars above override the map when set.{' '}
            <span className="font-semibold text-red-600">STALE</span> means that id no longer appears in
            your live GHL pipelines below (renamed or deleted) — cards for that service type will silently
            stop moving until the map is updated.
          </p>
          <div className="space-y-3">
            {verticalRows.map(({ type, stages, livePipeline, pipelineStale, stageRows, quoteLinkEnvVar }) => (
              <div
                key={type}
                className="rounded-md border p-3"
                style={{ borderColor: 'var(--op-border)' }}
              >
                <div className="flex items-baseline justify-between gap-3 mb-2 pb-2 border-b border-gray-100">
                  <span className="text-sm font-semibold text-gray-900">{SERVICE_TYPE_LABELS[type]}</span>
                  <span className="text-right">
                    <code className="text-xs text-gray-500 font-mono break-all">{stages.pipelineId}</code>
                    {pipelineStale ? (
                      <span className="ml-2 text-[11px] font-semibold text-red-600">STALE</span>
                    ) : livePipeline ? (
                      <span className="ml-2 text-[11px] text-gray-500">→ {livePipeline.name}</span>
                    ) : null}
                  </span>
                </div>
                <ul className="space-y-1">
                  {stageRows.map(({ key, id, stale }) => (
                    <li key={key} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-gray-700">{STAGE_LABELS[key]}</span>
                      <span className="text-right">
                        <code className="text-xs text-gray-500 font-mono break-all">{id}</code>
                        {stale && <span className="ml-2 text-[11px] font-semibold text-red-600">STALE</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-gray-500 mt-2 pt-2 border-t border-gray-100">
                  Quote-link contact field: <code className="text-xs">{quoteLinkEnvVar}</code>{' '}
                  {process.env[quoteLinkEnvVar] ? (
                    <span className="font-semibold text-green-700">SET</span>
                  ) : (
                    <span className="font-semibold text-red-600">NOT SET</span>
                  )}
                </p>
              </div>
            ))}
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
      </main>
    </OperatorShell>
  );
}
