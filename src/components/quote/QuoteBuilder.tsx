'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import Link from 'next/link';
import type {
  QuoteResult,
  QuoteInputs,
  CustomLineItem,
  RooflineChoice,
} from '@/lib/pricing/pricingEngine';
import { BUSINESS_RULES, NCE_DEPOSIT_PERCENT, resolveLineItemLabel } from '@/lib/pricing/pricingEngine';
import { buildPortalLineItems, BILLED_ROOFLINE_IDS, PERMANENT_RECOMMEND_FIELDS } from '@/lib/portal/adapter';
import { attachSceneLinks } from '@/lib/portal/sceneLinks';
import { extraPhotoLabels, photoLabelForLine } from '@/lib/design/photoLabels';
import type { PortalLineItem } from '@/components/portal/types';
import type { Scene } from '@/lib/design/sceneTypes';
import {
  type QuoteFormData,
  type FormCustomer,
  type StoredCustomer,
  type DifficultyChoice,
  type QuoteBuilderPrefill,
  initialFormData,
  buildQuoteInputs,
  inputsToFormData,
  applyPrefill,
  resolveTagPayload,
  resolveNceDepositPercent,
  shouldClaimNceDepositProvenance,
  nceTagDepositWasSuppressed,
  clearHolidayOnlyDiscountState,
  clearNceOrNeighborOnServiceTypeSwitch,
  legacyRebookConfirmMessage,
  nceConfirmMessage,
  contactRelinkConfirmMessage,
  clearContactConfirmMessage,
  initialNceDepositProvenance,
} from '@/lib/quoteForm';
import type { CrmContact } from '@/lib/integrations/types';
import {
  type ServiceType,
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  canCarryNceOrYllNeighborTag,
} from '@/lib/serviceType';
import { deriveStatus, APPROVED_DISPLAYS_AS, wasEverApproved, isMigratedQuote, type QuoteStatus } from '@/lib/quoteStatus';
import { MigratedBadge } from '@/components/admin/MigratedBadge';
import { EventSection } from './EventSection';
import { OperatorShell } from '@/components/OperatorShell';
import HighLevelContactAutocomplete from '@/components/admin/HighLevelContactAutocomplete';
// YllNeighborBadge/NceBadge (the read-only admin-surface pills) are NOT used
// here (#198): the builder's own tag chips below are interactive buttons with
// builder-specific title text, not those components' migration-specific
// copy — see the chip strip's own comment.
import { ReferredByPicker } from '@/components/quote/ReferredByPicker';
import { ReferralPrefillNotice } from '@/components/quote/ReferralPrefillNotice';
import { QuoteBuilderCallNotesDrawer } from '@/components/quote/QuoteBuilderCallNotesDrawer';
import { ReferralCreditBanner } from '@/components/quote/ReferralCreditBanner';
import { ReferralSpritzerBanner } from '@/components/quote/ReferralSpritzerBanner';
import dynamic from 'next/dynamic';

import DesignSummary from '@/components/quote/DesignSummary';
import PermanentSection from '@/components/quote/PermanentSection';
import type { AnalysisSeed } from '@/lib/design/seedFromAnalysis';
import { hasSatellitePayload } from '@/lib/design/analysisSatellitePayload';
import { deriveSideMeasure } from '@/lib/permanent/satelliteMeasure';
import { roundFootageUpTo5 } from '@/lib/permanent/types';
import { polylineLengthAspectUnits as polylineLength } from '@/lib/design/polylineFootage';
import { deriveTrackAccessories, hasAccessorySignal } from '@/lib/permanent/trackAccessories';
import {
  reconcilePermanentSideField,
  derivePermanentSideFootageBaseline,
  mergePermanentSideFootageBaseline,
  type PermanentSideFootageBaseline,
  type PermanentSideFieldKey,
  type PermanentSideFieldReconcileResult,
} from '@/lib/permanent/reconcileSideFootage';
import {
  reconcileBistroFootage,
  deriveBistroFootageMap,
  roundBistroFootageOnBlur,
} from '@/lib/permanentBistro/reconcileFootage';
import {
  reconcileHolidayFootageField,
  deriveHolidayFootageBaseline,
  mergeHolidayFootageBaseline,
  reconcileAnalysisFootage,
  type HolidayFootageBaseline,
  type HolidayFootageFieldKey,
  type HolidayFieldReconcileResult,
} from '@/lib/holidayFootage/reconcileFootage';
import { isStrand, isLinkedTwin, type Surface } from '@/lib/design/sceneTypes';
import { useImageZoomPan } from '@/lib/useImageZoomPan';
import { offeredFromLists, offeredIsKnown, type OfferedColorLists } from '@/lib/inventory/resolveInstalls';
import { detectUnfulfillable } from '@/lib/inventory/detectUnfulfillable';
import { track } from '@/lib/analytics/posthog';
import { loadQuoteDraft, saveQuoteDraft, clearQuoteDraft, customerIsEmpty, draftAutosaveActive } from '@/lib/quoteDraft';
import { loadQuoteEditDraft, saveQuoteEditDraft, clearQuoteEditDraft, sweepQuoteEditDrafts, formatDraftAge, quoteEditDraftLifecycle, type QuoteEditDraft } from '@/lib/quoteEditDraft';
import { stableStringify, quoteHasUnsavedEdits } from '@/lib/quoteDirty';
import { permanentSideOverriddenFields, describePermanentSideField } from '@/lib/permanent/reconcileSideFootage';
import { downscaleForUpload, downscaleForUploadAsBlob, readUploadErrorMessage } from '@/lib/clientImage';
import {
  parkSatelliteContext,
  persistSatelliteMeasurements,
  saveAnalysisContext,
  satelliteContextAfterPhotoChange,
  satelliteLinesHaveContent,
  type DesignAnalysisContext,
  type InFlightSatelliteSave,
} from '@/components/quote/persistSatelliteMeasurements';
// Row 269: pure, client-safe helpers shared with PipelineActionsMenu.tsx —
// pipelineSendOutcome.ts has zero imports of its own (no React, no
// Supabase), so pulling it in here does not drag anything server-only into
// this bundle. See that file's own comment for why it deliberately does NOT
// import quoteDeliveries.ts's DELIVERY_TIMEOUT_ERROR_PREFIX directly.
import {
  classifyChannelOutcome,
  isTimeoutHedgedFailure,
  retryOfferFor,
  type ChannelDeliveryClassification,
  type RetryGate,
} from '@/components/admin/pipelineSendOutcome';
import {
  createQuoteBuildTimerClient,
  quoteBuildTimerEligible,
  shouldStartPrefilledQuoteTimer,
} from '@/lib/quoteBuildTimerClient';

// The Konva design editor touches the DOM/canvas, so load it client-only.
const DesignEditor = dynamic(() => import('@/components/design/DesignEditor'), { ssr: false });

// ─── Shared CSS constants ────────────────────────────────────────────────────

const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500';
const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';
const addBtn = 'mt-1 text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5 transition-colors';
const rmBtn = 'text-red-400 hover:text-red-600 font-bold text-xl leading-none mt-0.5';
// Client-side mirror of trainingExamples.ts's sanitizeNotes cap — the server
// re-caps regardless, this just stops the box from accepting more than it
// can keep so staff aren't surprised by a silent truncation.
const TRAINING_NOTE_MAX_LEN = 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// #104: a per-quote TOTAL override and the #102 custom $/ft on the SAME line
// (roofline / Winter Wonderland / Stake) are mutually exclusive (last-write-wins,
// surfaced in the UI). These maps link a line's stable override id ⇄ that type's
// $/ft form fields so setting one clears the other. Per-unit lines have no $/ft,
// so they're absent (no clearing).
type RateFieldKeys = {
  diffKey: 'santasDifficulty' | 'gingerbreadDifficulty' | 'winterWonderlandDifficulty' | 'stakeLightingDifficulty';
  rateKey: 'santasCustomRate' | 'gingerbreadCustomRate' | 'winterWonderlandCustomRate' | 'stakeLightingCustomRate';
  fallback: DifficultyChoice;
};
const OVERRIDE_ID_TO_RATE: Record<string, RateFieldKeys> = {
  // Roofline falls back to the ONE shared starting value (Easy $8/ft) — see
  // BUSINESS_RULES.rooflineDefaultDifficulty. WW keeps 'medium', stake 'easy'.
  'roofline-santas': { diffKey: 'santasDifficulty', rateKey: 'santasCustomRate', fallback: BUSINESS_RULES.rooflineDefaultDifficulty },
  'roofline-gingerbread': { diffKey: 'gingerbreadDifficulty', rateKey: 'gingerbreadCustomRate', fallback: BUSINESS_RULES.rooflineDefaultDifficulty },
  'winter-wonderland': { diffKey: 'winterWonderlandDifficulty', rateKey: 'winterWonderlandCustomRate', fallback: 'medium' },
  'stake-lighting': { diffKey: 'stakeLightingDifficulty', rateKey: 'stakeLightingCustomRate', fallback: 'easy' },
};
const RATE_KEY_TO_OVERRIDE_ID: Record<string, string> = {
  santasCustomRate: 'roofline-santas',
  gingerbreadCustomRate: 'roofline-gingerbread',
  winterWonderlandCustomRate: 'winter-wonderland',
  stakeLightingCustomRate: 'stake-lighting',
};

// #104: click-to-edit a breakdown line's TOTAL (per-quote override). Shows the
// price as a button; click → inline number field; Enter/blur commits, Esc cancels.
// When overridden, a "custom · was $X ✕" chip shows the computed baseline + resets.
// stopPropagation/preventDefault so it never toggles a recommendable row's <label>.
function EditablePrice({
  amount,
  baseAmount,
  overridden,
  disabled,
  lockedReason,
  onCommit,
  onReset,
}: {
  amount: number;
  baseAmount: number;
  overridden: boolean;
  disabled: boolean;
  // Row 331: when set, `disabled` is true BECAUSE the quote is past approval
  // (not merely `loading`) — shown as the click target's title instead of the
  // normal "click to edit" hint, so the disabled state explains itself rather
  // than reading as a stuck/broken control.
  lockedReason?: string;
  onCommit: (n: number) => void;
  onReset: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const start = () => {
    if (disabled) return;
    setVal(String(amount));
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const n = Number(val);
    if (Number.isFinite(n) && n >= 0 && n !== amount) onCommit(n);
  };
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <span className="text-gray-400">$</span>
        <input
          autoFocus
          type="number"
          min="0"
          step="1"
          className="w-24 border border-green-400 rounded px-1.5 py-0.5 text-sm text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-green-500"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </span>
    );
  }
  // Only claim a "was $X" when we have a DISTINCT computed baseline. On reopening a
  // saved quote the baseline seeds from the (overridden) saved result, so
  // baseAmount === amount until the next Calculate — show a plain "custom" chip
  // then, not a misleading "was <the override itself>" (#104 review, low).
  const showBase = baseAmount !== amount;
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {overridden && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onReset();
          }}
          disabled={disabled}
          title={
            // Premerge finding 5 fix: when disabled BECAUSE of the freeze
            // (lockedReason set), explain that instead of the normal reset
            // hint — mirrors the main price button's own lockedReason ??
            // fallback a few lines below, which this reset button had been
            // missing.
            disabled && lockedReason
              ? lockedReason
              : showBase
                ? `Custom price for this quote — reset to ${usd(baseAmount)}`
                : 'Custom price for this quote — reset'
          }
          className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 hover:text-amber-800 disabled:opacity-40 cursor-pointer"
        >
          custom{showBase ? ` · was ${usd(baseAmount)}` : ''} ✕
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          start();
        }}
        disabled={disabled}
        title={lockedReason ?? 'Click to set a custom price for this quote'}
        className={`font-medium tabular-nums rounded px-1 -mx-1 hover:bg-green-50 disabled:cursor-not-allowed cursor-text ${
          overridden ? 'text-amber-700' : 'text-gray-900'
        }`}
      >
        {usd(amount)}
      </button>
    </span>
  );
}

// item-numbering-rename: click-to-rename a breakdown line's DISPLAY label
// (per-quote override). Mirrors EditablePrice's idiom — shows the current
// label as a button; click → inline text field; Enter/blur commits, Esc
// cancels. Clearing the field (blank/whitespace) resets instead of
// committing an empty override. When overridden, a "custom · was "X" ✕" chip
// shows the baseline + resets — same idiom, price parity (staff-lens MED).
// stopPropagation/preventDefault so it never toggles a recommendable row's
// <label> (same reason as EditablePrice).
//
// `baseLabel` is the ENGINE's current default (item.label, pre-resolution —
// the caller passes it straight from the closure, unlike EditablePrice's
// baseAmount which needs a separate overrides-stripped recompute
// (baselineResult) because price has no cheaper source of truth). Unlike
// price, this is never stale/reopen-seeded: item.label is recomputed by
// calculateQuote on every render from the CURRENT scene, so if a sibling
// duplicate was renamed away and this item un-numbered (Jason's numbering-
// interplay ruling), the "was" chip already shows the NEW bare label reset
// would actually produce right now — not a frozen historical string.
function EditableLabel({
  label,
  baseLabel,
  overridden,
  disabled,
  lockedReason,
  onCommit,
  onReset,
}: {
  label: string;
  baseLabel: string;
  overridden: boolean;
  disabled: boolean;
  // Row 331: mirrors EditablePrice's lockedReason exactly.
  lockedReason?: string;
  onCommit: (s: string) => void;
  onReset: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const start = () => {
    if (disabled) return;
    setVal(label);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      if (overridden) onReset();
      return;
    }
    if (trimmed !== label) onCommit(trimmed);
  };
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          type="text"
          maxLength={200}
          className="min-w-[8rem] border border-green-400 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-500"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </span>
    );
  }
  // Only claim a "was X" when we have a DISTINCT baseline — mirrors
  // EditablePrice's showBase guard exactly (same reasoning: if label already
  // equals baseLabel there's nothing to contrast, show a plain "custom" chip).
  const showBase = baseLabel !== label;
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {overridden && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onReset();
          }}
          disabled={disabled}
          title={
            // Premerge finding 5 fix (sibling parity with EditablePrice's
            // identical fix): explain the freeze when that's why it's
            // disabled, instead of the normal reset hint.
            disabled && lockedReason
              ? lockedReason
              : showBase
                ? `Custom name for this quote — reset to "${baseLabel}"`
                : 'Custom name for this quote — reset'
          }
          className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 hover:text-amber-800 disabled:opacity-40 cursor-pointer"
        >
          custom{showBase ? ` · was "${baseLabel}"` : ''} ✕
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          start();
        }}
        disabled={disabled}
        title={lockedReason ?? 'Click to rename this item for this quote'}
        className={`rounded px-1 -mx-1 hover:bg-green-50 disabled:cursor-not-allowed cursor-text ${
          overridden ? 'text-amber-700 font-medium' : ''
        }`}
      >
        {label}
      </button>
    </span>
  );
}

// A measurement polyline on the satellite image (normalized 0–1 coords).
// #82 2c: `feature` is the AI's per-segment physical roof feature (mirrors
// photoAnalysis RoofFeatureClass), carried into the seed so roofline strands
// get a roofFeature for the inventory clip engine.
type LineSegment = { points: [number, number][]; label: string; feature?: 'gutter' | 'peak' | 'side' | 'ridge' | 'metal'; id?: string };

// Satellite image is always 640x640 at zoom=20 from Static Maps.
const SAT_PX = 640;

// polylineLength moved to src/lib/design/polylineFootage.ts
// (polylineLengthAspectUnits, imported below as polylineLength) — 2026-08-24
// consolidation: this was one of THREE hand-written copies of the same
// "sum each segment's scaled Pythagorean distance" loop across the repo.
// Verified byte-for-byte parity (raw value + both rounding conventions this
// file uses) with the old local formula across every training_examples row
// with a valid satellite scale before this swap (see the PR body). Behavior
// here is UNCHANGED — same signature, same formula, same call sites.

// #255: mini-group surface labels for the pruned-group warning — matches the
// wording editor.ts's own pruneOrphanedMiniGroupsNotify toast uses
// (editor-core/editor.ts MINI_SURFACE_LABELS), kept as a separate copy here
// rather than importing from editor-core (vendored/relay-shared; this display
// string doesn't belong in that surface).
// #741 defect 4: typed exhaustive over Surface (not the loose Record<string,
// string> this started as) so adding a new Surface value fails `tsc` right
// here instead of silently rendering "group" in whichever copy (this one or
// editor.ts's) got missed. Only bush/tree/column/railing/curtain can ever
// actually reach a MiniGroupItem's `surface`, but Surface is the one shared
// type — the roofline/C9 entries below are unreachable in practice, present
// only so the object literal type-checks as complete.
const MINI_SURFACE_LABELS: Record<Surface, string> = {
  bush: 'Bush', tree: 'Tree', column: 'Column', railing: 'Railing', curtain: 'Curtain',
  'santas-roofline': 'Roofline', gingerbread: 'Gingerbread', 'winter-wonderland': 'Winter Wonderland',
  'stake-lighting': 'Stake Lighting',
};
function miniSurfaceLabel(surface: string | null): string {
  return surface && surface in MINI_SURFACE_LABELS ? MINI_SURFACE_LABELS[surface as Surface] : 'group';
}

// SHADOW MODE (deterministic-satellite-footage): copy for a roofline whose
// model-stated satellite footage disagrees >25% with what its own drawn
// lines measure. The live-corpus measurement (scripts/satellite-footage-report.ts)
// shows the model's STATED number is currently the more accurate of the two
// — the drawn-line computation is noisy — so this reads as a "double-check
// the lines" flag, never as "trust the computed number instead."
function formatSatelliteDisagreement(label: string, statedFt: number | string, computedFt: number): string {
  return (
    `Heads up: the AI's ${label} footage (${statedFt}ft) does not match its own drawn satellite lines ` +
    `(about ${computedFt}ft). Its stated number is usually the more reliable of the two. Worth a quick ` +
    `look at the drawn lines before sending.`
  );
}

// Row 269 fix round FIX 2 (two-lens MED — dishonest null-case copy): renders
// one channel's classified delivery status for the already-sent notice below
// — see alreadySentChannels' own state comment for where these
// classifications come from (classifyChannelOutcome, pipelineSendOutcome.ts).
//
// The old 'unknown' wording ("X delivery is unconfirmed") asserted an
// ATTEMPT was made and merely unverified — false in two very common real
// cases: (a) a deliberately single-channel send (sendActions() in
// pipelineActions.ts offers independent "Send email"/"Send text" actions,
// and the send route returns before logQuoteDelivery for whichever channel
// wasn't requested, so that channel has zero rows forever); (b) delivery
// logging only began 2026-08-12 (#250) — a majority of quotes sent before
// that date have no delivery rows at all despite having gone out. `hadAttempt`
// (set at the call site below from whether channelOutcomes had a non-null
// entry for this channel, not a new piece of component state — same
// alreadySentChannels object, one more field) distinguishes that genuine
// "nothing on record" case from a timeout-hedged 'failed' row, which really
// IS "attempted, outcome unknown" (classifyChannelOutcome folds both into
// the same 'unknown' classification — see that function's own doc comment
// for why — so classification alone can't tell them apart).
function channelDeliveryPhrase(
  label: string,
  info: { classification: ChannelDeliveryClassification; at: string | null; hadAttempt: boolean } | undefined,
): string {
  if (!info) return `${label} has no delivery on record`;
  if (info.classification === 'delivered') {
    const dateStr = info.at ? new Date(info.at).toLocaleDateString() : null;
    // Row 269 fix round FIX 2: was "was delivered" — outcome:'sent' only
    // means GHL's API accepted the request without throwing; there is no
    // delivery RECEIPT anywhere in this codebase. Reworded to claim only
    // what's actually true.
    return `${label} went out${dateStr ? ` ${dateStr}` : ''}`;
  }
  if (info.classification === 'failed') return `${label} failed`;
  // Row 269 fix round 2 (delta-verify HIGH, found while widening the
  // upstream invariant): was "timed out (outcome unknown — may have gone
  // through anyway)", naming a specific cause. The upstream hedge this
  // classification is built from (isTimeoutHedgedFailure, pipelineSendOutcome
  // .ts) is no longer timeout-exclusive — a socket reset, DNS failure, or
  // connection refused all get the identical 'unknown' classification now
  // (see classifyChannelOutcome's doc comment) — so this string can no longer
  // claim the cause was specifically a timeout.
  return info.hadAttempt
    ? `${label} — outcome unknown (may have gone through anyway)`
    : `${label} has no delivery on record`;
}

// Row 269 fix round FIX 4 (technical MED — unchecked `as` cast at the
// response boundary): the alreadySent handler used to do
// `data.channelOutcomes as {...} | undefined` with zero runtime validation,
// inconsistent with this SAME function's sibling failedChannels handling
// (Array.isArray(...).filter(...) a few lines above it). Not reachable in
// normal operation today — the route only ever writes this exact shape —
// but if `error` were ever a truthy non-string, isTimeoutHedgedFailure's
// `.includes` call would throw a TypeError inside the try block and turn a
// benign "already sent" response into a hard "Send failed: ...
// .includes is not a function" with no retry affordance at all. Mirrors
// sanitizePrunedMiniGroups above: defense-in-depth + consistency with the
// neighbouring code, not a schema library.
function parseChannelOutcomeEntry(raw: unknown): { outcome: 'sent' | 'failed'; error: string | null; at: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.outcome !== 'sent' && r.outcome !== 'failed') return null;
  if (typeof r.error !== 'string' && r.error !== null) return null;
  if (typeof r.at !== 'string') return null;
  return { outcome: r.outcome, error: r.error, at: r.at };
}
// #741 defect 5: prunedMiniGroups previously trusted `Array.isArray` alone,
// then the render below dereferences g.surface/g.stringCount per element — a
// malformed element (from either the seed-analysis or photo-delete response)
// would throw and crash the whole builder render. Sibling
// garlandSectionsUnestimated uses a typeof guard with a safe fallback; give
// this the same element-shape parity instead of trusting the array's contents.
function sanitizePrunedMiniGroups(raw: unknown): { surface: string | null; stringCount: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((g): g is { surface: string | null; stringCount: number } => {
    if (typeof g !== 'object' || g === null) return false;
    const r = g as Record<string, unknown>;
    return (typeof r.surface === 'string' || r.surface === null) && typeof r.stringCount === 'number';
  });
}

// Permanent Lighting (#88 / S23): the four house sides traced on the satellite
// view. Colors match the portal's satellite groups (lib/portal/satelliteLines).
const PERMANENT_SIDES = ['front', 'left', 'right', 'back'] as const;
type PermanentSideKey = (typeof PERMANENT_SIDES)[number];
const PERMANENT_SIDE_META: Record<PermanentSideKey, { label: string; color: string }> = {
  front: { label: 'Front', color: '#ef4444' },
  left: { label: 'Left', color: '#3b82f6' },
  right: { label: 'Right', color: '#f59e0b' },
  back: { label: 'Back', color: '#a855f7' },
};
const isPermanentSide = (t: string): t is PermanentSideKey =>
  (PERMANENT_SIDES as readonly string[]).includes(t);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-4">
      <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
        {title}
      </h2>
      {children}
    </div>
  );
}

// ─── Form state ──────────────────────────────────────────────────────────────
// The form-state type + the form ⇄ QuoteInputs mapping live in
// src/lib/quoteForm.ts (tested) so /quote/[id] hydration can't drift from
// what Calculate Quote sends.

// What /quote/[id] passes in to reopen a saved quote (task #31): the raw quote
// row fields. The builder maps them into form state via inputsToFormData.
export type QuoteBuilderInitial = {
  quoteId: string;
  customer: StoredCustomer;
  serviceType: ServiceType | null;
  inputs: Partial<QuoteInputs>;
  result: QuoteResult | null;
  designId: string | null;
  sentAt: string | null;
  approvedAt: string | null;
  // Canonical lifecycle fields (BUG-1/BUG-2, S22) so the header pill shows the
  // real status — deriveStatus honors a persisted declined/cancelled over the
  // timestamps a still-"sent"-looking row carries — and the ID shows the
  // sequential display number. All optional: /quote/[id] populates them from the
  // saved row; a brand-new quote leaves them null (header falls back to the UUID).
  status?: QuoteStatus | null;
  viewedAt?: string | null;
  depositPaidAt?: string | null;
  // Row 338 fix-round HIGH (staff lens): the sticky identity-freeze signal
  // (wasEverApproved, quoteStatus.ts) reads this — the same jsonb the
  // server's #251/#839 CAS checks. approvedAt/depositPaidAt above are the
  // NON-sticky columns a decline->revive cycle nulls; this is what lets the
  // Clear/re-pick confirm dialogs (and their gates) agree with the server on
  // a revived previously-approved quote. Raw passthrough (not a
  // server-derived boolean) so the client reuses the one pure function
  // instead of a second copy of the OR logic.
  approvalSnapshot?: unknown;
  quoteNumber?: number | null;
  // Test Quote (ledger #93): a reopened test quote stays in TEST MODE — derived
  // from the saved row, never re-read from the URL on edit (is_test is immutable).
  isTest?: boolean;
  // YLL Neighbor (#158): quote migrated from last year's Jobber data (#155).
  // The saved row's value, hydrated ONCE at mount into a real toggleable chip
  // (#198) — see the legacyRebook/isNce useState below. No live re-read after
  // mount (matches every other saved-row flag here).
  legacyRebook?: boolean;
  // NCE (#198): quote-level "Mark as NCE" tag (the barter/trade network YLL
  // belongs to). Same mount-hydrate-once posture as legacyRebook above.
  isNce?: boolean;
  // View-only portal (#176): staff-flagged browse-only quote. Read-only display
  // flag from the saved row — display-only here (the toggle itself lives on the
  // admin detail page, not the builder); mirrors legacyRebook exactly.
  viewOnly?: boolean;
  // Referral program redemption (#41 PR 2): the quote's OWN linked customer
  // (quotes.customer_id), so the credit banner can resolve identity WITHOUT a
  // second save (only known once a quote has been saved + reopened — a
  // brand-new quote in this same session doesn't have it yet, that's fine).
  customerId?: string | null;
  // Whether a referrals row exists with THIS quote as the referee (any
  // status) — resolved server-side (refereeReferralFor) so the spritzer
  // banner shows on a REOPENED quote even though the client-side "Referred
  // by" picker state (only set in the session that originally picked it) is
  // gone by then.
  isReferee?: boolean;
  // #172: whether the saved row already carries a HighLevel contact link —
  // the autocomplete chip can't be hydrated (we don't refetch the contact),
  // but the builder must stop showing the misleading "a contact is required"
  // warning on a quote that IS linked (it invited wrong re-picks on live jobs).
  highlevelContactId?: string | null;
  // PS-G2: the id of the job created when this quote was booked, if any —
  // lets the booked banner link straight to that job's "Amend order" section
  // (src/app/admin/jobs/[id]/page.tsx), which is the only place a re-price
  // done here actually gets recorded (reason + balance re-sync + audit trail
  // + customer notice). Null pre-booking or if job auto-create hasn't run yet.
  jobId?: string | null;
  // Customer tenure (#178): pre-formatted "Nth year — 2023 · 2024 · 2025" chip
  // text, server-computed (src/lib/customerTenure.ts) from the quote's linked
  // customer. Null when unlinked or no tenure history yet — chip hidden.
  // Display-only; the manual-years editor lives on the customer profile page.
  customerTenureLabel?: string | null;
};

// Header status pill (BUG-1, S22): the saved quote's canonical lifecycle status
// so a declined/cancelled quote badges correctly instead of the old
// approvedAt/sentAt-only 'Approved'/'Sent'. Mirrors the admin quotes list palette.
// Row 242 (Jason's ruling — no third stage): 'approved' reads + colors
// IDENTICALLY to 'sent' (APPROVED_DISPLAYS_AS === 'Sent') — see quoteStatus.ts
// for the rationale. deriveStatus/canTransition/money guards are unaffected;
// this is presentation only. This is a THIRD copy of the same status->label
// map (alongside the two admin quote pages) that ledger row 242's original
// recon didn't enumerate — reconciled here since it's a real "pipeline/stage
// chip on a quote surface" (the builder's own header pill), same as the
// other two.
const STATUS_BADGE: Record<QuoteStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-amber-100 text-amber-700' },
  sent: { label: 'Sent', cls: 'bg-blue-100 text-blue-700' },
  viewed: { label: 'Viewed', cls: 'bg-purple-100 text-purple-700' },
  // Row 242: no distinct color/label for approved — takes sent's exact style.
  approved: { label: APPROVED_DISPLAYS_AS, cls: 'bg-blue-100 text-blue-700' },
  booked: { label: 'Booked', cls: 'bg-emerald-100 text-emerald-700' },
  changes_requested: { label: 'Changes', cls: 'bg-orange-100 text-orange-700' },
  declined: { label: 'Declined', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-200 text-gray-600' },
  abandoned: { label: 'Abandoned', cls: 'bg-gray-200 text-gray-600' },
};

// ─── Builder component ───────────────────────────────────────────────────────
// The full quote builder, shared by /quote/new (blank) and /quote/[id] (edit —
// hydrated from a saved quote, task #31).

export default function QuoteBuilder({
  initialQuote,
  isTest: isTestProp,
  prefill,
}: {
  initialQuote?: QuoteBuilderInitial;
  isTest?: boolean;
  // Blank-slate-only prefill (#leads "Create quote" link) — see applyPrefill in
  // @/lib/quoteForm. Ignored whenever initialQuote is set (editing an existing
  // quote at /quote/[id] never seeds from this).
  prefill?: QuoteBuilderPrefill;
}) {
  const editMode = initialQuote != null;
  // Test Quote (ledger #93). New: from /quote/new?test=1 (isTestProp). Edit: from
  // the saved row (initialQuote.isTest). When true, the builder shows a TEST MODE
  // banner and Calculate persists the quote as is_test=true (saveQuote).
  const isTest = isTestProp ?? initialQuote?.isTest ?? false;
  // YLL Neighbor + NCE tags (#198) — staff-toggleable chips (below the
  // header), in BOTH new-quote and edit modes. Hydrated ONCE at mount: from
  // the saved row in edit mode, else from a resolved prefill (a tagged HL
  // contact picked from the lead list) in new mode, else false — never
  // live-refreshed after (mount-hydrate convention, matches isTest/viewOnly/
  // every other saved-row flag here; a customer tagged elsewhere mid-session
  // is picked up on next reopen, not live — DISCLOSED in the ledger spec).
  const [legacyRebook, setLegacyRebook] = useState(
    () => initialQuote?.legacyRebook ?? prefill?.legacyRebook ?? false,
  );
  const [isNce, setIsNce] = useState(() => initialQuote?.isNce ?? prefill?.isNce ?? false);
  // Review fix (staff HIGH + tech MED, S34 #198 review): per-chip "did staff
  // EXPLICITLY click this chip" trackers — set ONLY by the two chip onClick
  // handlers below (never by mount-hydration, prefill, or the HL-contact-pick
  // tag-lookup a few hundred lines down). Both /api/quote call sites
  // (resolveTagPayload) use these on an UPDATE (an existing quoteId) to
  // decide whether to send the chip's current value or `undefined` (server =
  // leave the stored value alone) — without this, every save unconditionally
  // wrote both tag columns, so a Calculate on a tab left open could silently
  // revert a tag an admin toggled concurrently on the detail page. On an
  // INSERT (no quoteId yet — this save creates the row) resolveTagPayload
  // sends the displayed value regardless of touched, so a lead-prefilled or
  // pick-inherited tag the staff never clicked still lands on the brand-new
  // quote (round-1 of this fix wrongly gated inserts too, silently dropping
  // an untouched inherited tag — corrected per resolveTagPayload's mode
  // param; see its own doc comment). Refs (not state) because touching a
  // chip shouldn't itself trigger a re-render.
  const legacyRebookTouchedRef = useRef(false);
  const isNceTouchedRef = useRef(false);
  // #199 (wrap-review F4): provenance for resolveNceDepositPercent's OFF-side
  // revert — true only while the CURRENT depositPercent===40 is a value
  // applyIsNce itself just wrote (a turn-ON), never a coincidence. Cleared on
  // turning OFF (whether or not a revert fired) and on any DIRECT manual edit
  // of the deposit input (see its own onChange) — a staff hand-edit, even to
  // 40, is never "the rule's" value again.
  //
  // SEEDED ON MOUNT (delta-verify MED): provenance isn't persisted, and the
  // first cut started `false` on EVERY mount — so reopening an already-NCE
  // quote sitting at 40% and clicking the chip OFF left the deposit at 40 on
  // a now-untagged quote (the chip said "not NCE", the money said otherwise).
  // Seeding from the loaded state fixes that — see initialNceDepositProvenance
  // (quoteForm.ts, next to resolveNceDepositPercent) for the full reasoning
  // and the disclosed residual; extracted there (pure, exported) so it's
  // unit-testable without a render harness, same convention as
  // resolveNceDepositPercent itself.
  const nceDepositSetByRuleRef = useRef(
    initialNceDepositProvenance(
      initialQuote ? { isNce: initialQuote.isNce, depositPercent: initialQuote.inputs?.depositPercent } : null,
      prefill?.isNce,
    ),
  );
  // #199 (wrap-review LOW): a ref mirror of `isNce`, updated synchronously by
  // applyIsNce (the ONLY place isNce ever changes — see its own reconcile
  // note). Pre-#199, the chip's onClick used setIsNce's own functional form
  // (`(v) => !v`), which is always guaranteed current. Routing the toggle
  // through applyIsNce's plain-boolean signature regressed that to a
  // render-closure read (`!isNce`) — this ref restores the same
  // never-stale guarantee for computing "next" at the call site.
  const isNceRef = useRef(isNce);
  // #215 (fix round F1, sibling-guard parity with isNceRef just above): a ref
  // mirror of `legacyRebook`, updated synchronously by applyLegacyRebook (the
  // ONLY place legacyRebook changes post-mount — see its own comment). Same
  // bug class as isNceRef fixed for NCE: pre-#215 the chip's onClick used
  // setLegacyRebook's own functional form (`(v) => !v`), always current by
  // construction. #215 needed a plain boolean BEFORE window.confirm and
  // regressed to a render-closure read (`!legacyRebook`) — stale the instant
  // the contact-pick tag-inheritance callback (a few hundred lines down)
  // fires an auto-set between renders.
  const legacyRebookRef = useRef(legacyRebook);
  // View-only portal (#176) — purely from the saved row, never set for a brand-new quote.
  const viewOnly = initialQuote?.viewOnly ?? false;
  // Customer tenure (#178) — purely from the saved row, never set for a brand-new quote.
  const customerTenureLabel = initialQuote?.customerTenureLabel ?? null;
  // BUG-1/BUG-2 (S22): the saved quote's canonical status + display number for
  // the header. deriveStatus prefers a persisted declined/cancelled/etc. over the
  // timestamps a still-"sent"-looking row carries. Only in edit mode; a brand-new
  // quote has no saved status/number yet (the ID falls back to the UUID prefix).
  const savedStatus: QuoteStatus | null = initialQuote
    ? deriveStatus({
        quote_sent_at: initialQuote.sentAt,
        customer_approved_at: initialQuote.approvedAt,
        deposit_paid_at: initialQuote.depositPaidAt ?? null,
        viewed_at: initialQuote.viewedAt ?? null,
        status: initialQuote.status ?? null,
      })
    : null;
  const quoteBuildTimerRef = useRef<ReturnType<typeof createQuoteBuildTimerClient> | null>(null);
  if (quoteBuildTimerRef.current === null) {
    quoteBuildTimerRef.current = createQuoteBuildTimerClient();
  }
  const quoteBuildTimingEligible = quoteBuildTimerEligible({ isTest, viewOnly, status: savedStatus });
  const hasPrefilledContact =
    !!initialQuote?.highlevelContactId || (!initialQuote && !!prefill?.ghlContactId);
  useEffect(() => {
    if (
      shouldStartPrefilledQuoteTimer({
        hasPrefilledContact,
        isTest,
        viewOnly,
        status: savedStatus,
      })
    ) {
      void quoteBuildTimerRef.current?.start('prefilled_open', initialQuote?.quoteId);
    }
  }, [hasPrefilledContact, initialQuote?.quoteId, isTest, savedStatus, viewOnly]);

  // Row 338 fix-round HIGH/MED (staff lens): the STICKY identity-freeze
  // signal, mirroring the exact three-way OR route.ts's #251/#839 CAS gates
  // check server-side (deposit_paid_at || customer_approved_at ||
  // wasEverApproved(row)) — is_test bypasses it, same as the server. The
  // Clear confirm gate and the re-pick confirm's wording used to key off
  // initialQuote?.approvedAt alone, which a decline->revive cycle nulls; a
  // revived previously-approved quote showed the weak "different contact"
  // warning (or no Clear-confirm at all) instead of the frozen one, even
  // though the server would refuse the write either way. Computed once from
  // the loaded row (mount-hydrate convention, matches isTest/viewOnly
  // above) — it describes history the session can't clear.
  const identityEverFrozen =
    !isTest &&
    !!(
      initialQuote?.depositPaidAt ||
      initialQuote?.approvedAt ||
      wasEverApproved({ approval_snapshot: initialQuote?.approvalSnapshot ?? null })
    );
  // #215: mirrors LegacyRebookToggle's/NceToggle's own `status !== 'draft'`
  // check (the admin siblings — both ultimately read deriveStatus) so EITHER
  // chip's confirm can show the SAME "already left draft" caveats once a
  // quote has left draft — the "won't move an existing GHL card" caveat on
  // Neighbor's ON path, and (fix round F2/F3) the one-way-propagation
  // caveat on both chips' OFF paths. A brand-new (never-saved) quote has
  // savedStatus === null, which counts as still-draft here too. Renamed from
  // legacyRebookLeftDraft (fix round F3) once the NCE chip's confirm started
  // reading it too — it was never actually Neighbor-specific, just the
  // generic "has this quote left draft" signal.
  const quoteLeftDraft = savedStatus != null && savedStatus !== 'draft';
  // Premerge finding 3 (S46 fix round): a stale tab's rejected 409 must not
  // vaporize the rendered breakdown (every price/label/footage control lives
  // inside `{result && (...)}`). When runQuote gets one of the three lock
  // codes back it restores the last-known-good result and flips this true so
  // the tab self-corrects to server truth (frozen controls, honest copy)
  // instead of staying editable and re-erroring forever. This also covers
  // finding 4's predicate-mismatch case (a staff-decline-after-approval quote
  // whose savedStatus/approvedAt read stale in THIS tab).
  const [staleApprovalFrozen, setStaleApprovalFrozen] = useState(false);
  // Row 444 (premerge staff lens HIGH): this quote's money came from home.works
  // and cannot be re-priced. Known at MOUNT from the snapshot the page already
  // passes, so the warning is on screen before a staffer types — the first cut
  // only told them after the server refused a save they had already made.
  const isMigrated = isMigratedQuote((initialQuote?.approvalSnapshot ?? null) as { [k: string]: unknown } | null);
  // Row 331+341: post-approval freeze for the three click-to-edit override
  // surfaces that auto-persist with no separate Calculate/confirm step and no
  // "already approved" warning of their own — EditablePrice (#104),
  // EditableLabel (S44), and #244's per-run bistro footage. is_test exempt,
  // matching the server's #251/#177 freezes — a test quote stays fully
  // editable regardless of lifecycle stamps.
  //
  // Premerge finding 1+4 fix: drive this off `initialQuote.approvedAt` (the
  // loaded row's real customer_approved_at) rather than the derived
  // `savedStatus`, so it matches the server's exact predicate — a
  // staff-declined-after-approval quote (staff-decline never clears
  // customer_approved_at; deriveStatus reports 'declined', not 'approved') no
  // longer shows editable controls that then 409 (finding 4). And carve out
  // the booked-amend case: the client already sends `amendReprice: true`
  // unconditionally whenever savedStatus === 'booked' (see the runQuote fetch
  // body below), which the server now honors for these three fields too — so
  // the sanctioned amend path (edit here + Calculate, then record the
  // amendment) must NOT be disabled, or a booked order has no correction path
  // at all (finding 1). An approved-but-not-yet-booked quote has no such
  // carve-out (no amend record is possible pre-booking — amend/route.ts
  // requires deposit_paid_at) and stays hard-locked; see POST_APPROVAL_LOCK_REASON
  // for its actual path (decline → revive → edit → re-send).
  const bookedAmendEligible = savedStatus === 'booked';
  const postApprovalFrozen =
    (!isTest && !!initialQuote?.approvedAt && !bookedAmendEligible) || staleApprovalFrozen || isMigrated;
  // Premerge finding 2 fix: this copy only ever shows when postApprovalFrozen
  // is true, which (per the carve-out above) now excludes the booked-amend
  // case entirely — so this is always the "re-approval needed" path, never
  // the amend flow (amend requires a booked/deposit-paid order, which this
  // predicate no longer reaches). Traced the actual mechanism (there is no
  // dedicated "revive" route): staff-decline (approved→declined is a legal
  // transition — quoteStatus.ts's ALLOWED_TRANSITIONS) declines the quote,
  // which per #124 does NOT clear customer_approved_at; "revive" is then just
  // a RE-SEND (POST /api/quotes/[id]/send) on that declined quote — canRevive
  // gates it, and send/route.ts's isRevive branch explicitly clears
  // customer_approved_at + viewed_at so deriveStatus reads 'sent' again,
  // reopening the quote for editing. That resend is the sanctioned way to
  // change a price/label/footage that was already customer-approved but
  // never booked.
  // Row 367 delta-verify MED: the REAL whole-page self-correction for a design
  // lock. The design routes answer 409 `code: 'design-locked'` when the linked
  // quote turns out to be customer-approved; this tab may still be showing
  // editable money controls from before that happened. Flipping
  // staleApprovalFrozen makes the page agree with the server — the same
  // recovery /api/quote's own lock codes already trigger.
  const noteDesignLocked = (data: unknown): boolean => {
    const code = (data as { code?: unknown } | null)?.code;
    if (code !== 'design-locked') return false;
    setStaleApprovalFrozen(true);
    return true;
  };
  // Row 367: the DESIGN's own lock copy. Separate from the money reason above
  // because the remedy sentence differs — nothing here needs re-pricing, the
  // customer simply agreed to a picture.
  // Row 444 (premerge staff lens HIGH + technical lens MED): for a migrated
  // order BOTH of the standard remedies below are dead ends. Decline/revive/
  // re-send reopens the customer approval flow on an already-booked historical
  // record and does not clear `approval_snapshot.homeworks`, so the very next
  // save refuses again; and the amend flow needs a fresh Calculate result to
  // compute its delta, which the guard makes impossible. Staff who missed the
  // one-time red banner were being steered at two remedies that cannot work.
  const MIGRATED_LOCK_REASON =
    'This order came from home.works. Its figures and design are a record of what the customer agreed and paid — this tool did not calculate them and cannot re-price them. To change this order, agree the new figures with Jason and record them directly.';
  const POST_APPROVAL_DESIGN_LOCK_REASON = isMigrated
    ? MIGRATED_LOCK_REASON
    : 'Locked after approval — the customer agreed to this design. To change the drawing, decline this quote, revive it, edit, and re-send. (A booked order is changed through the amend flow.)';
  const POST_APPROVAL_LOCK_REASON = isMigrated
    ? MIGRATED_LOCK_REASON
    : "Locked after approval — a price, label, or footage change here needs re-approval. Decline this quote, revive it, make the change, and re-send; the customer's prior approval no longer applies once you do.";
  const quoteNumber = initialQuote?.quoteNumber ?? null;
  // PS-G2: the booked quote's job id (null pre-booking) — drives the "Amend
  // order" banner below, which links to the job page's Record-amendment
  // control instead of leaving a re-price here as a dead end.
  const savedJobId = initialQuote?.jobId ?? null;
  const [form, setForm] = useState<QuoteFormData>(() =>
    initialQuote
      ? {
          ...inputsToFormData(initialQuote.customer, initialQuote.inputs, initialQuote.serviceType),
          // #214 (b): seed the form's hl link from the SAVED row so every
          // save body carries the live session truth (inputsToFormData
          // itself stays prefill-agnostic and returns null here). Pick /
          // Clear below keep this field current; /api/quote uses it as
          // identity input on updates (string = linked · null = no contact
          // — never falls back to a stored id the session already dropped).
          highlevelContactId: initialQuote.highlevelContactId ?? null,
        }
      : {
          ...applyPrefill(initialFormData, prefill),
          // NCE 40% deposit default (#199): a BRAND-NEW quote prefilled from
          // an already-NCE-tagged lead (prefill.isNce, resolved server-side —
          // see QuoteBuilderPrefill's own comment) starts at 40% too, same
          // rule applyIsNce below applies to a live chip turn-on. Blank-slate
          // only — there's nothing to clobber yet (initialFormData.depositPercent
          // is always 0 here), unlike a reopened quote's already-resolved rate.
          ...(prefill?.isNce ? { depositPercent: NCE_DEPOSIT_PERCENT } : {}),
        },
  );
  // ─── Unsaved-edit guard (ledger row 406) ────────────────────────────────
  // Row 406 is a CONFIRMED prod loss: Front footage typed 95 -> 100, Calculate
  // clicked, and the quote still read 95 long afterwards. `form` above is
  // seeded ONCE from a Server Component prop, and unlike a brand-new quote
  // (draftActive, below) a REOPENED one has no autosave at all — so any reload
  // between the edit and Calculate silently restores the server value and
  // Calculate then saves the OLD number, with nothing on screen ever saying a
  // change was pending.
  //
  // `userTouchedRef` latches on the first real DOM edit anywhere in the
  // builder (see onInputCapture on the wrapper below) and is NEVER reset — see
  // quoteHasUnsavedEdits for why resetting it would drop an edit typed while a
  // save was in flight. `lastPersistedFormRef` holds the serialization of the
  // form snapshot that last actually reached the database, seeded here with
  // the mount value because that IS the server truth at mount.
  //
  // SCOPE, stated honestly — corrected after a premerge staff-lens HIGH caught
  // this very comment overstating its reach. `beforeunload` covers an
  // accidental refresh, a tab close, and leaving for a DIFFERENT SITE. It does
  // NOT cover:
  //   - IN-APP navigation. Every OperatorNav link is a next/link client-side
  //     transition, which unmounts this component without ever firing
  //     beforeunload, and there is no route-leave interceptor in the app.
  //     Clicking Inbox mid-edit is an extremely ordinary action. The visible
  //     banner below is the only guard on that path today, which is why it is
  //     sticky rather than parked inline where it can scroll out of sight.
  //   - A silent browser tab discard (Chrome Memory Saver), which never runs
  //     the handler at all.
  // Both remaining gaps need the same real answer — edit-mode autosave — which
  // is its own design because the existing draft autosave is deliberately
  // gated OFF for reopened quotes (reopen-safety) and turning it on carries
  // its own clobber risk. Tracked as a separate ledger row, not smuggled in
  // here.
  // Both halves are STATE, not refs: the indicator below is rendered from
  // them, and a ref mutation would not re-render, leaving a stale warning on
  // screen after a successful save until something else happened to re-render.
  const [userTouched, setUserTouched] = useState(false);
  const userTouchedRef = useRef(false);
  const [lastPersistedForm, setLastPersistedForm] = useState<string>(() => stableStringify(form));
  const currentFormSerialized = useMemo(() => stableStringify(form), [form]);
  const hasUnsavedEdits = quoteHasUnsavedEdits({
    userTouched,
    currentForm: currentFormSerialized,
    lastPersistedForm,
  });
  // One capture-phase handler for the whole builder, latching on ANY human
  // interaction — typing, selection, pointer, keyboard.
  //
  // Premerge staff-lens HIGH: the first cut latched on `input`/`change` only,
  // which missed the tool's PRIMARY footage-editing mechanism. Drawing a
  // roofline, dragging a line endpoint, or deleting a line mutates `form`
  // through an effect driven by pointer/click handlers — no input event is
  // ever dispatched — so redrawing a trace on a reopened quote and navigating
  // away reproduced the exact row-406 loss with no warning at all. The
  // narrow latch encoded my own assumption that row 406 was about typing;
  // the row's own exposure is any unsaved edit.
  //
  // Widening the latch is safe because it is NOT the part that prevents false
  // positives — the comparison against the persisted snapshot is. A click
  // that changes nothing in the payload (opening a section, a contact search)
  // still reports clean, and a click that DOES change the payload is a
  // genuine unsaved edit that deserves the warning. What the latch alone
  // still buys is silence on the programmatic mount-time derives, which run
  // with no human interaction of any kind.
  //
  // (This also settles a premerge disagreement between two lenses about the
  // HighLevel contact pick: it is a <button onClick>, so it dispatches no
  // input event, but reaching it requires typing in the search box first, so
  // the old latch was already set. Under the widened latch the question is
  // moot either way.)
  const markUserTouched = () => {
    if (userTouchedRef.current) return;
    userTouchedRef.current = true;
    setUserTouched(true);
    // Row 413 deliberately does NOT dismiss the restore offer here. This runs
    // from CAPTURE-phase pointer/key handlers on the whole builder, so it
    // fires for a click on the offer banner's own Restore button - and
    // dismissing here unmounts that button before its click event ever
    // dispatches, turning Restore into Discard (PR #972 staff lens HIGH, the
    // classic capture-unmount race). The offer withdraws on a REAL edit
    // instead - see the stash effect below.
  };
  // Native beforeunload, registered ONLY while genuinely dirty so an untouched
  // or already-saved quote never prompts. preventDefault() is the modern
  // required signal; returnValue is kept for older engines.
  useEffect(() => {
    if (!hasUnsavedEdits) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedEdits]);

  // ─── Edit-mode autosave (ledger row 413) ────────────────────────────────
  // The half of row 406 the banner + beforeunload above CANNOT cover: an
  // in-app next/link navigation unmounts this component without any event, and
  // a Chrome Memory Saver discard never runs a handler at all. While the form
  // is genuinely dirty, the whole QuoteFormData is stashed to localStorage
  // (debounced), bound to the exact `lastPersistedForm` it was edited on top
  // of; quoteEditDraft.ts refuses to offer it back unless the server row still
  // serializes to that same base, so a row that moved since (another operator,
  // another tab, an approval) silently wins — the reopen-safety rule that
  // keeps the OLD new-quote draft gated off for edit mode, kept, not waived.
  //
  // Restoring is an OFFER (banner near the top), never an automatic setForm:
  // the operator decides. The offer also self-dismisses on the first real
  // touch of the form — from that moment the operator is editing the SERVER
  // value, their new edits start stashing over the old draft, and restoring
  // the stale one on top of live typing would itself be a clobber.
  const [editDraftOffer, setEditDraftOffer] = useState<QuoteEditDraft | null>(null);
  // PR #972 staff lens MED: when a stash existed but the quote changed since,
  // the draft is dropped (the server wins) and the operator is TOLD - a
  // silent drop is indistinguishable from the tool eating their work.
  const [editDraftDiscardedNotice, setEditDraftDiscardedNotice] = useState(false);
  // Row 420: the sibling notice for a draft discarded because the quote's
  // LIFECYCLE moved (approved / booked / declined since the stash) — a
  // different fact than "someone edited the form", so it gets its own words.
  const [editDraftLifecycleNotice, setEditDraftLifecycleNotice] = useState(false);
  // The stable id of the quote being edited — initialQuote's, not savedQuoteId
  // (declared further down, and identical in edit mode anyway: savedQuoteId is
  // seeded from this exact value and never changes for an existing quote).
  const editQuoteId = initialQuote?.quoteId ?? null;
  // Row 420: the lifecycle this session's stashes are bound to. Mount-time
  // server truth, like lastPersistedForm — if the customer approves or books
  // WHILE the operator edits, the stash carries the pre-approval stamp and
  // the NEXT reopen (which loads the fresh row) discards it, which is the
  // point: a draft never outlives the order state it was priced against.
  const editLifecycle = initialQuote
    ? quoteEditDraftLifecycle({
        status: initialQuote.status ?? null,
        approvedAt: initialQuote.approvedAt ?? null,
        depositPaidAt: initialQuote.depositPaidAt ?? null,
      })
    : '';
  useEffect(() => {
    if (!editMode || !editQuoteId) return;
    sweepQuoteEditDrafts();
    // lastPersistedForm at mount IS the server truth (seeded from the Server
    // Component prop) — exactly the base a restorable draft must match.
    const draft = loadQuoteEditDraft(editQuoteId, lastPersistedForm, editLifecycle);
    // queueMicrotask defers the setState out of the effect body, the same
    // idiom the new-quote draft-restore effect above uses for the identical
    // react-hooks/set-state-in-effect error-level rule.
    if (draft === 'server-moved') queueMicrotask(() => setEditDraftDiscardedNotice(true));
    else if (draft === 'lifecycle-moved') queueMicrotask(() => setEditDraftLifecycleNotice(true));
    else if (draft) queueMicrotask(() => setEditDraftOffer(draft));
    // Mount-only by design: a draft can only be offered against the freshly
    // loaded row, never against mid-session state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!editMode || !editQuoteId) return;
    if (hasUnsavedEdits) {
      // A REAL edit (payload actually changed, not a search-box keystroke)
      // withdraws the pending restore offer: from here the operator is editing
      // the server value, their new edits stash over the old draft, and
      // restoring the stale one on top of live typing would be a clobber.
      // Deferred out of the effect body per the set-state-in-effect rule.
      if (editDraftOffer) queueMicrotask(() => setEditDraftOffer(null));
      // Debounced stash while dirty. 800ms: long enough to not thrash JSON +
      // localStorage on every keystroke of a footage number, short enough that
      // a tab discard moments after typing still has the edit.
      const t = setTimeout(() => {
        saveQuoteEditDraft(editQuoteId, form, lastPersistedForm, editLifecycle);
      }, 800);
      return () => clearTimeout(t);
    }
    // Clean again: clear the stash when a save made it clean (userTouched
    // latches on the first edit and never resets). Two guards: an untouched
    // mount also reaches this branch (userTouched false), and the draft the
    // offer banner is holding UN-ANSWERED must never be deleted out from
    // under it (!editDraftOffer) - which means, deliberately, that a no-edit
    // Calculate while the offer is pending does NOT wipe the stash: the
    // persisted values are unchanged, so the recovered edits remain a valid,
    // still-unanswered alternative, and wiping them on a routine pricing
    // click would destroy exactly what this feature preserves. (The #972
    // delta-verify caught the earlier comment claiming the opposite.) Once
    // the offer is resolved - restored, discarded, or displaced by a real
    // edit - every successful Calculate wipes the stash here.
    if (userTouched && !editDraftOffer) clearQuoteEditDraft(editQuoteId);
  }, [editMode, editQuoteId, hasUnsavedEdits, currentFormSerialized, lastPersistedForm, userTouched, form, editDraftOffer, editLifecycle]);
  // Premerge technical-lens HIGH: the debounce's cleanup CANCELS a pending
  // stash, and this component's whole premise is that an in-app next/link
  // click unmounts it with no event — so typing a footage number and clicking
  // Inbox inside the 800ms window would lose the edit through the exact door
  // this feature closes (the original row-406 loss, reintroduced by its own
  // fix — the S51 class). Flush ON UNMOUNT ONLY, via refs kept current every
  // render: a cleanup-flush on the debounce effect itself would fire on every
  // dep change (each keystroke) and delete the debounce entirely.
  const stashFlushRef = useRef<null | (() => void)>(null);
  // Kept current from an every-render effect, not a render-time assignment —
  // the react-compiler lint rule forbids ref writes during render (CI caught
  // it; my local lint read was the truncated tail of the output, not the
  // count). Post-commit assignment is equivalent here: the unmount cleanup
  // below reads whatever the LAST committed render left.
  useEffect(() => {
    stashFlushRef.current =
      editMode && editQuoteId && hasUnsavedEdits
        ? () => saveQuoteEditDraft(editQuoteId, form, lastPersistedForm, editLifecycle)
        : null;
  });
  useEffect(() => {
    return () => {
      stashFlushRef.current?.();
    };
    // Mount-only: the cleanup must run at UNMOUNT, and the ref always holds
    // the latest stash closure (or null when there is nothing worth keeping).
  }, []);
  // Self-dismiss of the offer on the operator's first edit lives inside
  // markUserTouched below (an event handler, not an effect — the
  // set-state-in-effect rule is at error here, and the handler is the actual
  // moment the intent changes anyway).

  // Fix-round HIGH (staff lens, #243 gate): a ref mirror of `form.serviceType`,
  // same never-stale idiom as isNceRef/legacyRebookRef above — but unlike those
  // two, serviceType has no single "apply" function every change funnels
  // through (the type button below, and the draft-restore effect, both call
  // setForm directly), so this stays current via the effect right below instead
  // of an inline write at one call site. Exists specifically for
  // pickHighLevelContact's async tag-lookup .then() (a few hundred lines down):
  // that closure used to read `form.serviceType` directly — the value captured
  // when the contact was CLICKED, not when the fetch resolves. Sequence: staff
  // start a quote as holiday, pick an NCE-tagged contact, then click "permanent"
  // before the ~200ms fetch returns (an ordinary correction) — the type-switch
  // handler sees no tag yet (nothing to clear), the fetch then resolves against
  // the STALE holiday closure and calls applyIsNce(true), setting
  // depositPercent=40 on what is now a permanent quote. The chip strip is
  // already hidden (service type is permanent), so the wrong state is invisible
  // in the UI. The #243 server-side gate (route.ts) is a backstop for exactly
  // this, but the client shouldn't manufacture the bad request to begin with.
  const serviceTypeRef = useRef(form.serviceType);
  useEffect(() => {
    serviceTypeRef.current = form.serviceType;
  }, [form.serviceType]);
  // In edit mode the saved result hydrates too, so the operator sees the
  // current price breakdown (and the portal/send buttons) without recalculating.
  const [result, setResult] = useState<QuoteResult | null>(initialQuote?.result ?? null);
  // #104: the overrides-stripped baseline (from /api/quote) — powers the "custom ·
  // was $X" flag per overridden line. Seeded to the saved result on reopen (an
  // existing override then reads "was <itself>" until the next Calculate returns a
  // real baseline — harmless, and re-Calculate refreshes it).
  const [baselineResult, setBaselineResult] = useState<QuoteResult | null>(initialQuote?.result ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // ─── HighLevel integration state ────────────────────────────────────────
  // `highlevelContact`: the GHL contact picked in the autocomplete. When
  // set, customer fields are pre-filled and we'll attach the quote to this
  // contact's existing opportunity on save.
  // A lead-prefilled NEW quote seeds this as if the operator had picked the
  // lead's known contact by hand (blank-slate branch only): the linked chip
  // renders immediately, the false "contact required" warning never shows,
  // and the normal post-save attach flow wires the pipeline card. Built from
  // the prefill's own fields — the lead IS the contact. "Change" still works.
  // `savedQuoteId`: UUID returned from /api/quote. Needed for the attach
  // call and for the "Send Quote to Customer" button (which targets
  // /api/quotes/[id]/send).
  // `attachStatus` / `sendStatus`: informational — surfaced as a small
  // status line so the operator knows whether the GHL side is in sync.
  const [highlevelContact, setHighLevelContact] = useState<CrmContact | null>(() =>
    !initialQuote && prefill?.ghlContactId
      ? {
          id: prefill.ghlContactId,
          source: 'highlevel',
          fullName: prefill.name?.trim() || undefined,
          email: prefill.email?.trim() || undefined,
          phone: prefill.phone?.trim() || undefined,
          address1: prefill.address?.trim() || undefined,
        }
      : null,
  );
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(initialQuote?.quoteId ?? null);
  // Referral program (#41 "mention" attribution): an existing customer staff
  // picked as "Referred by" while building THIS quote. The new quote's id (or,
  // since the adversarial-review fix, an EXISTING quote's id on an update)
  // becomes the referee — sent on every Calculate regardless, since the
  // server creates the pending row idempotently on either path.
  const [referredBy, setReferredBy] = useState<{ id: string; name: string } | null>(null);
  // Referral program redemption (#41 PR 2). The quote's own linked customer
  // never changes within a session — only known on a reopened/saved quote
  // (see QuoteBuilderInitial.customerId). `referralCreditUsd` is fetched
  // client-side (below) so the banner reflects the LIVE balance, not a
  // page-load-stale one, and so it updates in place after Apply.
  const linkedCustomerId = initialQuote?.customerId ?? null;
  const [referralCreditUsd, setReferralCreditUsd] = useState(0);
  // Referral program redemption (#41 adversarial-review HIGH fix): true from
  // the moment Apply (or Remove) changes form.referralCredit until a save
  // actually persists that change — guards Send so a portal link can never
  // go out pointing at a quote whose discount doesn't yet match an
  // already-spent (or already-released) credit. See applyReferralCredit /
  // handleReferralCreditRemoved / handleSendToCustomer.
  const [referralCreditUnsaved, setReferralCreditUnsaved] = useState(false);
  // Loud, blocking message shown ON the credit banner specifically when the
  // immediate auto-persist right after Apply/Remove fails.
  const [referralPersistError, setReferralPersistError] = useState<string | null>(null);
  const [attachStatus, setAttachStatus] = useState<'idle' | 'attaching' | 'attached' | 'skipped' | 'error'>('idle');
  const [attachError, setAttachError] = useState<string | null>(null);
  // S30 wrap review (customer MED): the attach route reports when linking
  // RESURRECTED an old won/lost/abandoned GHL card (reopened + moved to the
  // entry stage) instead of creating/reusing one — staff must see that, since
  // a reopened card can re-enter stage-triggered GHL automations.
  const [attachResurrected, setAttachResurrected] = useState(false);
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'sent' | 'already-sent' | 'error'>('idle');
  // #241 defect 2 (review MEDIUM): a Force-Redeliver click can ALSO fall
  // through the route's alreadySent short-circuit (send/route.ts's
  // isDeliveryRetry only honors 'sent'/'viewed' — a quote that's since gone
  // approved/booked/deposit-paid isn't retry-eligible either, W1-017's same
  // guard). True once we've learned THAT click delivered nothing, so the
  // already-sent box can say so instead of repeating the original message +
  // a doomed retry button.
  const [retryIneligible, setRetryIneligible] = useState(false);
  // #92 — a fulfillability BLOCK (design has items we can't supply), kept distinct
  // from a send FAILURE so we never tell the operator to share the link manually.
  const [sendBlockedMsg, setSendBlockedMsg] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Customer delivery is distinct from the local sent stamp and CRM stage. A
  // partial failure stays visible with a channel-specific retry; an all-channel
  // failure puts Send in the error state while preserving the valid portal URL.
  const [deliveryWarning, setDeliveryWarning] = useState<string | null>(null);
  const [deliveryRetryChannel, setDeliveryRetryChannel] = useState<'sms' | 'email' | 'both' | null>(null);
  // Row 269 fix round: whether the CURRENT deliveryWarning/sendError text
  // reflects a timeout-hedged failure (GHL may have delivered it anyway —
  // isTimeoutHedgedFailure, pipelineSendOutcome.ts) rather than a confirmed
  // rejection. Captured at the moment the warning/error is set (the two
  // deliveryWarning set-sites and the two 502-throw sites below all pass
  // data.messageError/data.error) instead of re-sniffing the rendered string
  // at click time, so the retry buttons' confirm-vs-typed-YES gate can't
  // drift from the text that produced it.
  const [deliveryFailureHedged, setDeliveryFailureHedged] = useState(false);
  // #241: when the send route short-circuits with alreadySent:true (a
  // double-click / re-click on an already-sent quote), nothing was texted or
  // emailed — this holds the ORIGINAL quote_sent_at so the UI can say so
  // instead of rendering an identical plain success. Cleared on any fresh
  // send attempt or recalculation.
  const [alreadySentAt, setAlreadySentAt] = useState<string | null>(null);
  // Row 269: per-channel classification of the alreadySent short-circuit's
  // new channelOutcomes field (route.ts) — 'unknown' whenever the field is
  // absent entirely (the read failed) or a channel has no logged attempt, so
  // this is never mistaken for a confirmed-delivered state. Drives both the
  // already-sent notice's per-channel copy and (below) the scoped redeliver
  // offer replacing the old hardcoded 'both'. Null until an alreadySent
  // response is seen; cleared on any fresh send attempt.
  // Row 269 fix round FIX 2: `hadAttempt` added (not a new useState — same
  // object, one more field) so channelDeliveryPhrase can tell "no delivery
  // row was ever logged for this channel" (entry was null) apart from "a row
  // exists but it's a timeout-hedged failure" (entry present, classification
  // still 'unknown') — classifyChannelOutcome collapses both into 'unknown'
  // on purpose (see its own doc comment), so the raw entry's presence is the
  // only place left to recover that distinction.
  const [alreadySentChannels, setAlreadySentChannels] = useState<{
    sms: { classification: ChannelDeliveryClassification; at: string | null; hadAttempt: boolean };
    email: { classification: ChannelDeliveryClassification; at: string | null; hadAttempt: boolean };
  } | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  // GHL stage-sync result of the last send: a non-null message means the quote
  // WAS sent locally but the HighLevel card did NOT advance to "Bid Sent" (the
  // send route reports ghlSynced:false + stageError, and persists ghl_sync_error
  // for the ?retryGhl reconcile bucket). Surfaced so the operator knows + can
  // retry, instead of the old falsely-confident "stage moved to Bid Sent".
  const [ghlSyncWarning, setGhlSyncWarning] = useState<string | null>(null);
  // #839 fix-round MED (staff+technical lenses): the #251 identity freeze
  // used to be log-only when it actually refused a would-be reattach on an
  // approved/booked quote — this mirrors ghlSyncWarning's shape (a boolean
  // is enough; the copy is fixed, unlike ghlSyncWarning's server-supplied
  // string) so a real freeze shows a small notice instead of a save that
  // silently succeeds with a stale customer link.
  const [identityFrozenNotice, setIdentityFrozenNotice] = useState(false);
  // Row 344 Part B: mirrors identityFrozenNotice's shape one line up — the
  // server (route.ts) only sends `repricedAfterApproval` when THIS save
  // actually changed the total of an approved-not-booked quote (a footage
  // edit, a mini-light regroup, or any other scene-driven change; the four
  // fields with their own hard lock — deposit%/price/label/bistro-footage —
  // never reach here). Sticky once shown, same as identityFrozenNotice: it
  // describes what THIS save just did, not a live/re-checked warning, so it
  // is never cleared back to null by a later save that happens not to
  // reprice anything.
  const [postApprovalRepriceNotice, setPostApprovalRepriceNotice] = useState<{
    previousTotalUsd: number;
    newTotalUsd: number;
    deltaUsd: number;
    // Fix round (staff-lens HIGH): whether the portal is actually still
    // frozen to the approved figure (adapter.ts falls back to the LIVE
    // result — the number this save just changed — whenever
    // approval_snapshot.pricing is absent, e.g. a staff-approve() snapshot
    // predating that field). The notice text below must say which is true.
    portalShowsFrozenPrice: boolean;
    // Second fix round (staff-lens HIGH): the REASON portalShowsFrozenPrice is
    // false — an accepted amendment already exists (always a BOOKED order;
    // the remedy is the job's amend flow) vs no frozen pricing was ever taken
    // (remedy depends on whether the order is booked). The notice's original
    // copy told staff to "decline, revive, and re-send" unconditionally —
    // both decline routes structurally refuse a booked order (canTransition
    // 409s), so on a booked-and-amended quote that instruction was both the
    // wrong diagnosis AND an impossible remedy. See the notice JSX below.
    hasAcceptedAmendment: boolean;
  } | null>(null);
  // FIX A (#237 fix round, staff-lens HIGH): mirrors ghlSyncWarning's shape
  // (send route field: eventDateSyncError) for a DIFFERENT failure surface —
  // the event-date GHL custom-field push can fail independently of the stage
  // move. Kept as its OWN state/banner rather than folded into
  // ghlSyncWarning: that banner's copy explicitly claims "the HighLevel card
  // didn't advance to Bid Sent," which would be a false claim on a send
  // where the card moved fine and only this push failed.
  const [eventDateSyncWarning, setEventDateSyncWarning] = useState<string | null>(null);
  // Guards against re-attaching the same quote+contact on every recalculation,
  // now that Calculate updates the saved row in place instead of inserting.
  const lastAttachKey = useRef<string | null>(null);
  // #172 concurrency guards (review findings). attachSeqRef: staleness token —
  // pick/clear bump it, and an attach run only writes attachStatus/attachError
  // if its captured token is still current (a slow response from a superseded
  // pick can't corrupt the chip). attachPromiseRef: every attach/detach chains
  // onto this, serializing the DB writes so rapid pick-A-then-B can't finish
  // B-then-A and leave the row linked to the stale contact. sendInFlightRef:
  // synchronous double-click guard for Send (state-based guards race — two
  // clicks in one tick both read stale state; the ref flips before any await).
  const attachSeqRef = useRef(0);
  const attachPromiseRef = useRef<Promise<boolean> | null>(null);
  const sendInFlightRef = useRef(false);
  // #172: the saved row already carries a HighLevel link (hydrated on edit,
  // maintained on attach/detach). Kills the false "contact required" warning
  // on reopened linked quotes — the chip itself stays pick-session-only.
  // A lead-prefilled NEW quote is the second producer of that same state: the
  // first Calculate inserts the carried ghlContactId, so the warning would be
  // just as false — seed from the prefill too (applyPrefill is the only thing
  // that sets form.highlevelContactId on the blank-slate branch). An explicit
  // operator pick still overwrites via the attach flow as usual.
  const [dbLinked, setDbLinked] = useState<boolean>(
    !!initialQuote?.highlevelContactId || (!initialQuote && !!prefill?.ghlContactId),
  );
  // #839 fix-round HIGH (customer+technical lenses, BYPASS 2): session memory
  // of the last contact this quote was ACTUALLY linked to, independent of
  // dbLinked/highlevelContact — because clearHighLevelContact synchronously
  // resets BOTH of those (setHighLevelContact(null); setDbLinked(false)), so
  // the ordinary correction sequence "Clear, then pick contact B" made
  // pickHighLevelContact's currentContactId resolve null and skip the #251
  // confirm entirely, even on an approved/booked quote — a clear-then-pick
  // bypassed the whole Fix 2 guard. Seeded on mount (same precedence
  // dbLinked's own seed uses: the reopened quote's saved link, else a
  // lead-prefill's), and updated ONLY on a successful pick — never on Clear —
  // so a clear-then-pick still confirms against the contact that was linked
  // seconds ago. Same convention as isNceRef/legacyRebookRef above: a ref
  // mirror kept synchronously current so a callback a few lines down never
  // reads a stale value.
  const everLinkedContactIdRef = useRef<string | null>(
    initialQuote?.highlevelContactId ?? (!initialQuote ? (prefill?.ghlContactId ?? null) : null),
  );

  // ─── Draft autosave (quote-forms-partial-save) ───────────────────────────
  // Save the customer block to localStorage as staff type, so a brand-new
  // quote's contact info isn't lost if they navigate away before Calculate
  // (the first thing that persists anything). Active ONLY for a new, non-test
  // quote that hasn't saved yet — once savedQuoteId exists the row IS the
  // store; a reopened/test quote is never touched (reopen-safety, mirrors the
  // satellite/footage effects). No design/pricing state, no GHL — see
  // src/lib/quoteDraft.ts.
  const draftActive = draftAutosaveActive({ editMode, isTest, savedQuoteId });
  const [draftRestored, setDraftRestored] = useState(false);
  // Row 206: a stale draft withheld because a lead prefill was applied — see
  // the effect below. Separate flag from draftRestored (different fact,
  // different copy): this one never touches form state at all.
  const [draftWithheldByPrefill, setDraftWithheldByPrefill] = useState(false);
  const draftRestoreTriedRef = useRef(false);

  // Restore once on mount: a blank new builder + a saved draft → prefill the
  // customer block + service type. queueMicrotask defers the setState out of
  // the effect body (react-hooks/set-state-in-effect is at error here).
  //
  // Row 206: an incoming lead prefill (?name=/?serviceType=/?ghlContactId=,
  // src/app/admin/leads' "Create quote" link) means the operator is starting
  // from a KNOWN lead. customerIsEmpty(form.customer) below only catches a
  // prefill that carried contact fields — applyPrefill already wrote them
  // into form.customer before this effect ever runs (see the useState
  // initializer above). A prefill that carried ONLY serviceType and/or
  // ghlContactId (no name/phone/email/address) leaves form.customer empty,
  // so without this guard a week-old draft for a DIFFERENT customer would
  // restore right over it — clobbering the prefill's serviceType, and
  // leaving the picked-contact chip (seeded from prefill.ghlContactId,
  // independent of the customer fields) pointing at one customer while the
  // restored fields show another. Skip the restore whenever a prefill was
  // applied at all, regardless of which fields it carried — the draft itself
  // is left in storage untouched (only the RESTORE is skipped), so a later
  // plain /quote/new visit with no prefill can still recover it; deleting a
  // real draft just because someone opened a prefill link would be its own
  // data loss (row 206's own text). Told, not silent, per the rows 413/420
  // convention: a withheld draft still gets a dismissible grey notice.
  useEffect(() => {
    if (!draftActive || draftRestoreTriedRef.current) return;
    draftRestoreTriedRef.current = true;
    if (prefill) {
      if (loadQuoteDraft()) queueMicrotask(() => setDraftWithheldByPrefill(true));
      return;
    }
    const draft = loadQuoteDraft();
    if (!draft) return;
    // Only restore (and only then show the note) when the block is genuinely
    // empty at mount — so the "Restored…" banner can never appear over data we
    // didn't actually fill, and its Clear can never wipe genuinely-typed input.
    if (!customerIsEmpty(form.customer)) return;
    queueMicrotask(() => {
      setForm((f) =>
        customerIsEmpty(f.customer)
          ? { ...f, customer: draft.customer, serviceType: draft.serviceType }
          : f,
      );
      setDraftRestored(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave the customer block (debounced). saveQuoteDraft clears the store
  // by itself once the block goes empty.
  useEffect(() => {
    if (!draftActive) return;
    const t = setTimeout(() => saveQuoteDraft(form.customer, form.serviceType), 600);
    return () => clearTimeout(t);
  }, [draftActive, form.customer, form.serviceType]);

  // Dismiss the restored-draft note and wipe both the store and the fields it
  // filled (a user action — setState here is fine, it's not an effect).
  const clearDraftAndReset = () => {
    clearQuoteDraft();
    // Reset BOTH fields the restore filled — the customer block and the
    // service type — back to the blank-quote defaults, so Clear fully undoes it.
    setForm((f) => ({
      ...f,
      customer: { name: '', phone: '', email: '', address: '' },
      serviceType: initialFormData.serviceType,
    }));
    setDraftRestored(false);
  };

  // Referral program redemption (#41 PR 2): resolve the linked customer's
  // LIVE credit balance client-side (rather than trusting a page-load-stale
  // server value) via the /api/customers?id= single-lookup extension. Only
  // runs when a customer is actually linked (a saved/reopened quote) — a
  // brand-new quote has none yet. Best-effort: a fetch failure just means the
  // banner doesn't show, never a builder error.
  useEffect(() => {
    if (!linkedCustomerId) return;
    let stale = false;
    (async () => {
      try {
        const res = await fetch(`/api/customers?id=${encodeURIComponent(linkedCustomerId)}`);
        const data = await res.json();
        const hit = Array.isArray(data.customers) ? data.customers[0] : null;
        if (!stale && hit && typeof hit.referralCreditUsd === 'number') {
          setReferralCreditUsd(hit.referralCreditUsd);
        }
      } catch {
        // best-effort — the banner simply doesn't show
      }
    })();
    return () => {
      stale = true;
    };
  }, [linkedCustomerId]);

  // Photo analysis (#35: the street photo lives in the DESIGN — only the
  // satellite keeps measurement polylines; street overlays/detections are gone)
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisNotes, setAnalysisNotes] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // Degraded-but-recoverable notice (e.g. the analyzer is down): the photos load
  // and staff design manually. Distinct from analysisError (hard/blocking).
  const [analysisWarning, setAnalysisWarning] = useState<string | null>(null);
  // SHADOW MODE (deterministic-satellite-footage): per-roofline flag text when
  // the model's stated satellite footage disagrees >25% with what its own
  // drawn lines measure. Kept separate from analysisWarning (whose banner
  // header reads "Auto-design unavailable" — wrong for this case) so it gets
  // its own amber note. Cleared per-roofline the moment the operator redraws
  // that roofline's satellite lines (see getSetter) so it never describes
  // lines that have already been fixed.
  const [satelliteFootageDisagreement, setSatelliteFootageDisagreement] = useState<{
    santas: string | null;
    gingerbread: string | null;
  }>({ santas: null, gingerbread: null });
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoMediaType, setPhotoMediaType] = useState<string | null>(null);

  // ─── Embedded design editor — the Design tab (#27 Phase 1, #35 design-first) ──
  // The design IS the primary canvas now: it's created EAGERLY the moment a
  // street photo is in hand (address lookup or upload+analyze), not when a
  // section is opened. It links to the quote on Calculate. The Konva editor is
  // a client-only dynamic import, kept mounted (hidden) across tab switches.
  const [designId, setDesignId] = useState<string | null>(initialQuote?.designId ?? null);
  const [designBusy, setDesignBusy] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  // #90: how many AI-seeded garland runs had no scale to estimate length (so they
  // fall back to 1 section). Surfaced as a builder warning so staff set the count.
  const [garlandUnestimated, setGarlandUnestimated] = useState(0);
  // #255 / #741 defect 3: mini group(s) (railing/curtain/etc.) a re-analyze OR
  // a photo delete just orphaned — seedSceneFromAnalysis and
  // removeDesignExtraPhoto both prune a group silently (no member strands
  // left), so a "Railing — 3 strings" line can vanish from the quote total
  // with nothing else explaining it. `cause` drives which guidance the banner
  // shows (#741 defect 4 — the two triggers need DIFFERENT copy: a re-analyze
  // miss may still be redrawable, a photo-delete prune's strands are gone for
  // good with the deleted photo). null = no standing warning.
  const [prunedMiniGroups, setPrunedMiniGroups] = useState<{
    cause: 'reanalyze' | 'photo-delete';
    groups: { surface: string | null; stringCount: number }[];
  } | null>(null);
  // Row 328(a): set when a contact pick's INHERITED NCE tag would have moved
  // the deposit on a quote that has already left draft, and was held back.
  // Holds the inherited tag value so the banner can say which way it went.
  // Cleared by a Calculate, which re-states the whole quote deliberately.
  const [nceDepositHeldBack, setNceDepositHeldBack] = useState<boolean | null>(null);
  // #741 defect 3: reports a NEW prune from one of the two triggers. An empty
  // result never overwrites a real, unaddressed warning already standing from
  // the OTHER trigger — e.g. a re-analyze orphans "Curtain — 6 strings"
  // (banner shows), then the operator deletes an unrelated empty extra photo
  // (reports []) — that must not silently make the still-unresolved warning
  // disappear. Only a NON-empty report ever changes the banner.
  const reportPrunedMiniGroups = (cause: 'reanalyze' | 'photo-delete', raw: unknown) => {
    const groups = sanitizePrunedMiniGroups(raw);
    if (groups.length > 0) setPrunedMiniGroups({ cause, groups });
  };
  // Bumped when the design's scene/photo changes outside the editor (roofline
  // seed, photo replacement) so a remount reloads it.
  const [designEditorKey, setDesignEditorKey] = useState(0);
  const [designPhotoRevision, setDesignPhotoRevision] = useState(0);
  // The live design scene, fetched after each Calculate so the Quote Breakdown
  // can map each line-item row → its scene item(s) and show the "recommended"
  // checkbox (#12). Empty/no-design → only custom rows are toggleable (their
  // flag lives in form state). Bumped via designEditorKey so a write-back +
  // remount re-fetches the patched scene.
  const [breakdownScene, setBreakdownScene] = useState<Scene | null>(null);
  // #13: extra-photo id → label ("Backyard" / "Photo 2"), captured with the
  // scene fetch, for the staff-only per-row photo tags in the breakdown.
  const [breakdownPhotoLabels, setBreakdownPhotoLabels] = useState<Map<string, string>>(new Map());
  // True while a per-item recommended write-back (scene PUT) is in flight, so
  // the checkboxes disable to prevent racing PUTs.
  const [recommendBusy, setRecommendBusy] = useState(false);
  // #92 — offered solid colors per item type (from the bindings), fetched once.
  // With the live design scene it flags items we can't supply → blocks Send.
  const [offeredColors, setOfferedColors] = useState<OfferedColorLists | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/inventory/offered-colors')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setOfferedColors(d as OfferedColorLists | null); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // Fail OPEN: only gate when the offered catalog is positively known. A null/empty/
  // failed offered fetch (unconfigured bindings, cold start, network blip) must never
  // falsely flag every item or block Send — it just means "can't verify yet".
  const unfulfillable = useMemo(
    () => (offeredIsKnown(offeredColors) ? detectUnfulfillable(breakdownScene?.items ?? [], offeredFromLists(offeredColors)) : []),
    [breakdownScene, offeredColors],
  );
  const hasUnfulfillable = unfulfillable.length > 0;
  const hasNoPricedItems =
    !!result &&
    (result.total <= 0 ||
      !result.lineItems.some((item) => typeof item.amount === 'number' && item.amount > 0));
  // #5 client half — EventSection surfaces an advisory date-order warning
  // (takedown ≥ event ≥ install) but can't gate Send on its own; it lifts
  // validity here via onValidityChange so Send can be disabled for event quotes
  // with inverted dates. Defaults true (no warning) for holiday/permanent, which
  // never render EventSection and so never call the setter.
  const [eventDatesValid, setEventDatesValid] = useState(true);
  // The base64 photo the design currently carries (what we last pushed). Lets
  // the eager effect tell "new photo → create/replace" from re-renders, and
  // applyAnalysisResult tell "same photo re-analyzed → seed directly".
  const designPhotoRef = useRef<string | null>(null);
  // The latest analysis payload (roofline lines + per-unit detections),
  // waiting for the design to exist before it can seed (#35 Phase 2 — the
  // bridge auto-design; the roofline half keeps #33's picture-toggle alive).
  const pendingSeedRef = useRef<AnalysisSeed | null>(null);
  // Analysis PROVENANCE for the design (#8 Stage A): the raw AI result +
  // the satellite image/scale, persisted server-side so training capture
  // can assemble "what the AI originally said" from a reopened quote.
  // Parked here when the design doesn't exist yet (same dance as the seed).
  const pendingContextRef = useRef<DesignAnalysisContext | null>(null);
  // #204 review round: which address the currently-parked pendingContextRef
  // satellite was pulled for — client-only bookkeeping, NEVER sent to the
  // server (pushAnalysisContext's payload shape is unchanged). Stamped by
  // applyPulledSatellite whenever it parks (rather than directly pushes) a
  // satellite context; read by handlePhotoSelect to tell "same house, just a
  // different photo source" (preserve) apart from "the operator moved on to a
  // different address without re-pulling" (drop — the original wipe
  // behavior). Compared against form.customer.address (the live-typed field,
  // which changes on every keystroke) rather than googleAddress (which only
  // changes on a fresh successful geocode and would miss an address EDIT that
  // hasn't been re-pulled yet).
  const pendingSatelliteAddressRef = useRef<string | null>(null);
  // designId mirrored in a ref so async callbacks (e.g. the FileReader in the
  // manual satellite upload) read the CURRENT id at fire time, not the stale
  // one captured in their closure when a design was created mid-flight.
  const designIdRef = useRef<string | null>(initialQuote?.designId ?? null);
  const designPhotoOperationRef = useRef<Promise<void> | null>(null);
  const designPhotoChangeInProgressRef = useRef(false);
  const quoteSaveInProgressRef = useRef(false);
  const satelliteChangeInProgressRef = useRef(false);
  // Satellite uploads clear any older saved trace. Keep the latest request so
  // Calculate can wait for it (or retry it) before writing the new lines.
  const satelliteContextSaveRef = useRef<InFlightSatelliteSave | null>(null);
  const pushAnalysisContext = async (id: string, ctx: DesignAnalysisContext) => {
    if (!ctx.analysis && !ctx.satelliteBase64) return;
    const save = ctx.satelliteBase64
      ? (satelliteContextSaveRef.current?.promise ?? Promise.resolve())
          .catch(() => {})
          .then(() => saveAnalysisContext(id, ctx))
      : saveAnalysisContext(id, ctx);
    if (ctx.satelliteBase64) {
      satelliteContextSaveRef.current = { designId: id, context: ctx, promise: save };
    }
    try {
      await save;
    } catch {
      // Non-fatal: quoting works without provenance; only training capture
      // loses the "original analysis" half for this design. Calculate retries
      // satellite payloads because their image must precede the saved trace.
    }
  };
  // "Save as training example" feedback (#8 Stage A) — covers both the
  // manual button and the silent auto-capture at Send.
  const [trainStatus, setTrainStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [trainError, setTrainError] = useState<string | null>(null);
  // Optional "what did the AI get wrong here" note, typed at correction time —
  // the highest-signal training channel (a human explaining a miss), and the
  // reason training_examples.notes existed in the schema with zero fill for
  // 44 rows: there was nowhere to type it. Rides along on whichever capture
  // fires (manual button or the silent auto-capture at Send).
  const [trainNotes, setTrainNotes] = useState('');
  // The editor's flushSave (#8 Stage A M6), re-registered on each (re)mount.
  // Capture awaits it so it never snapshots a scene the 600ms autosave debounce
  // hasn't persisted yet.
  const editorFlushRef = useRef<(() => Promise<void>) | null>(null);
  // #741 defect 1: the editor's discardPending, re-registered alongside
  // flushSave on each (re)mount — see seedDesignFromAnalysis. Returns whether
  // it actually discarded a real pending edit (#741 defect 6).
  const editorDiscardRef = useRef<(() => boolean) | null>(null);
  const captureExample = async (source: 'auto-send' | 'manual') => {
    if (!savedQuoteId) return;
    setTrainStatus('saving');
    setTrainError(null);
    try {
      // Persist any pending design edit BEFORE the server reads designs.scene.
      // #110 W3-006 (sibling of #80-102): a flush rejection here would silently
      // snapshot a stale, pre-edit scene into the training example — warn
      // instead of proceeding as if it captured the operator's latest edits.
      if (editorFlushRef.current) {
        try {
          await editorFlushRef.current();
        } catch {
          setTrainStatus('error');
          setTrainError('Design may not have saved — retry before capturing');
          return;
        }
      }
      const res = await fetch('/api/training-examples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: savedQuoteId, source, notes: trainNotes.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Capture failed (${res.status})`);
      setTrainStatus('saved');
      setTrainNotes('');
    } catch (err) {
      setTrainStatus('error');
      setTrainError(err instanceof Error ? err.message : 'Capture failed');
    }
  };
  // #141 — the permanent-analyzer training loop's capture, kept SEPARATE from
  // captureExample above (different table/endpoint — this teaches the
  // permanent satellite analyzer, not the holiday one). Shares the same
  // trainStatus/trainError feedback state; the caller picks which fn to call
  // based on form.serviceType.
  const capturePermanentExample = async (source: 'auto-send' | 'manual') => {
    if (!savedQuoteId) return;
    setTrainStatus('saving');
    setTrainError(null);
    try {
      // Persist any pending design edit BEFORE the server reads designs.scene
      // (same reasoning as captureExample above).
      if (editorFlushRef.current) {
        try {
          await editorFlushRef.current();
        } catch {
          setTrainStatus('error');
          setTrainError('Design may not have saved — retry before capturing');
          return;
        }
      }
      const res = await fetch('/api/permanent-training-examples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: savedQuoteId, source, notes: trainNotes.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Capture failed (${res.status})`);
      setTrainStatus('saved');
      setTrainNotes('');
    } catch (err) {
      setTrainStatus('error');
      setTrainError(err instanceof Error ? err.message : 'Capture failed');
    }
  };

  // Push an analysis payload into the design as scene items (tagged roofline
  // strands + minis/wreaths/spritzers/garland at the detected spots). Server
  // replacement rules: roofline by TAG, per-unit by the seed- id prefix —
  // staff-drawn items always survive. Remounts the editor to show the result.
  const seedDesignFromAnalysis = async (id: string, seed: AnalysisSeed) => {
    try {
      // #741 defect 1 consequence B: flush any pending debounced edit BEFORE
      // the seed POST reads/replaces the scene server-side — same pattern
      // captureExample/capturePermanentExample already use above. This alone
      // only SHRINKS the stale-overwrite window (the analyze round trip is
      // multi-second); the discard below is what actually closes it.
      if (editorFlushRef.current) {
        try {
          await editorFlushRef.current();
        } catch {
          // best-effort — proceed with whatever was last persisted.
        }
      }
      const res = await fetch(`/api/designs/${id}/seed-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        // #90: warn when garland runs were seeded with no scale (billed as 1
        // section each) so staff set the real count before quoting.
        setGarlandUnestimated(
          typeof data.garlandSectionsUnestimated === 'number' ? data.garlandSectionsUnestimated : 0,
        );
        // #255: warn when this re-analyze orphaned a staff-created mini group
        // (its member strands weren't re-detected) — the group is gone, and
        // with it a real billed line, with no other indication.
        reportPrunedMiniGroups('reanalyze', data.prunedMiniGroups);
        // #741 defect 1: discard (never flush) whatever the OUTGOING editor
        // instance has pending before the key bump below tears it down — an
        // edit made during this multi-second analyze round trip must not be
        // written back over the scene the server just seeded/pruned.
        // #741 defect 6: tell the operator only when there was actually
        // something to throw away.
        if (editorDiscardRef.current?.()) {
          window.alert("An unsaved edit made during the re-analyze was discarded (it hadn't saved yet).");
        }
        setDesignEditorKey((k) => k + 1);
      } else {
        // Fix round (HIGH, four-lens review): `if (res.ok)` used to have no
        // else — a non-ok response (most commonly the #260 CAS's 409 when the
        // scene changed elsewhere during this multi-second analyze round
        // trip) fell through with nothing done. The catch below only sees
        // NETWORK errors (a thrown fetch); an ordinary HTTP error status
        // isn't one, so the AI-detected layout silently never applied and the
        // operator had no way to know. Surface the route's own message
        // (already actionable — e.g. "...reopen it and try again" on a
        // conflict) via the same designError banner the design-photo effect
        // above already uses for this design.
        const data = await res.json().catch(() => ({}));
        noteDesignLocked(data);
        setDesignError(data.error ?? 'The AI-detected layout could not be applied — reopen the design and try again');
      }
    } catch {
      // Non-fatal: the design still works, it just isn't pre-designed.
    }
  };

  // Eager design lifecycle: photo arrives → create the design with it (plus any
  // pending roofline seed); photo changes later (camera recapture / re-lookup)
  // → replace the existing design's base photo in place.
  useEffect(() => {
    if (!photoBase64 || !photoMediaType) {
      designPhotoChangeInProgressRef.current = false;
      return;
    }
    if (designPhotoRef.current === photoBase64) {
      designPhotoChangeInProgressRef.current = false;
      return;
    }
    designPhotoChangeInProgressRef.current = true;
    let stale = false;
    const push = async () => {
      setDesignBusy(true);
      setDesignError(null);
      try {
        if (!designId) {
          const res = await fetch('/api/designs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quoteId: savedQuoteId ?? undefined,
              photoBase64,
              photoMediaType,
              // The bridge auto-design (#35 Phase 2): the design is born
              // already designed from the analysis.
              seedAnalysis: pendingSeedRef.current ?? undefined,
              // #88 permanent has no analyzer to calibrate scale — seed a default
              // yardstick so the design opens with one to size, like holiday.
              seedDefaultYardstick: form.serviceType === 'permanent',
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Failed to create design');
          const id: string | undefined = data?.design?.id;
          if (!id) throw new Error('No design id returned');
          // If this run was superseded (photo changed again before create
          // finished), DON'T consume the parked seed/context or adopt this
          // design — leave the payloads intact so the replacement run seeds
          // its own design. The orphaned design row is harmless (no delete
          // API; same as lingering test designs).
          if (!stale) {
            pendingSeedRef.current = null;
            designPhotoRef.current = photoBase64;
            // #90: warn if garland runs were seeded with no scale on create.
            setGarlandUnestimated(
              typeof data.garlandSectionsUnestimated === 'number' ? data.garlandSectionsUnestimated : 0,
            );
            if (pendingContextRef.current) {
              const ctx = pendingContextRef.current;
              pendingContextRef.current = null;
              void pushAnalysisContext(id, ctx);
            }
            designIdRef.current = id;
            setDesignId(id);
          }
        } else {
          const res = await fetch(`/api/designs/${designId}/photo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photoBase64, photoMediaType }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Failed to update the design photo');
          // Superseded run: leave the parked seed/context for the replacement.
          if (stale) return;
          designPhotoRef.current = photoBase64;
          if (pendingSeedRef.current) {
            const seed = pendingSeedRef.current;
            pendingSeedRef.current = null;
            await seedDesignFromAnalysis(designId, seed);
          }
          if (pendingContextRef.current) {
            const ctx = pendingContextRef.current;
            pendingContextRef.current = null;
            void pushAnalysisContext(designId, ctx);
          }
          if (!stale) setDesignEditorKey((k) => k + 1);
        }
      } catch (err) {
        if (!stale) setDesignError(err instanceof Error ? err.message : 'Design photo update failed');
      } finally {
        if (!stale) setDesignBusy(false);
      }
    };
    const operation = push();
    designPhotoOperationRef.current = operation;
    void operation.then(() => {
      if (designPhotoOperationRef.current === operation) {
        designPhotoChangeInProgressRef.current = false;
      }
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoBase64, photoMediaType, designId, designPhotoRevision]);

  // Keep the designId ref in lockstep with state for async closures (L6).
  useEffect(() => {
    designIdRef.current = designId;
  }, [designId]);

  // Link the design to the quote once the quote has been saved (best-effort).
  useEffect(() => {
    if (!savedQuoteId || !designId) return;
    void fetch(`/api/designs/${designId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: savedQuoteId }),
    }).catch(() => {});
  }, [savedQuoteId, designId]);

  // (#35: the Gemini nighttime-render preview is gone — the live design IS the
  // customer-facing visual now; the app-wide render teardown is task #36.)
  const [fewShotCount, setFewShotCount] = useState(0);
  const [fewShotRanking, setFewShotRanking] = useState<'similarity' | 'recency'>('recency');
  // WT-33: similarity was EXPECTED (Voyage configured + a query image) but the
  // assembler still fell back to recency — a likely Voyage outage. Distinct
  // from the ordinary "small library, recency is normal" case so staff aren't
  // shown the same badge for both.
  const [fewShotDegraded, setFewShotDegraded] = useState(false);
  const [satellitePreview, setSatellitePreview] = useState<string | null>(null);
  const [googleAddress, setGoogleAddress] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  // Geocoded coords + current camera angle for Street View re-capture.
  // Used when the default angle is blocked by trees, parked cars, etc.
  const [geoLat, setGeoLat] = useState<number | null>(null);
  const [geoLng, setGeoLng] = useState<number | null>(null);
  const [svHeading, setSvHeading] = useState<number | null>(null);
  const [svPitch, setSvPitch] = useState<number>(0);
  const [svFov, setSvFov] = useState<number>(80);
  // Camera (panorama) location for Street View. Starts at the house coords and
  // moves along the street via #15 — distinct from geoLat/geoLng (the house =
  // the aim target + Maps link + analysis coords, which never move).
  const [svLat, setSvLat] = useState<number | null>(null);
  const [svLng, setSvLng] = useState<number | null>(null);
  const [recapturing, setRecapturing] = useState(false);
  // Satellite polylines (editable from top-down view — better for commercial
  // properties and complex rooflines where a street-view angle misses the back).
  const [satelliteSantasLines, setSatelliteSantasLines] = useState<LineSegment[]>([]);
  const [satelliteGingerbreadLines, setSatelliteGingerbreadLines] = useState<LineSegment[]>([]);
  const [satelliteC9Lines, setSatelliteC9Lines] = useState<LineSegment[]>([]);
  const [satelliteStakeLines, setSatelliteStakeLines] = useState<LineSegment[]>([]);
  // Permanent Lighting (#88 / S23): the four house-side rooflines traced on the
  // satellite view. Each feeds its side's footage (× feet-per-pixel) + corners
  // (vertex count) into form.permanent, and persists to the design for the portal.
  const [permanentSatLines, setPermanentSatLines] = useState<Record<PermanentSideKey, LineSegment[]>>({
    front: [], left: [], right: [], back: [],
  });
  // Tracks whether each side had lines on the previous derive so removing the
  // last run resets that side's footage/corners (mirrors hadC9LinesRef below).
  const hadPermLinesRef = useRef<Record<PermanentSideKey, boolean>>({
    front: false, left: false, right: false, back: false,
  });
  // PS-B1: whether permanentSatLines reflects a settled trace state, so the
  // billed-but-untraced warning (below) doesn't flash true for every reopened
  // permanent quote while the #142 rehydrate fetch is still in flight. A new
  // (non-edit) quote has nothing to hydrate, so it's ready immediately; an
  // edit-mode quote flips ready once the rehydrate effect settles (found
  // lines, found none, or errored — any outcome still means "now accurate").
  const [permTraceHydrated, setPermTraceHydrated] = useState(!editMode);
  // Permanent Bistro Lighting (#117): freeform bistro-run polylines traced on
  // the satellite view — the BILLING source (true-scale feet-per-pixel, no
  // yardstick). One flat array of runs (not per-side, unlike permanent's four
  // sides) since a bistro run isn't tied to a house side. The Design tab's
  // bistro strand stays visual-only for the portal, mirroring permanent's split.
  const [satelliteBistroLines, setSatelliteBistroLines] = useState<LineSegment[]>([]);
  // #140 P3: the analyzer's jump/splitter detections — what pure geometry can't
  // see. Session-scoped extras for the Extensions/Splitters derive; the DERIVED
  // counts persist on form.permanent (saved on Calculate), so nothing is lost
  // across sessions even though the raw detections aren't stored.
  const [permanentAiExtras, setPermanentAiExtras] = useState<{ splitters: number; jumpsFt: number[] }>({
    splitters: 0,
    jumpsFt: [],
  });
  // #142: reopened-quote satellite REHYDRATE freeze. Rehydrating the persisted
  // satellite (image + lines + scale) makes the two permanent derive effects
  // fire against state the operator hasn't touched — which would clobber saved
  // values (a hand-typed footage override, or auto counts derived with the AI
  // jump extras that are session-only by design). Frozen = both derives no-op;
  // the FIRST user line edit (or a fresh address pull / Recount) thaws, and
  // from there numbers follow the visible geometry exactly like a live session.
  const permDeriveFrozenRef = useRef(false);
  // The same #142 freeze, for the HOLIDAY satellite rehydrate below. Holiday's
  // derive recomputes santas/gingerbread/C9/stake footage from the satellite
  // polylines, so hydrating a reopened quote's saved lines would re-derive and
  // MOVE its billed footage on load — clobbering a hand-typed override, and (for
  // a self-serve estimate, whose footage came from the STREET analysis) silently
  // repricing the quote to the satellite total the moment staff opened it.
  // Frozen = the derive no-ops; the first real line edit thaws it (see getSetter).
  const holidayDeriveFrozenRef = useRef(false);
  // Deterministic scale from Google Static Maps zoom-20 formula; no user
  // calibration needed. See analyze-address route for the math.
  const [satelliteFeetPerPixel, setSatelliteFeetPerPixel] = useState<number | null>(null);
  const [satelliteAspect, setSatelliteAspect] = useState<number>(1);
  // The top box's active tab (#35): the DESIGN (street photo in the editor) or
  // the SATELLITE measurement canvas. Both stay mounted across switches so
  // neither loses state. Measurement comes from satellite lines or manual
  // typing only — street is no longer a measurement source.
  const [viewMode, setViewMode] = useState<'design' | 'satellite'>('design');

  // Drag state for editing satellite polyline points
  type LineType = 'santas' | 'gingerbread' | 'c9' | 'stake' | 'bistro' | PermanentSideKey;
  const [dragging, setDragging] = useState<{ type: LineType; lineIdx: number; ptIdx: number } | null>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [addMode, setAddMode] = useState<LineType | null>(null);
  const [pendingPoints, setPendingPoints] = useState<[number, number][]>([]);
  const satelliteTraceVersionRef = useRef(0);
  // Scroll-wheel zoom + drag-to-pan for the satellite measurement box (#26).
  // Pan/zoom are paused while placing points (addMode) so clicks add points.
  const satWrapperRef = useRef<HTMLDivElement>(null);
  const satZoom = useImageZoomPan(satWrapperRef, { disabled: !!addMode });

  // Tracks whether C9 lines existed on the previous effect run, so deleting
  // the last C9 line resets the derived footage instead of leaving a stale
  // value behind. (Manual entry without any lines is still preserved.)
  const hadC9LinesRef = useRef(false);
  const hadStakeLinesRef = useRef(false);
  const hadSantasLinesRef = useRef(false);
  const hadGingerbreadLinesRef = useRef(false);
  // Permanent Bistro Lighting (#117): mirrors hadC9LinesRef — deleting the last
  // bistro run resets the billed array to [] instead of leaving a stale value.
  const hadBistroLinesRef = useRef(false);
  // #244: per-run reconcile baseline (run id -> its derived footage as of the
  // last reconcile) — the array analog of the holiday/permanent scalar
  // "already equals the target" check, but keyed by id so ONE run's redraw
  // can't clobber an override on ANOTHER. See reconcileFootage.ts and the
  // rehydrate-seed comment in getSetter('bistro') below.
  const prevBistroDerivedRef = useRef<Record<string, number>>({});
  // Row 333: baseline reconcile for the four holiday satellite footage
  // fields (santas/gingerbread/C9/stake) — the scalar analog of
  // prevBistroDerivedRef above. Each field's baseline is the derived footage
  // recorded at its own last reconcile, so redrawing ONE field's lines can't
  // clobber a hand-typed override on an UNTOUCHED field even though all four
  // share one derive effect. See reconcileFootage.ts and the rehydrate-seed
  // comment in getSetter below.
  const prevHolidayDerivedRef = useRef<HolidayFootageBaseline>({});
  // Row 345: baseline reconcile for the four permanent house sides' footage +
  // corners (8 fields) — the scalar analog of prevHolidayDerivedRef above,
  // for the OTHER shared-effect derive that had the same flaw (permanentSatLines
  // holds all four sides in one object, so redrawing one side re-fires the
  // whole effect). See reconcileSideFootage.ts and the rehydrate-seed comment
  // in getSetter(side) below.
  const prevPermSideDerivedRef = useRef<PermanentSideFootageBaseline>({});
  // Row 379 (S48 #921 delta-verify MED): the satellite scale that
  // prevPermSideDerivedRef's FOOTAGE entries were actually computed under —
  // `undefined` until first seeded/derived. Footage is scale-derived
  // (deriveSideMeasure); corners is not. Reading this alongside a fresh
  // derive run lets the effect below tell "this side's own geometry changed"
  // apart from "the satellite scale changed out from under an untouched
  // baseline" — the latter is reachable across a service-type switch (reopen
  // permanent frozen -> switch to permanent_bistro before the first edit
  // thaws it -> a fresh street lookup pulls a NEW scale and thaws via
  // thawPermDerive -> switch back to permanent), and without this, a pure
  // scale artifact looks identical to a redraw and silently reprices the
  // side. See reconcileSideFootage.ts's `scaleChanged` for the actual guard.
  const prevPermSideScaleRef = useRef<number | null | undefined>(undefined);

  // Recompute footages from the SATELLITE lines (#35: the only line-measurement
  // source — deterministic feet-per-pixel × image pixel width). When there's no
  // satellite, the footage fields are plain manual inputs.
  useEffect(() => {
    if (satelliteFeetPerPixel == null) return;
    const sFt = Math.round(polylineLength(satelliteSantasLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    const gFt = Math.round(polylineLength(satelliteGingerbreadLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    const c9Ft = Math.round(polylineLength(satelliteC9Lines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    const stakeFt = Math.round(polylineLength(satelliteStakeLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    // When C9 lines are drawn, footage tracks them. When the last line is
    // deleted (had lines on the previous run, none now), reset footage to 0 —
    // it was derived from those lines. When no lines were ever drawn, leave
    // winterWonderlandFootage alone so the manual input still works. Stake
    // Lighting mirrors this exactly against its own field. Santa's/Gingerbread
    // roofline mirror it too (#110 W3-001) — an address-lookup analysis with a
    // street-traced roofline sets a real AI footage estimate with no satellite
    // lines drawn; without this guard this effect unconditionally zeroed it.
    const hasC9Lines = satelliteC9Lines.length > 0;
    const hadC9Prev = hadC9LinesRef.current;
    hadC9LinesRef.current = hasC9Lines;
    const hasStakeLines = satelliteStakeLines.length > 0;
    const hadStakePrev = hadStakeLinesRef.current;
    hadStakeLinesRef.current = hasStakeLines;
    const hasSantasLines = satelliteSantasLines.length > 0;
    const hadSantasPrev = hadSantasLinesRef.current;
    hadSantasLinesRef.current = hasSantasLines;
    const hasGingerbreadLines = satelliteGingerbreadLines.length > 0;
    const hadGingerbreadPrev = hadGingerbreadLinesRef.current;
    hadGingerbreadLinesRef.current = hasGingerbreadLines;
    // #142-style rehydrate freeze (holiday). Deliberately placed AFTER the four
    // had*LinesRef updates: the refs must record the hydrated geometry even while
    // frozen, so that once the operator thaws it, deleting the last line still
    // resets that footage to 0 instead of leaving a stale value. Loading a quote
    // must never move its billed numbers — only an actual edit may.
    if (holidayDeriveFrozenRef.current) return;
    // C9 Custom-Runs + Stake are HOLIDAY-only (the event/permanent engines don't
    // price winterWonderland/stakeLighting — event allow-list is santas/gingerbread
    // rooflines only). Never derive those two fields from a satellite draw on a
    // non-holiday quote, or footage would silently persist unbilled (finding #1).
    //
    // Row 333 fix (S46 premerge, finding 2, technical MED): compute the
    // reconcile + the baseline update HERE, synchronously, using the
    // render-closure `form` — not inside the setForm functional updater
    // using `f`. React StrictMode dev double-invokes a setState updater to
    // check purity: it discards the FIRST call's return value, but not any
    // side effect the call performed. Mutating prevHolidayDerivedRef from
    // inside the updater let the discarded first call pre-advance the
    // baseline, so the kept second call compared against an
    // already-advanced baseline and misclassified a genuine redraw as a
    // standing override, silently no-op'ing it (dev-only; prod never
    // double-invokes). The updater below is now a pure function of `f` with
    // no side effects, so being double-invoked is harmless. Mirrors the
    // prevBistroDerivedRef fix below.
    const isHoliday = form.serviceType === 'holiday';
    // Row 333: baseline-keyed per-field reconcile (reconcileFootage.ts) —
    // replaces the old direct billed-vs-fresh-target comparison, which
    // couldn't tell "staff typed an override" apart from "this field's own
    // geometry changed" and so clobbered an untouched field's override
    // whenever a DIFFERENT field's lines redrew (all four share this one
    // effect/dependency list).
    const baseline = prevHolidayDerivedRef.current;
    const santas = reconcileHolidayFootageField({
      active: true,
      hasLines: hasSantasLines,
      hadLinesPrev: hadSantasPrev,
      freshFt: sFt,
      currentBilled: form.santasFootage,
      baseline: baseline.santas,
    });
    const gingerbread = reconcileHolidayFootageField({
      active: true,
      hasLines: hasGingerbreadLines,
      hadLinesPrev: hadGingerbreadPrev,
      freshFt: gFt,
      currentBilled: form.gingerbreadFootage,
      baseline: baseline.gingerbread,
    });
    const c9 = reconcileHolidayFootageField({
      active: isHoliday,
      hasLines: hasC9Lines,
      hadLinesPrev: hadC9Prev,
      freshFt: c9Ft,
      currentBilled: form.winterWonderlandFootage,
      baseline: baseline.c9,
    });
    const stake = reconcileHolidayFootageField({
      active: isHoliday,
      hasLines: hasStakeLines,
      hadLinesPrev: hadStakePrev,
      freshFt: stakeFt,
      currentBilled: form.stakeLightingFootage,
      baseline: baseline.stake,
    });
    // Row 333 fix (finding 1, staff HIGH): MERGE into the previous baseline —
    // an inactive field (C9/stake off-holiday) keeps its existing baseline
    // key untouched, so toggling service type away and back can't drop it.
    // See mergeHolidayFootageBaseline's own comment for the full defect.
    const activeByField: Record<HolidayFootageFieldKey, boolean> = {
      santas: true,
      gingerbread: true,
      c9: isHoliday,
      stake: isHoliday,
    };
    const resultsByField: Record<HolidayFootageFieldKey, HolidayFieldReconcileResult> = {
      santas, gingerbread, c9, stake,
    };
    prevHolidayDerivedRef.current = mergeHolidayFootageBaseline(baseline, activeByField, resultsByField);
    if (santas.target == null && gingerbread.target == null && c9.target == null && stake.target == null) return;
    // defer so the form update isn't synchronous within the effect (flushes before paint)
    queueMicrotask(() => setForm(f => ({
      ...f,
      ...(santas.target != null ? { santasFootage: santas.target } : {}),
      ...(gingerbread.target != null ? { gingerbreadFootage: gingerbread.target } : {}),
      ...(c9.target != null ? { winterWonderlandFootage: c9.target } : {}),
      ...(stake.target != null ? { stakeLightingFootage: stake.target } : {}),
    })));
    // form.{santasFootage,gingerbreadFootage,winterWonderlandFootage,stakeLightingFootage,serviceType}
    // are read intentionally (S46 finding 2 fix) but must NOT be dependencies —
    // this effect derives from satellite GEOMETRY only; adding the billed
    // fields would re-fire it on every manual override/service-type change
    // too, which is exactly the over-firing this reconcile exists to survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [satelliteSantasLines, satelliteGingerbreadLines, satelliteC9Lines, satelliteStakeLines, satelliteFeetPerPixel, satelliteAspect]);

  // Footage readout for the satellite tab.
  const satFootage = {
    santas: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteSantasLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
    ginger: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteGingerbreadLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
  };

  // Permanent Bistro Lighting (#117): one run's OWN footage (never summed with
  // others), same math as the billing-derive effect below — used for the
  // Satellite tab's read-only per-run list so what the operator sees always
  // matches what gets billed.
  const bistroRunFootage = (line: LineSegment): number | null =>
    satelliteFeetPerPixel != null
      ? roundFootageUpTo5(polylineLength([line], satelliteAspect) * SAT_PX * satelliteFeetPerPixel)
      : null;

  // Row 333: same rounding formula as the holiday derive effect below, factored
  // out so the getSetter thaw-seed (right below) can't drift from it. 0 when
  // there's no satellite scale yet, matching the derive effect's own early bail.
  const computeHolidaySatFt = (lines: LineSegment[]): number =>
    satelliteFeetPerPixel != null
      ? Math.round(polylineLength(lines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5
      : 0;

  // Row 333 reopen-clobber guard (mirrors #244's bistro seed above): while
  // still frozen (#142), prevHolidayDerivedRef has never been seeded for
  // these PERSISTED fields — rehydrate sets the satellite line arrays
  // directly and never runs the derive effect while frozen. Without this
  // seed, the FIRST post-reopen edit on ANY one of the four fields would see
  // the OTHER three as having no recorded baseline, treat them as new, and
  // stamp their freshly re-derived footage over any saved manual override.
  // Called before thawing, from all four holiday-line getSetter branches
  // below (not just the touched one), so every field's baseline is seeded
  // together.
  const seedHolidayBaselineIfFrozen = () => {
    if (!holidayDeriveFrozenRef.current) return;
    const isHoliday = form.serviceType === 'holiday';
    prevHolidayDerivedRef.current = deriveHolidayFootageBaseline({
      santas: { hasLines: satelliteSantasLines.length > 0, freshFt: computeHolidaySatFt(satelliteSantasLines) },
      gingerbread: { hasLines: satelliteGingerbreadLines.length > 0, freshFt: computeHolidaySatFt(satelliteGingerbreadLines) },
      c9: { active: isHoliday, hasLines: satelliteC9Lines.length > 0, freshFt: computeHolidaySatFt(satelliteC9Lines) },
      stake: { active: isHoliday, hasLines: satelliteStakeLines.length > 0, freshFt: computeHolidaySatFt(satelliteStakeLines) },
    });
  };

  // Row 345 reopen-clobber guard (mirrors seedHolidayBaselineIfFrozen above,
  // and #244's bistro seed): while still frozen (#142), prevPermSideDerivedRef
  // has never been seeded for these PERSISTED sides — rehydrate sets
  // permanentSatLines directly and never runs the derive effect while frozen.
  // Without this seed, the FIRST post-reopen edit on ANY one of the four
  // sides would see the OTHER three as having no recorded baseline, treat
  // them as new, and stamp their freshly re-derived footage/corners over any
  // saved manual override. Called before thawing, from the isPermanentSide
  // getSetter branch below (for every side, not just the touched one), so
  // every field's baseline is seeded together. Seeds from the CURRENT
  // (pre-edit) lines/scale/aspect, same as the bistro seed.
  //
  // Row 379: `scale` defaults to the current closure's satelliteFeetPerPixel,
  // but a caller that JUST called setSatelliteFeetPerPixel(newScale) earlier
  // in the SAME synchronous handler (a fresh address lookup) must pass that
  // new value explicitly — setState doesn't flush mid-handler, so the
  // closure's satelliteFeetPerPixel is still the OLD scale at this point,
  // and seeding under it would stamp the baseline with a scale that's
  // already stale the instant this function returns. See the
  // permanent_bistro fresh-lookup call site below for the reachable case.
  // Row 405: the per-side baseline the CURRENT lines/scale would derive to,
  // as a pure read. Extracted from the seed below rather than duplicated so
  // the row-405 confirm and the thaw seed can never drift apart — a drift here
  // would mean the dialog naming different fields than the reconcile actually
  // overwrites, which is worse than no dialog.
  const computePermanentSideBaseline = (scale: number | null = satelliteFeetPerPixel) => {
    const sides = {} as Record<PermanentSideKey, { hasLines: boolean; footage: number | null; corners: number }>;
    for (const side of PERMANENT_SIDES) {
      const lines = permanentSatLines[side];
      const m = deriveSideMeasure(lines, scale, satelliteAspect);
      sides[side] = { hasLines: lines.length > 0, footage: m.footage, corners: m.corners };
    }
    return derivePermanentSideFootageBaseline(sides);
  };

  const seedPermanentSideBaselineIfFrozen = (scale: number | null = satelliteFeetPerPixel) => {
    if (!permDeriveFrozenRef.current) return;
    prevPermSideDerivedRef.current = computePermanentSideBaseline(scale);
    prevPermSideScaleRef.current = scale;
  };

  // Row 405 (premerge staff-lens HIGH): the baseline the override check must
  // read is NOT simply `prevPermSideDerivedRef.current`. That ref is seeded
  // lazily — only at the rehydrate-thaw, i.e. the first real line edit of the
  // session, or a Recount. On a REOPENED quote that nobody has touched yet it
  // is still EMPTY, and an empty baseline makes every field look brand-new,
  // so the check would report zero overrides and stay silent — inert for the
  // exact scenario row 405 is about (reopen, hand-typed override, re-analyze a
  // different address). While frozen, derive the baseline from the current
  // lines the same way the thaw seed would; once thawed, the ref is the truth.
  const effectivePermanentSideBaseline = () =>
    permDeriveFrozenRef.current ? computePermanentSideBaseline() : prevPermSideDerivedRef.current;

  // Row 345 finding 2: permDeriveFrozenRef is shared by THREE independent
  // consumers — the permanent-side footage/corners derive above (line
  // ~1942), the permanent accessories derive (line ~2032, no baseline
  // concept of its own), and the permanent_bistro derive (its own baseline,
  // prevBistroDerivedRef, seeded separately in the 'bistro' branch below).
  // Every site that thaws the ref is a place the footage/corners derive can
  // next fire from — an UNRELATED touch (a bistro edit, a Recount click)
  // still shares this one ref, so if the seed above isn't called first,
  // that next footage/corners run sees an EMPTY baseline for all four
  // sides, treats every one of them as brand-new, and stamps fresh
  // geometry over any hand-typed override — even on a side nobody touched.
  // Reachable exactly this way through the "Recount from drawn lines"
  // button (PermanentSection's accessories recount, wired to onRecount
  // below), which used to clear the ref directly with no seed at all.
  // Route every thaw through this helper instead of setting the ref
  // directly, so the seed can never be forgotten at a new call site again.
  //
  // ONE class of exception, three sites (verified by grep at the 2026-08-24
  // master re-sync, after #849/#866/#871/#874 added two more): a thaw that
  // REPLACES all four sides' lines wholesale in the same breath — the fresh
  // analyze below, and the two satellite-replacement paths (manual upload,
  // address re-pull, both of which warn the operator that traced footage will
  // reset). Those stay PLAIN thaws on purpose, but by TWO DIFFERENT safety
  // mechanisms, not one — row 399 shipped from conflating them:
  //   - The two satellite-replacement paths wipe every side to `[]` FIRST.
  //     The next derive run sees hasLines=false with hadLinesPrev=true, so
  //     the reconcile's own delete-transition resets each field to 0 before
  //     canDerive/scaleChanged are ever consulted — safe regardless of any
  //     scale change alongside it.
  //   - The fresh-analyze site does NOT wipe first — it replaces with the
  //     AI's fresh (usually non-empty) trace directly, so hasLines is often
  //     TRUE on the very next run. That path is safe only because it ALSO
  //     resets prevPermSideDerivedRef/prevPermSideScaleRef to their
  //     brand-new (unseeded) state in the same breath (row 399 fix) — see
  //     that site's own comment for why seeding there would be wrong, not
  //     merely unnecessary.
  // Row 379: `scale` (when passed) forwards straight to
  // seedPermanentSideBaselineIfFrozen — see that function's own comment for
  // why the permanent_bistro fresh-lookup call site below must pass one
  // explicitly instead of relying on the default.
  const thawPermDerive = (scale?: number | null) => {
    seedPermanentSideBaselineIfFrozen(scale);
    permDeriveFrozenRef.current = false;
  };

  // Line setters — satellite-only now (#35): street lines are gone, the design
  // owns the street-side visuals.
  const getSetter = (type: LineType): ((updater: (lines: LineSegment[]) => LineSegment[]) => void) => {
    satelliteTraceVersionRef.current += 1;
    // #142 thaw (holiday): the operator touched the lines, so footage may follow
    // the visible geometry again — same live-session rule as the permanent
    // branches below. Until then the rehydrate freeze keeps a reopened quote's
    // saved footage exactly as staff left it.
    if (type === 'santas') {
      return (updater) => {
        seedHolidayBaselineIfFrozen();
        holidayDeriveFrozenRef.current = false;
        setSatelliteSantasLines(updater);
        // SHADOW MODE: the operator just redrew these lines — the note
        // describing the old ones is stale the moment this fires.
        setSatelliteFootageDisagreement((prev) => (prev.santas == null ? prev : { ...prev, santas: null }));
      };
    }
    if (type === 'gingerbread') {
      return (updater) => {
        seedHolidayBaselineIfFrozen();
        holidayDeriveFrozenRef.current = false;
        setSatelliteGingerbreadLines(updater);
        // SHADOW MODE: same as above, for the gingerbread/ridge roofline.
        setSatelliteFootageDisagreement((prev) => (prev.gingerbread == null ? prev : { ...prev, gingerbread: null }));
      };
    }
    if (type === 'stake') {
      return (updater) => {
        seedHolidayBaselineIfFrozen();
        holidayDeriveFrozenRef.current = false;
        setSatelliteStakeLines(updater);
      };
    }
    if (type === 'bistro') {
      return (updater) => {
        // #244 reopen-clobber guard: while still frozen (#142), the reconcile
        // baseline (prevBistroDerivedRef) has never been seeded for these
        // PERSISTED runs — rehydrate sets satelliteBistroLines directly and
        // never runs the derive effect while frozen. Without this seed, the
        // FIRST post-reopen edit would see every existing run as having no
        // recorded baseline, treat all of them as "new", and stamp their
        // freshly re-derived footage straight over any saved manual override
        // (the S24 reopen-clobber class). Seed from the CURRENT (pre-edit)
        // lines/scale/aspect — by the time a human can click-drag a line, the
        // satellite <img> has already fired onLoad and corrected
        // satelliteAspect away from its 1:1 default. The seed decision itself
        // is the pure, tested deriveBistroFootageMap (reconcileFootage.ts,
        // #244 premerge finding 3) — this repo has no component-render
        // harness for QuoteBuilder.tsx, so the regression coverage lives on
        // that extracted function, composed with reconcileBistroFootage in
        // reconcileFootage.test.ts's rehydrate -> first-edit -> derive test.
        if (permDeriveFrozenRef.current) {
          prevBistroDerivedRef.current = deriveBistroFootageMap(satelliteBistroLines, bistroRunFootage);
        }
        // #142 thaw: the operator touched the lines — footage follows the
        // visible geometry again (live-session rules), mirroring the
        // permanent-side branch below. Also seeds the permanent-SIDE baseline
        // (row 345 finding 2) even though this branch only fires on a
        // permanent_bistro quote — permDeriveFrozenRef is shared, and it's
        // strictly safer for a later service-type switch back to 'permanent'
        // to inherit a real seeded baseline than an empty one.
        thawPermDerive();
        setSatelliteBistroLines(updater);
      };
    }
    if (isPermanentSide(type)) {
      return (updater) => {
        // Row 345 reopen-clobber guard: seed the reconcile baseline from the
        // CURRENT (pre-edit) lines BEFORE thawing — see
        // seedPermanentSideBaselineIfFrozen's own comment above. No-ops when
        // not frozen (a live session already has a real baseline).
        thawPermDerive();
        setPermanentSatLines((pl) => ({ ...pl, [type]: updater(pl[type]) }));
      };
    }
    // C9 custom runs — same holiday thaw as the three branches above.
    return (updater) => {
      seedHolidayBaselineIfFrozen();
      holidayDeriveFrozenRef.current = false;
      setSatelliteC9Lines(updater);
    };
  };
  const activeSantasLines = satelliteSantasLines;
  const activeGingerbreadLines = satelliteGingerbreadLines;
  const activeC9Lines = satelliteC9Lines;
  const activeStakeLines = satelliteStakeLines;

  // Permanent Lighting (#88 / S23): derive each side's footage + corners from its
  // satellite trace → form.permanent. Footage needs the satellite scale (address
  // pulls have it); corners are scale-free. A side with no lines this session is
  // left alone (a manual/persisted value wins); removing the last run resets it
  // to 0. Mirrors the holiday hadRef reset pattern above.
  //
  // Row 345 fix (sibling of the row 333 holiday fix above): this effect shares
  // ONE dependency list across all four sides (permanentSatLines is one object
  // holding all four), so redrawing e.g. the front roofline re-fires the whole
  // effect — the OLD logic compared each field's CURRENT BILLED value straight
  // against its freshly re-derived target with no baseline, so it couldn't tell
  // "staff typed an override on an untouched side" apart from "this side's own
  // geometry changed," and silently clobbered the former. Same flaw, same fix:
  // reconcilePermanentSideField (reconcileSideFootage.ts) reconciles each of
  // the 8 fields (footage + corners × 4 sides) against its OWN baseline.
  //
  // Compute the reconcile + the baseline update HERE, synchronously, using the
  // render-closure `form.permanent` — not inside the setForm functional
  // updater. React StrictMode dev double-invokes a setState updater to check
  // purity: it discards the FIRST call's return value, but not any side effect
  // the call performed. Mutating prevPermSideDerivedRef from inside the
  // updater would let the discarded first call pre-advance the baseline, so
  // the kept second call would compare against an already-advanced baseline
  // and misclassify a genuine redraw as a standing override, silently
  // no-op'ing it (dev-only; prod never double-invokes). Mirrors the holiday
  // and bistro fixes' own S46 finding-2 comment.
  useEffect(() => {
    if (form.serviceType !== 'permanent') return;
    if (permDeriveFrozenRef.current) return; // #142: rehydrated, untouched — saved values win
    const baseline = prevPermSideDerivedRef.current;
    const hasScale = satelliteFeetPerPixel != null;
    // Row 379: baseline's footage entries were computed under
    // prevPermSideScaleRef.current — if that's not undefined (something has
    // been seeded/derived before) and it disagrees with the scale in effect
    // THIS run, any freshValue/baseline mismatch below is a scale artifact,
    // not proof this side was redrawn. See reconcileSideFootage.ts's
    // `scaleChanged` doc for what the guard actually does with this.
    const scaleChanged =
      prevPermSideScaleRef.current !== undefined && prevPermSideScaleRef.current !== satelliteFeetPerPixel;
    const p = form.permanent;

    const front = deriveSideMeasure(permanentSatLines.front, satelliteFeetPerPixel, satelliteAspect);
    const left = deriveSideMeasure(permanentSatLines.left, satelliteFeetPerPixel, satelliteAspect);
    const right = deriveSideMeasure(permanentSatLines.right, satelliteFeetPerPixel, satelliteAspect);
    const back = deriveSideMeasure(permanentSatLines.back, satelliteFeetPerPixel, satelliteAspect);
    const hasFront = permanentSatLines.front.length > 0;
    const hasLeft = permanentSatLines.left.length > 0;
    const hasRight = permanentSatLines.right.length > 0;
    const hasBack = permanentSatLines.back.length > 0;
    const hadFrontPrev = hadPermLinesRef.current.front;
    const hadLeftPrev = hadPermLinesRef.current.left;
    const hadRightPrev = hadPermLinesRef.current.right;
    const hadBackPrev = hadPermLinesRef.current.back;
    hadPermLinesRef.current = { front: hasFront, left: hasLeft, right: hasRight, back: hasBack };

    // Row 345 finding 1 fix: `active` (in-scope — always true here, the
    // effect's own gate above already confirmed serviceType === 'permanent')
    // is now separate from `canDerive` (whether a fresh value exists this
    // run). Footage's canDerive is gated on a known satellite scale
    // (deriveSideMeasure returns footage: null with none — a manual
    // satellite upload); corners is scale-free and always derivable while
    // its side has lines. See reconcileSideFootage.ts's header comment for
    // why folding these into one flag (the pre-fix design) made a
    // no-scale delete-transition unreachable.
    const frontFootage = reconcilePermanentSideField({ active: true, canDerive: hasScale, hasLines: hasFront, hadLinesPrev: hadFrontPrev, freshValue: front.footage ?? 0, currentBilled: p.frontFootage, baseline: baseline.frontFootage, scaleChanged });
    const frontCorners = reconcilePermanentSideField({ active: true, canDerive: true, hasLines: hasFront, hadLinesPrev: hadFrontPrev, freshValue: front.corners, currentBilled: p.frontCorners, baseline: baseline.frontCorners });
    const leftFootage = reconcilePermanentSideField({ active: true, canDerive: hasScale, hasLines: hasLeft, hadLinesPrev: hadLeftPrev, freshValue: left.footage ?? 0, currentBilled: p.leftFootage, baseline: baseline.leftFootage, scaleChanged });
    const leftCorners = reconcilePermanentSideField({ active: true, canDerive: true, hasLines: hasLeft, hadLinesPrev: hadLeftPrev, freshValue: left.corners, currentBilled: p.leftCorners, baseline: baseline.leftCorners });
    const rightFootage = reconcilePermanentSideField({ active: true, canDerive: hasScale, hasLines: hasRight, hadLinesPrev: hadRightPrev, freshValue: right.footage ?? 0, currentBilled: p.rightFootage, baseline: baseline.rightFootage, scaleChanged });
    const rightCorners = reconcilePermanentSideField({ active: true, canDerive: true, hasLines: hasRight, hadLinesPrev: hadRightPrev, freshValue: right.corners, currentBilled: p.rightCorners, baseline: baseline.rightCorners });
    const backFootage = reconcilePermanentSideField({ active: true, canDerive: hasScale, hasLines: hasBack, hadLinesPrev: hadBackPrev, freshValue: back.footage ?? 0, currentBilled: p.backFootage, baseline: baseline.backFootage, scaleChanged });
    const backCorners = reconcilePermanentSideField({ active: true, canDerive: true, hasLines: hasBack, hadLinesPrev: hadBackPrev, freshValue: back.corners, currentBilled: p.backCorners, baseline: baseline.backCorners });

    // MERGE into the previous baseline (row 333 finding 1 precedent) — but
    // unlike the holiday merge above, EVERY field passes active: true here.
    // Row 345 finding 1 fix moved "leave an undeliverable field's baseline
    // alone" INTO reconcilePermanentSideField itself (the canDerive: false
    // branch echoes the baseline back unchanged), so this merge no longer
    // needs its own scale-gated skip — and must not have one: a
    // scale-gated skip would silently un-apply the delete-transition's
    // explicit baseline clear (nextBaseline: undefined) whenever a side had
    // no known scale, resurrecting finding 1 at the merge layer instead of
    // the reconcile layer. See mergePermanentSideFootageBaseline's own
    // comment in reconcileSideFootage.ts.
    const activeByField: Record<PermanentSideFieldKey, boolean> = {
      frontFootage: true, frontCorners: true,
      leftFootage: true, leftCorners: true,
      rightFootage: true, rightCorners: true,
      backFootage: true, backCorners: true,
    };
    const resultsByField: Record<PermanentSideFieldKey, PermanentSideFieldReconcileResult> = {
      frontFootage, frontCorners, leftFootage, leftCorners, rightFootage, rightCorners, backFootage, backCorners,
    };
    prevPermSideDerivedRef.current = mergePermanentSideFootageBaseline(baseline, activeByField, resultsByField);
    // Row 379: record the scale THIS run's footage entries are now
    // consistent with, but only when a real scale actually drove them
    // (hasScale) — when it's false every footage field just echoed its prior
    // value through unchanged (the canDerive: false branch), so the scale
    // that value is still denominated in hasn't changed and this ref must
    // not be overwritten with the current (no-scale) null.
    if (hasScale) prevPermSideScaleRef.current = satelliteFeetPerPixel;

    const anyTarget = Object.values(resultsByField).some((r) => r.target != null);
    if (!anyTarget) return;
    // defer so the form update isn't synchronous within the effect (flushes before paint)
    queueMicrotask(() =>
      setForm((f) => {
        if (f.serviceType !== 'permanent') return f;
        const cur = f.permanent;
        let n = cur;
        if (frontFootage.target != null) n = { ...n, frontFootage: frontFootage.target };
        if (frontCorners.target != null) n = { ...n, frontCorners: frontCorners.target };
        if (leftFootage.target != null) n = { ...n, leftFootage: leftFootage.target };
        if (leftCorners.target != null) n = { ...n, leftCorners: leftCorners.target };
        if (rightFootage.target != null) n = { ...n, rightFootage: rightFootage.target };
        if (rightCorners.target != null) n = { ...n, rightCorners: rightCorners.target };
        if (backFootage.target != null) n = { ...n, backFootage: backFootage.target };
        if (backCorners.target != null) n = { ...n, backCorners: backCorners.target };
        // Row 400: whichever fields THIS run actually stamped just got
        // written by the system, not staff — mark them 'auto'. A field
        // whose target stayed null (a standing override held, canDerive
        // was false, or nothing changed) is left alone; its existing
        // provenance, if any, survives untouched.
        const stampedFields = (Object.keys(resultsByField) as PermanentSideFieldKey[]).filter(
          (k) => resultsByField[k].target != null,
        );
        if (stampedFields.length > 0) {
          const nextSource: Partial<Record<PermanentSideFieldKey, 'auto' | 'manual'>> = {
            ...(n.sideMeasureSource ?? {}),
          };
          for (const k of stampedFields) nextSource[k] = 'auto';
          n = { ...n, sideMeasureSource: nextSource };
        }
        return n === cur ? f : { ...f, permanent: n };
      }),
    );
    // form.permanent.{front,left,right,back}{Footage,Corners} are read
    // intentionally (row 345 fix, mirrors the holiday/bistro effects above)
    // but must NOT be dependencies — this effect derives from satellite
    // GEOMETRY only; adding the billed fields would re-fire it on every
    // manual override/service-type change too, which is exactly the
    // over-firing this reconcile exists to survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permanentSatLines, satelliteFeetPerPixel, satelliteAspect, form.serviceType]);

  // #140: derive the Extensions/Splitters card counts from the DRAWN geometry —
  // satellite plan-corners/junctions/jumps + street gable cuts (peak-only, so
  // the two sources can't double-count). Pure math lives in trackAccessories.ts;
  // this is a thin dispatcher with the same value-equality guard as the footage
  // effect above. 'manual' provenance pauses it (the operator owns the counts;
  // the card's Recount button hands ownership back by setting 'auto').
  //
  // SESSION GATE: only derives while a satellite session is live
  // (satellitePreview set — an address pull / satellite upload this session).
  // A REOPENED quote does not rehydrate permanentSatLines, so deriving there
  // would clobber the saved auto counts with a weaker view (street-only, or
  // zeros) — same reason the footage effect above leaves reopened sides alone.
  useEffect(() => {
    if (form.serviceType !== 'permanent') return;
    if (satellitePreview == null) return;
    if (permDeriveFrozenRef.current) return; // #142: rehydrated, untouched — saved counts win
    if (form.permanent?.accessoriesSource === 'manual') return;
    const streetStrandPoints = (breakdownScene?.items ?? [])
      .filter((i) => isStrand(i) && i.bulbType === 'permanent' && !isLinkedTwin(i))
      .map((i) => ({ points: (i as { points: number[] }).points ?? [] }));
    const signal = hasAccessorySignal(permanentSatLines, streetStrandPoints);
    const acc = deriveTrackAccessories({
      satelliteLines: permanentSatLines,
      satelliteFeetPerPixel,
      satelliteAspect,
      streetStrandPoints,
      extras: permanentAiExtras, // #140 P3: AI jumps + splitter branch points
    });
    queueMicrotask(() =>
      setForm((f) => {
        if (f.serviceType !== 'permanent' || f.permanent.accessoriesSource === 'manual') return f;
        // Never stamp 'auto' on an untouched quote with nothing drawn — that
        // would flip a legacy stored quote off its gaps-driven BOM path.
        if (!signal && f.permanent.accessoriesSource === undefined) return f;
        const cur = f.permanent;
        const same =
          cur.accessoriesSource === 'auto' &&
          cur.extensions?.e3 === acc.e3 &&
          cur.extensions?.e5 === acc.e5 &&
          cur.extensions?.e10 === acc.e10 &&
          cur.extensions?.e25 === acc.e25 &&
          (cur.splittersNeeded ?? 0) === acc.splitters &&
          (cur.jumpBoosters ?? 0) === acc.jumpBoosters;
        if (same) return f;
        return {
          ...f,
          permanent: {
            ...cur,
            extensions: { e3: acc.e3, e5: acc.e5, e10: acc.e10, e25: acc.e25 },
            splittersNeeded: acc.splitters,
            jumpBoosters: acc.jumpBoosters,
            accessoriesSource: 'auto',
          },
        };
      }),
    );
  }, [
    permanentSatLines,
    satelliteFeetPerPixel,
    satelliteAspect,
    satellitePreview,
    breakdownScene,
    permanentAiExtras,
    form.serviceType,
    form.permanent?.accessoriesSource,
  ]);

  // Permanent Bistro Lighting (#117, editable footage #244): derive each
  // drawn run's OWN footage (per run — never summed into one side total,
  // unlike permanent) from its satellite trace, and RECONCILE it onto
  // form.permanentBistro.bistro — the BILLING source (the Design tab's
  // bistro strand there stays visual-only, mirroring permanent's split; see
  // the route's design-projection exemption). Guard chain: NOT frozen (#142
  // rehydrate) AND a known satellite scale AND a LIVE satellite session
  // (satellitePreview != null — the S24/S25 clobber-class guard: a
  // reopened-but-untouched quote must never have its saved footage
  // overwritten by "nothing drawn this session" math).
  //
  // #244: unlike the holiday/permanent scalar derives, this is an ARRAY —
  // redrawing ANY run re-fires this whole effect (satelliteBistroLines is
  // one shared array), so a naive "always overwrite" would clobber a
  // hand-typed override on every OTHER, untouched run. reconcileBistroFootage
  // (pure, tested) reconciles BY RUN ID against prevBistroDerivedRef (the
  // per-id "last known derived value" baseline): an untouched run's override
  // survives; a run whose OWN geometry changed has its override reset (staff
  // redraw wins — the same call as the holiday precedent). See getSetter
  // ('bistro') above for how the baseline is seeded on a reopened quote's
  // first post-rehydrate edit, so this can't clobber a saved override on load.
  useEffect(() => {
    if (form.serviceType !== 'permanent_bistro') return;
    if (permDeriveFrozenRef.current) return; // #142: rehydrated, untouched — saved values win
    if (satelliteFeetPerPixel == null) return; // no known scale — manual typing only
    if (satellitePreview == null) return; // no live satellite session — nothing to derive from
    const hasLines = satelliteBistroLines.length > 0;
    // Never drawn this session (no lines now, and none were had) — leave the
    // saved array alone rather than resetting it to empty.
    if (!hasLines && !hadBistroLinesRef.current) return;
    hadBistroLinesRef.current = hasLines;
    // Each run carries its stable id (#117 MED) so the billed line item id
    // (and this reconcile's override tracking) follows the run across a
    // mid-list delete, not its position. Empty when the last run was just
    // deleted — reconcileBistroFootage resets the billed array to [] too.
    const freshRuns = satelliteBistroLines.map((line) => ({
      id: line.id,
      footage: roundFootageUpTo5(polylineLength([line], satelliteAspect) * SAT_PX * satelliteFeetPerPixel),
    }));
    // Row 333 fix (S46 premerge, finding 2, technical MED — sibling parity
    // with the holiday effect above): compute the reconcile and mutate
    // prevBistroDerivedRef HERE, synchronously, using the render-closure
    // `form` — not inside the setForm functional updater using `f`. See the
    // holiday effect's comment above for the full StrictMode
    // double-invoke-of-a-setState-updater explanation this mirrors.
    const priorBaseline = prevBistroDerivedRef.current;
    const { next, nextBaseline } = reconcileBistroFootage(freshRuns, form.permanentBistro.bistro, priorBaseline);
    prevBistroDerivedRef.current = nextBaseline;
    const cur = form.permanentBistro.bistro;
    const same =
      cur.length === next.length &&
      cur.every((b, i) => b.footage === next[i].footage && b.id === next[i].id);
    if (same) return;
    queueMicrotask(() =>
      setForm((f) => {
        if (f.serviceType !== 'permanent_bistro') return f;
        return { ...f, permanentBistro: { ...f.permanentBistro, bistro: next } };
      }),
    );
    // form.permanentBistro.bistro is read intentionally (S46 finding 2 fix)
    // but must NOT be a dependency — same reasoning as the holiday effect
    // above: this effect derives from satellite GEOMETRY only, and adding
    // the billed array would re-fire it on every override too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [satelliteBistroLines, satelliteFeetPerPixel, satelliteAspect, satellitePreview, form.serviceType]);

  // #142: REHYDRATE the satellite tab on a reopened permanent (or, #117,
  // permanent_bistro) quote. The design row persists everything the tab needs
  // (image path → signed URL, the traced lines, the pull scale), so a saved
  // quote's lines come back EDITABLE instead of a blank tab that needed a
  // fresh (billable) address re-pull. Derives stay FROZEN until the operator
  // actually edits (see permDeriveFrozenRef above) — loading a quote must
  // never move its numbers. The freeze is set BEFORE the hydrating setState
  // calls below (both branches) — that ordering is the entire point: a
  // reopened quote's saved billing numbers must never move on load.
  useEffect(() => {
    const isPermanentBistro = form.serviceType === 'permanent_bistro';
    if (!editMode || (form.serviceType !== 'permanent' && !isPermanentBistro)) return;
    let stale = false;
    (async () => {
      if (!designId || satellitePreview != null) {
        // Nothing to hydrate (no design yet) or already hydrated/live this
        // session — either way permanentSatLines is already accurate, so the
        // PS-B1 billed-but-untraced warning can trust it now. Set inside the
        // async body (not synchronously in the effect) to avoid cascading renders.
        if (!stale) setPermTraceHydrated(true);
        return;
      }
      try {
        const res = await fetch(`/api/designs/${designId}`);
        if (!res.ok) return;
        const data = await res.json();
        const d = data?.design;
        if (stale || !d?.satelliteUrl) return;
        const sl = d.satelliteLines ?? {};
        if (isPermanentBistro) {
          const bistroLines: LineSegment[] = sl.bistro ?? [];
          if (bistroLines.length === 0) return; // nothing traced — keep the old blank-tab behavior
          permDeriveFrozenRef.current = true; // freeze BEFORE hydrating (see comment above)
          hadBistroLinesRef.current = true;
          setSatelliteBistroLines(bistroLines);
          setSatelliteFeetPerPixel(d.satelliteFeetPerPixel ?? null);
          setSatellitePreview(d.satelliteUrl);
          return;
        }
        const lines: Record<PermanentSideKey, LineSegment[]> = {
          front: sl.front ?? [],
          left: sl.left ?? [],
          right: sl.right ?? [],
          back: sl.back ?? [],
        };
        if (!PERMANENT_SIDES.some((s) => lines[s].length > 0)) return; // nothing traced — keep the old blank-tab behavior
        permDeriveFrozenRef.current = true; // freeze BEFORE hydrating (see comment above)
        for (const side of PERMANENT_SIDES) hadPermLinesRef.current[side] = lines[side].length > 0;
        setPermanentSatLines(lines);
        setSatelliteFeetPerPixel(d.satelliteFeetPerPixel ?? null);
        setSatellitePreview(d.satelliteUrl);
      } catch (err) {
        // Best-effort: a failed rehydrate just leaves the pre-#142 blank tab.
        console.error('[QuoteBuilder] satellite rehydrate failed:', err);
      } finally {
        // PS-B1: this rehydrate attempt is settled (found lines, found none,
        // 404'd, or errored) — permanentSatLines now reflects the real trace
        // state either way, so the billed-but-untraced warning can trust it.
        if (!stale) setPermTraceHydrated(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [editMode, designId, satellitePreview, form.serviceType]);

  // REHYDRATE the satellite tab on a reopened HOLIDAY quote — the sibling of the
  // permanent rehydrate above. The design row already persists the satellite
  // image, its pull scale and the traced polylines (staff draws them, and a
  // self-serve estimate seeds them server-side), but nothing read them back for
  // holiday: the tab came up empty and the traced measurement behind a saved
  // quote was invisible, so verifying one meant a fresh billable address re-pull.
  //
  // Derives stay FROZEN until the operator actually edits (holidayDeriveFrozenRef),
  // and the freeze is set BEFORE the hydrating setState calls — that ordering is
  // the whole point. Holiday's derive recomputes footage from these very lines,
  // so without it, merely OPENING a quote would move its billed footage: a
  // hand-typed override would be overwritten, and a self-serve quote (whose
  // footage came from the street analysis) would silently reprice to the
  // satellite total.
  useEffect(() => {
    if (!editMode || form.serviceType !== 'holiday') return;
    let stale = false;
    (async () => {
      // Nothing to hydrate (no design yet) or already hydrated/live this session.
      if (!designId || satellitePreview != null) return;
      try {
        const res = await fetch(`/api/designs/${designId}`);
        if (!res.ok) return;
        const data = await res.json();
        const d = data?.design;
        if (stale || !d?.satelliteUrl) return;
        const sl = d.satelliteLines ?? {};
        const santas: LineSegment[] = sl.santas ?? [];
        const gingerbread: LineSegment[] = sl.gingerbread ?? [];
        const c9: LineSegment[] = sl.c9 ?? [];
        const stake: LineSegment[] = sl.stake ?? [];
        // Nothing traced — keep the old blank-tab behavior rather than showing
        // an empty canvas over a satellite image.
        if (santas.length + gingerbread.length + c9.length + stake.length === 0) return;
        holidayDeriveFrozenRef.current = true; // freeze BEFORE hydrating (see above)
        hadSantasLinesRef.current = santas.length > 0;
        hadGingerbreadLinesRef.current = gingerbread.length > 0;
        hadC9LinesRef.current = c9.length > 0;
        hadStakeLinesRef.current = stake.length > 0;
        setSatelliteSantasLines(santas);
        setSatelliteGingerbreadLines(gingerbread);
        setSatelliteC9Lines(c9);
        setSatelliteStakeLines(stake);
        setSatelliteFeetPerPixel(d.satelliteFeetPerPixel ?? null);
        setSatellitePreview(d.satelliteUrl);
      } catch (err) {
        // Best-effort: a failed rehydrate just leaves the previous blank tab.
        console.error('[QuoteBuilder] holiday satellite rehydrate failed:', err);
      }
    })();
    return () => {
      stale = true;
    };
  }, [editMode, designId, satellitePreview, form.serviceType]);

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: PointerEvent) => {
      const rect = imgContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const setter = getSetter(dragging.type);
      setter(lines => lines.map((line, i) =>
        i === dragging.lineIdx
          ? { ...line, points: line.points.map((p, j) => j === dragging.ptIdx ? [x, y] as [number, number] : p) }
          : line
      ));
    };
    const handleUp = () => setDragging(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const deletePoint = (type: LineType, lineIdx: number, ptIdx: number) => {
    const setter = getSetter(type);
    setter(lines => lines.map((line, i) =>
      i === lineIdx ? { ...line, points: line.points.filter((_, j) => j !== ptIdx) } : line
    ).filter(line => line.points.length >= 2));
  };

  const deleteLine = (type: LineType, lineIdx: number) => {
    const setter = getSetter(type);
    setter(lines => lines.filter((_, i) => i !== lineIdx));
  };

  // Fix round (PR #916, staff lens MED): wholesale-clear every segment for
  // one satellite roofline type at once, for the case the new segmented
  // prompt is meant to help with — a badly over-segmented trace is faster to
  // clear and redraw than to delete one-by-one. Routes through the SAME
  // getSetter(type) path deleteLine uses above, so it fires identically to a
  // one-at-a-time delete: the #918 disagreement-note clearing (getSetter's
  // santas/gingerbread branches) and the thaw/baseline-seed logic every other
  // line mutation goes through.
  const clearAllLines = (type: LineType) => {
    const setter = getSetter(type);
    setter(() => []);
  };

  const updateLineLabel = (type: LineType, lineIdx: number, label: string) => {
    const setter = getSetter(type);
    setter(lines => lines.map((line, i) => i === lineIdx ? { ...line, label } : line));
  };

  // #244: hand-edit a bistro run's BILLED footage, keyed by its stable run
  // id — mirrors the holiday `set('santasFootage', ...)` idiom but targets
  // one entry inside form.permanentBistro.bistro instead of a top-level
  // scalar. Does NOT touch satelliteBistroLines/scale, so it never re-fires
  // the derive effect above (typing an override is not a redraw). Upserts:
  // most edits update an existing entry, but with no satellite scale the
  // derive effect never creates one (its top-level guard), so a fully manual
  // entry is created here on first edit.
  const updateBistroRunFootage = (runId: string | undefined, footage: number) => {
    if (!runId) return; // no stable id — nothing to target (see reconcileFootage.ts)
    setForm((f) => {
      if (f.serviceType !== 'permanent_bistro') return f;
      const idx = f.permanentBistro.bistro.findIndex((b) => b.id === runId);
      const bistro =
        idx >= 0
          ? f.permanentBistro.bistro.map((b, i) => (i === idx ? { ...b, footage } : b))
          : [...f.permanentBistro.bistro, { id: runId, footage }];
      return { ...f, permanentBistro: { ...f.permanentBistro, bistro } };
    });
  };

  // #244: a run's BILLED footage — the value form.permanentBistro.bistro
  // actually carries for this run's id (which may be a hand-typed override),
  // falling back to the pure geometry-derived value when no billed entry
  // exists yet (e.g. no satellite scale — manual-only — or the derive
  // effect's queued microtask hasn't landed yet).
  const billedBistroFootage = (line: LineSegment): number | null => {
    const entry = line.id ? form.permanentBistro.bistro.find((b) => b.id === line.id) : undefined;
    return entry ? entry.footage : bistroRunFootage(line);
  };

  const handleImageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!addMode) return;
    const rect = imgContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setPendingPoints(prev => [...prev, [x, y]]);
  };

  const finishAddingLine = () => {
    if (!addMode || pendingPoints.length < 2) {
      setAddMode(null);
      setPendingPoints([]);
      return;
    }
    const newLine: LineSegment = {
      points: pendingPoints,
      label: isPermanentSide(addMode) ? `${PERMANENT_SIDE_META[addMode].label} roofline`
        : addMode === 'bistro' ? `Run ${satelliteBistroLines.length + 1}`
        : addMode === 'santas' ? 'new gutterline' : addMode === 'gingerbread' ? 'new ridgeline' : addMode === 'stake' ? 'new stake run' : 'new c9 run',
      // #117 MED: a bistro run carries a STABLE id so its billed line item id
      // (and any #104 per-line price/free override keyed on it) survives a
      // mid-list run delete. Without it, the engine synthesizes POSITIONAL ids
      // (permanent-bistro-<index>) that re-index on delete, silently
      // reattaching an override to the wrong run. Other line types derive
      // footage per-side/per-scene, so they never need this.
      ...(addMode === 'bistro' ? { id: crypto.randomUUID() } : {}),
    };
    const setter = getSetter(addMode);
    setter(lines => [...lines, newLine]);
    setAddMode(null);
    setPendingPoints([]);
  };

  const cancelAdd = () => {
    setAddMode(null);
    setPendingPoints([]);
  };

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (quoteSaveInProgressRef.current) {
      e.target.value = '';
      setAnalysisError('Wait for the quote save to finish, then select the street photo.');
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setAnalysisNotes(null);
    setAnalysisError(null);
    setAnalysisWarning(null);
    // #97: a manual street-photo upload swaps ONLY the street/design photo — it
    // does NOT touch the satellite tab. Keep any prior (address-pulled or
    // manually-uploaded) satellite image, traced lines, and scale, so swapping a
    // bad Google street view for a better photo of the SAME house keeps the good
    // satellite + its measurements. (Use the satellite upload slot to replace it
    // if it's actually for a different house.)
    setGoogleAddress(null);
    setPhotoBase64(null);
    setPhotoMediaType(null);
    setFewShotCount(0);
    // Manual upload has no Google coords — hide the rotation controls.
    setGeoLat(null);
    setGeoLng(null);
    setSvLat(null);
    setSvLng(null);
    // A parked ANALYSIS belongs to the PREVIOUS photo (about to be replaced) —
    // drop it. A parked SATELLITE-only context (#204: "Pull satellite", the
    // no-Street-View fallback, or a manual satellite upload) belongs to the
    // ADDRESS/house, not the street photo — the #97 promise above ("keeps the
    // good satellite intact") covers its PERSISTED provenance too, so it
    // survives a manual street-photo swap for the SAME house instead of being
    // silently dropped before a design ever exists to receive it (the eager
    // design effect only creates/updates a design once photoBase64 is set,
    // which a satellite-only pull never does — so without this, the pulled
    // satellite's image/scale would never reach the design row at all, even
    // though the LIVE satelliteFeetPerPixel state stays correct).
    //
    // #204 review round (gap 2, HIGH portal): "same house" must be CHECKED,
    // not assumed — the operator may have edited the address field after the
    // pull without re-pulling (typing alone never re-geocodes), and house A's
    // satellite must never persist onto house B's design. Compared against
    // form.customer.address (changes on every keystroke) rather than
    // googleAddress: googleAddress only changes on a fresh successful
    // geocode, so it would still read "house A" here and miss an
    // edited-but-not-yet-re-pulled address.
    const preservedSatellite = satelliteContextAfterPhotoChange(
      pendingContextRef.current,
      pendingSatelliteAddressRef.current,
      form.customer.address,
    );
    pendingContextRef.current = preservedSatellite.context;
    pendingSatelliteAddressRef.current = preservedSatellite.address;
  };

  // Manual satellite upload (#9): a second photo slot so manually-photographed
  // houses also carry a satellite into the design + training capture. No known
  // scale (unlike the Google pull) — staff trace the layout for training value
  // and type the footage manually; the existing img onLoad sets the aspect.
  const handleSatelliteSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    if (quoteSaveInProgressRef.current || satelliteChangeInProgressRef.current) {
      input.value = '';
      setAnalysisError('Wait for the current satellite or quote save to finish, then try again.');
      return;
    }
    const hasAnyLines = satelliteLinesHaveContent({
      santas: satelliteSantasLines,
      gingerbread: satelliteGingerbreadLines,
      c9: satelliteC9Lines,
      stake: satelliteStakeLines,
      bistro: satelliteBistroLines,
      permanent: permanentSatLines,
    });
    // Every replacement invalidates existing geometry. A Google-scale image
    // also invalidates its measured footage even when nothing was drawn.
    if (satellitePreview != null && (satelliteFeetPerPixel != null || hasAnyLines)) {
      const ok = window.confirm(
        'Replace the satellite image? The traced roofline + footage will reset.',
      );
      if (!ok) { input.value = ''; return; }
    }
    input.value = ''; // allow re-picking the same file
    satelliteChangeInProgressRef.current = true;
    void (async () => {
      try {
        // #186: downscale before base64-encoding — see clientImage.ts.
        const { dataUrl, mediaType } = await downscaleForUpload(file);
        const comma = dataUrl.indexOf(',');
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        setSatellitePreview(dataUrl);
        setSatelliteSantasLines([]);
        setSatelliteGingerbreadLines([]);
        // SHADOW MODE: the old lines this note described are gone.
        setSatelliteFootageDisagreement({ santas: null, gingerbread: null });
        setSatelliteC9Lines([]);
        setSatelliteStakeLines([]);
        setSatelliteBistroLines([]);
        hadBistroLinesRef.current = false;
        holidayDeriveFrozenRef.current = false;
        permDeriveFrozenRef.current = false;
        setPermanentSatLines({ front: [], left: [], right: [], back: [] });
        setSatelliteFeetPerPixel(null); // manual = no known scale
        const satCtx = { satelliteBase64: base64, satelliteMediaType: mediaType, satelliteFeetPerPixel: null };
        // Read the CURRENT design id (L6) — a design may have been created while
        // downscaleForUpload was decoding. uploadDesignSatellite also clears the
        // design's stale satellite_lines so a captured example can't overlay old
        // Google lines on the new image (M4).
        const id = designIdRef.current;
        if (id) {
          void pushAnalysisContext(id, satCtx);
        } else {
          const parked = parkSatelliteContext(
            pendingContextRef.current,
            satCtx,
            form.customer.address,
          );
          pendingContextRef.current = parked.context;
          pendingSatelliteAddressRef.current = parked.address;
        }
      } catch {
        setAnalysisError("Couldn't read that satellite image. Try selecting it again.");
      } finally {
        satelliteChangeInProgressRef.current = false;
      }
    })();
  };

  // Re-fetch Street View at a new heading/pitch/fov — lets the user rotate
  // around obstacles (trees, parked cars, scaffolding) blocking the default
  // angle. Does NOT re-run Claude; user can manually edit lines or click
  // "Re-analyze" after to let Claude remeasure the new angle.
  const recaptureStreetView = async (patch: { heading?: number | null; pitch?: number; fov?: number }) => {
    if (geoLat == null || geoLng == null) return;
    // null heading means "reset to Google's auto heading"; absent means "keep current".
    const nextHeading = patch.heading === null ? null : (patch.heading ?? svHeading);
    const nextPitch = patch.pitch ?? svPitch;
    const nextFov = patch.fov ?? svFov;
    setRecapturing(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    try {
      const res = await fetch('/api/streetview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Rotate/tilt/zoom happen at the CURRENT camera (which may have moved
          // along the street via #15), not always the house-nearest pano.
          lat: svLat ?? geoLat, lng: svLng ?? geoLng,
          heading: nextHeading ?? undefined,
          pitch: nextPitch,
          fov: nextFov,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Street View refetch failed');
      // Any roofline seed from a PREVIOUS analysis belongs to the old camera
      // angle — drop it so it can't land on the new photo. (The eager design
      // effect will push this photo into the design as its new base.)
      pendingSeedRef.current = null;
      setPhotoPreview(`data:${data.photoMediaType};base64,${data.photoBase64}`);
      const photoNeedsSave = !!(
        data.photoBase64 &&
        data.photoMediaType &&
        designPhotoRef.current !== data.photoBase64
      );
      designPhotoChangeInProgressRef.current = photoNeedsSave;
      if (photoNeedsSave) setDesignPhotoRevision((revision) => revision + 1);
      setPhotoBase64(data.photoBase64);
      setPhotoMediaType(data.photoMediaType);
      setSvHeading(nextHeading);
      setSvPitch(nextPitch);
      setSvFov(nextFov);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Street View refetch failed');
    } finally {
      setRecapturing(false);
    }
  };

  // #15 — move the camera one panorama along the street (perpendicular to the
  // camera→house look) and re-aim at the house, to shoot around a tree/truck the
  // rotate-in-place angle can't clear. Like recapture: swaps the base photo,
  // drops the stale seed, no Claude re-analysis. `reachedEnd` = edge of coverage.
  const moveStreetView = async (direction: 'left' | 'right') => {
    if (geoLat == null || geoLng == null) return;
    setRecapturing(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    try {
      const res = await fetch('/api/streetview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          camLat: svLat ?? geoLat, camLng: svLng ?? geoLng,
          houseLat: geoLat, houseLng: geoLng,
          pitch: svPitch, fov: svFov,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Street View move failed');
      if (data.reachedEnd) {
        setAnalysisWarning('No further Street View this way — reached the edge of Google’s coverage.');
        return;
      }
      pendingSeedRef.current = null;
      setPhotoPreview(`data:${data.photoMediaType};base64,${data.photoBase64}`);
      const photoNeedsSave = !!(
        data.photoBase64 &&
        data.photoMediaType &&
        designPhotoRef.current !== data.photoBase64
      );
      designPhotoChangeInProgressRef.current = photoNeedsSave;
      if (photoNeedsSave) setDesignPhotoRevision((revision) => revision + 1);
      setPhotoBase64(data.photoBase64);
      setPhotoMediaType(data.photoMediaType);
      setSvLat(data.camLat);
      setSvLng(data.camLng);
      setSvHeading(typeof data.heading === 'number' ? data.heading : null);
      setSvPitch(typeof data.pitch === 'number' ? data.pitch : svPitch);
      setSvFov(typeof data.fov === 'number' ? data.fov : svFov);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Street View move failed');
    } finally {
      setRecapturing(false);
    }
  };

  // #13: grab the ADJACENT panorama (aimed at the house) as an EXTRA photo of
  // the design — without moving the main camera or touching the base photo
  // (moveStreetView/recapture REPLACE the base via the eager design effect;
  // this deliberately routes around that). The editor remounts (key bump) so
  // its photo strip picks up the new tab; staff draw the side angle there.
  const [savingVantage, setSavingVantage] = useState(false);
  const saveVantageAsExtra = async (direction: 'left' | 'right') => {
    if (geoLat == null || geoLng == null || !designId || savingVantage) return;
    setSavingVantage(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    try {
      const res = await fetch('/api/streetview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          camLat: svLat ?? geoLat, camLng: svLng ?? geoLng,
          houseLat: geoLat, houseLng: geoLng,
          pitch: svPitch, fov: svFov,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Street View fetch failed');
      if (data.reachedEnd) {
        setAnalysisWarning('No further Street View this way — reached the edge of Google’s coverage.');
        return;
      }
      const post = await fetch(`/api/designs/${designId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoBase64: data.photoBase64, photoMediaType: data.photoMediaType }),
      });
      const pdata = await post.json();
      if (!post.ok) throw new Error(pdata.error ?? 'Could not save the extra photo');
      // Remount the editor so its photo strip shows the new tab.
      setDesignEditorKey((k) => k + 1);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Could not save the extra photo');
    } finally {
      setSavingVantage(false);
    }
  };

  // Re-run Claude analysis on the current street view image (after user rotated
  // to a clearer angle). Uses the same base64 already loaded — no extra fetch.
  const reanalyzeCurrent = async () => {
    if (!photoBase64 || !photoMediaType) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    setAnalysisNotes(null);
    try {
      // Reconstruct a File-like blob so the existing /api/analyze-photo flow works.
      const byteString = atob(photoBase64);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
      const blob = new Blob([bytes], { type: photoMediaType });
      const fd = new FormData();
      fd.append('photo', blob, 'streetview.jpg');
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await readUploadErrorMessage(res, 'Analysis failed'));
      const data = await res.json();
      // #88/#117: only holiday + event seed from the holiday analyzer — permanent
      // and permanent bistro design manually, so an analyzer result here (this
      // route carries no serviceType gate of its own) is intentionally discarded
      // rather than seeded onto their designs (mirrors handleLookupAddress below).
      if (data.result && (form.serviceType === 'holiday' || form.serviceType === 'event')) {
        applyAnalysisResult(data);
      } else if (data.result) {
        setAnalysisNotes('Re-analyzed, but this quote type designs manually — nothing was auto-seeded.');
      } else {
        // FAIL-SAFE: analyzer unavailable on re-analyze — keep the existing photo
        // + design intact and just surface the notice (nothing to re-seed).
        setAnalysisWarning(
          data.analysisError ??
            'The auto-design analyzer is temporarily unavailable — keep designing manually, or try Re-analyze again shortly.',
        );
      }
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  // Shared: apply analysis result to the form + satellite state + the design
  // seed. Used by both manual upload and Google address lookup.
  // #35 Phase 2 (the bridge auto-design): the AI's street roofline lines AND
  // its per-unit detections all feed the DESIGN as scene items — the design
  // opens already designed; staff refine. #8 (Phase 3) upgrades the AI brain
  // on top of this same plumbing.
  type DetectionBox = [number, number, number, number];
  type AnalysisResponse = {
    result?: {
      santasFootage: number;
      santasDifficulty: 'easy' | 'medium' | 'hard';
      gingerbreadFootage: number;
      gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
      santasLines?: LineSegment[];
      gingerbreadLines?: LineSegment[];
      satelliteSantasLines?: LineSegment[];
      satelliteGingerbreadLines?: LineSegment[];
      satelliteSantasFootage?: number;
      satelliteGingerbreadFootage?: number;
      // SHADOW MODE (deterministic-satellite-footage): informational only —
      // never fed back into form/pricing state, just surfaced in the notes
      // banner below so staff can see when the model's stated satellite
      // footage disagrees with what its own drawn lines measure.
      satelliteSantasFootageDisagrees?: boolean;
      satelliteGingerbreadFootageDisagrees?: boolean;
      computedSatelliteSantasFootage?: number | null;
      computedSatelliteGingerbreadFootage?: number | null;
      preferredSource?: 'street' | 'satellite';
      miniLightDetections?: { type: 'tree' | 'bush' | 'column' | 'railing'; wrapStyle: 'canopy' | 'trunk'; stringCount: number; box: DetectionBox }[];
      wreathDetections?: { size: string; tier: string; box: DetectionBox }[];
      spritzerDetections?: { size: string; box: DetectionBox }[];
      garlandDetections?: { length: string; tier: string; box: DetectionBox }[];
      notes: string;
      confidence: string;
    } | null;
    // Fail-safe: present when the analyzer was unavailable (result is null) — the
    // imagery still came back so staff can design manually.
    analysisError?: string;
    analysisUnavailable?: boolean;
    photoBase64?: string;
    photoMediaType?: string;
    satelliteBase64?: string;
    satelliteMediaType?: string;
    satelliteFeetPerPixel?: number;
    formattedAddress?: string;
    lat?: number;
    lng?: number;
    // #88: permanent address lookup returns imagery only (Street View + satellite
    // + scale) with no holiday analysis/seed — the operator draws the roofline.
    permanentImageryOnly?: boolean;
    fewShotCount?: number;
    fewShotBreakdown?: { ranking?: 'similarity' | 'recency'; degraded?: boolean };
  };
  const applyAnalysisResult = (data: AnalysisResponse) => {
    if (!data.result) return; // fail-safe: analyzer was unavailable, nothing to seed
    const r = data.result;
    // Row 209: drawn satellite geometry outranks the AI's street-photo text
    // estimate. A street-only analyze (analyze-photo) never touches
    // satelliteSantasLines/satelliteGingerbreadLines (the #97/#190 guards
    // below), so if satellite lines already exist for a field, the
    // measurement effect (~line 1990) is already the sole authority over its
    // billed footage — its dependency array never moves on a street
    // re-analyze, so it can't self-correct a clobber from this write. The
    // gate (reconcileAnalysisFootage) has to live right here, at the write.
    const footageFromAnalysis = reconcileAnalysisFootage({
      aiSantasFootage: r.santasFootage,
      aiGingerbreadFootage: r.gingerbreadFootage,
      hasSatelliteSantasLines: satelliteSantasLines.length > 0,
      hasSatelliteGingerbreadLines: satelliteGingerbreadLines.length > 0,
      // Fix round (staff MED): scale-less manual-satellite lines (#9, traced
      // "for training value") derive nothing — same bail the measurement
      // effect makes — so they must not suppress the AI estimate.
      satelliteHasScale: satelliteFeetPerPixel != null,
    });
    // The AI's footage estimates pre-fill the inputs (only when no satellite
    // geometry already exists for that field — see above); satellite lines
    // (when present) take over via the measurement effect, and staff can
    // always type.
    setForm(f => ({
      ...f,
      ...footageFromAnalysis,
      // Jason, 2026-08-27: an analysis moves FOOTAGE and nothing else. It used
      // to adopt the analyzer's own difficulty read (`r.santasDifficulty` /
      // `r.gingerbreadDifficulty`), so re-analyzing a house could silently flip
      // a roofline from Easy $8/ft to Medium $10/ft with no person involved —
      // and #102's companion `santasCustomRate: 0` / `gingerbreadCustomRate: 0`
      // then wiped a $/ft a staff member had typed by hand. Both are gone:
      // roofline difficulty and any custom rate are now purely manual, changed
      // only by a staff member using the dropdown / rate field. New quotes
      // start at BUSINESS_RULES.rooflineDefaultDifficulty (Easy).
    }));
    // Satellite polylines — seed them so the satellite tab is ready for
    // complex / commercial rooflines without re-analyzing. #97: only (re)set the
    // satellite tab when THIS analysis actually carried satellite data (an address
    // pull). A manual street-photo analyze (analyze-photo) carries none, so leave
    // the existing satellite image, lines, and scale intact.
    // #190 (prod incident, quote ef73b2de): the ORIGINAL #97 guard counted
    // non-empty satelliteSantasLines/satelliteGingerbreadLines as satellite
    // evidence — but a street-only analyze-photo result can carry model-
    // HALLUCINATED satellite lines with no satellite image ever shown to it
    // (see analysisSatellitePayload.ts). That let a street re-analyze null out
    // a live satelliteFeetPerPixel and clobber good seeded lines with
    // fabricated ones, silently zeroing every satellite measurement downstream
    // (the footage-derive effect early-returns on a null scale). The gate now
    // requires an ACTUAL satellite payload (the image or its known scale —
    // both only ever come from analyze-address), never mere line content.
    if (hasSatellitePayload(data)) {
      setSatelliteSantasLines(r.satelliteSantasLines ?? []);
      setSatelliteGingerbreadLines(r.satelliteGingerbreadLines ?? []);
      // Belt-and-braces: only overwrite the live scale when this payload
      // actually carries one. In practice analyze-address always pairs
      // satelliteBase64 with a computed satelliteFeetPerPixel (deterministic
      // math off the Google Static Maps zoom level — verified non-nullable in
      // googleMaps.ts's getCachedAddressImagery), so this can't currently
      // fire with fpp missing. Guarding it anyway means a future satellite-
      // carrying caller that omits the scale can never null-clobber a live one.
      if (data.satelliteFeetPerPixel != null) {
        setSatelliteFeetPerPixel(data.satelliteFeetPerPixel);
      }
    }
    // The bridge auto-design (#35 Phase 2): roofline lines → tagged C9 strands
    // (#33) AND per-unit detections → scene items at the detected spots. The
    // route sanitizes (unknown sizes/tiers/boxes are dropped, not fatal). If
    // the design already carries this exact photo (a re-analyze), seed it
    // directly; otherwise park the payload for the eager design effect.
    const seed: AnalysisSeed = {
      lines: {
        santas: (r.santasLines ?? []).map((l) => l.points),
        gingerbread: (r.gingerbreadLines ?? []).map((l) => l.points),
        winterWonderland: [],
        stakeLighting: [],
        // #82 2c: carry the AI's per-segment roof-feature, index-aligned with the
        // line arrays above → seeded strands get a roofFeature (staff verify/correct).
        features: {
          santas: (r.santasLines ?? []).map((l) => l.feature ?? null),
          gingerbread: (r.gingerbreadLines ?? []).map((l) => l.feature ?? null),
        },
      },
      detections: {
        miniLights: (r.miniLightDetections ?? []).map((d) => ({
          type: d.type, wrapStyle: d.wrapStyle, stringCount: d.stringCount, box: d.box,
        })),
        wreaths: (r.wreathDetections ?? []).map((d) => ({ size: d.size, tier: d.tier, box: d.box })),
        spritzers: (r.spritzerDetections ?? []).map((d) => ({ size: d.size, box: d.box })),
        garland: (r.garlandDetections ?? []).map((d) => ({ length: d.length, tier: d.tier, box: d.box })),
      } as AnalysisSeed['detections'],
      // Footage estimates + the drawn lines = pixels-per-foot → the seeded
      // 5 ft scale yardstick (items render at sane sizes from the start).
      calibration: { santasFootage: r.santasFootage, gingerbreadFootage: r.gingerbreadFootage },
    };
    // Provenance for training capture (#8 Stage A): the RAW analysis + the
    // satellite image/scale, persisted onto the design (parked until it exists).
    const ctx: DesignAnalysisContext = {
      analysis: r as unknown as Record<string, unknown>,
      ...(data.satelliteBase64
        ? {
            satelliteBase64: data.satelliteBase64,
            satelliteMediaType: data.satelliteMediaType ?? 'image/jpeg',
            satelliteFeetPerPixel: data.satelliteFeetPerPixel ?? null,
          }
        : {}),
    };
    if (designId && data.photoBase64 && designPhotoRef.current === data.photoBase64) {
      void seedDesignFromAnalysis(designId, seed);
      void pushAnalysisContext(designId, ctx);
    } else {
      pendingSeedRef.current = seed;
      // MERGE, don't overwrite (H1): a manual satellite parked by
      // handleSatelliteSelect before Analyze must survive. analyze-photo
      // carries no satellite of its own, so ctx has only the analysis half;
      // spreading it last lets a Google satellite (analyze-address) still win.
      pendingContextRef.current = { ...(pendingContextRef.current ?? {}), ...ctx };
    }
    // Claude may flag satellite as the better measurement source (e.g. rear
    // rooflines invisible from the street) — surface that tab if so.
    setViewMode(r.preferredSource === 'satellite' ? 'satellite' : 'design');
    // SHADOW MODE (deterministic-satellite-footage): flag text, per roofline,
    // when the model's stated satellite footage disagrees >25% with what its
    // own drawn lines measure — never changes any form/pricing field. Routed
    // through satelliteFootageDisagreement (the amber double-check banner
    // below), not analysisNotes, and cleared per-roofline in getSetter when
    // the operator redraws that roofline's lines.
    setSatelliteFootageDisagreement({
      santas:
        r.satelliteSantasFootageDisagrees && r.computedSatelliteSantasFootage != null
          ? formatSatelliteDisagreement("Santa's", r.satelliteSantasFootage ?? '?', r.computedSatelliteSantasFootage)
          : null,
      gingerbread:
        r.satelliteGingerbreadFootageDisagrees && r.computedSatelliteGingerbreadFootage != null
          ? formatSatelliteDisagreement('Gingerbread', r.satelliteGingerbreadFootage ?? '?', r.computedSatelliteGingerbreadFootage)
          : null,
    });
    // Row 209: tell the operator when a field's footage was deliberately
    // NOT taken from this analysis, so a number that looks unchanged after
    // "Re-analyze" reads as intentional rather than as a stale UI.
    // Field names match the ON-SCREEN labels (admin + staff lens LOWs: the
    // old note said "gingerbread" for the field labelled "Ridge + Sides").
    const keptFootageFields = [
      footageFromAnalysis.santasFootage === undefined ? 'front gutterline' : null,
      footageFromAnalysis.gingerbreadFootage === undefined ? 'ridge + sides' : null,
    ].filter((label): label is string => label != null);
    const keptFootageNote =
      keptFootageFields.length > 0
        ? ` Footage for ${keptFootageFields.join(' + ')} kept from the drawn satellite lines — this analysis's street estimate was not applied. (Want the street estimate instead? Delete those satellite lines and re-analyze, or type the number directly.)`
        : '';
    setAnalysisNotes(`${r.notes} (confidence: ${r.confidence})${keptFootageNote}`);
    const photoNeedsSave = !!(
      data.photoBase64 &&
      data.photoMediaType &&
      designPhotoRef.current !== data.photoBase64
    );
    designPhotoChangeInProgressRef.current = photoNeedsSave;
    if (photoNeedsSave) setDesignPhotoRevision((revision) => revision + 1);
    setPhotoBase64(data.photoBase64 ?? null);
    setPhotoMediaType(data.photoMediaType ?? null);
    setFewShotCount(data.fewShotCount ?? 0);
    setFewShotRanking(data.fewShotBreakdown?.ranking ?? 'recency');
    setFewShotDegraded(data.fewShotBreakdown?.degraded ?? false);
  };

  // #204: shared by "Pull satellite" (handlePullSatellite) and the
  // analyze-address no-Street-View fallback below (both branches) — both
  // receive the exact same satellite-only response shape (satelliteBase64 /
  // satelliteMediaType / satelliteFeetPerPixel / formattedAddress), so both
  // apply it through this ONE function instead of two hand-copied blocks that
  // could drift out of parity. `pulledForAddress` is the EXACT address string
  // used for the fetch (captured before the await, not re-read from form
  // state afterward) — stamped onto a parked context for handlePhotoSelect's
  // same-house check (#204 review round, gap 2). Returns false (no state
  // touched at all) when the operator cancels the replace-confirm below.
  const applyPulledSatellite = (
    data: {
      satelliteBase64?: string;
      satelliteMediaType?: string;
      satelliteFeetPerPixel?: number | null;
      formattedAddress?: string;
    },
    pulledForAddress: string,
  ): boolean => {
    // #204 review round (gap 1, HIGH money): a RE-pull with lines already
    // drawn would otherwise apply the NEW scale against the OLD (possibly
    // different-house) geometry — the footage-derive effects would compute
    // wrong billed footage from stale lines × a new feet-per-pixel, silently.
    // Mirrors handleSatelliteSelect's exact pattern (~line 1519): confirm
    // before replacing when anything's drawn, clear EVERY satellite line
    // array on apply; silent when nothing's drawn yet (the common case — the
    // first pull on a fresh quote).
    const hasAnyLines = satelliteLinesHaveContent({
      santas: satelliteSantasLines,
      gingerbread: satelliteGingerbreadLines,
      c9: satelliteC9Lines,
      stake: satelliteStakeLines,
      bistro: satelliteBistroLines,
      permanent: permanentSatLines,
    });
    if (hasAnyLines) {
      const ok = window.confirm(
        'Replaces the satellite image — traced roofline + footage will reset. Continue?',
      );
      if (!ok) return false;
      setSatelliteSantasLines([]);
      setSatelliteGingerbreadLines([]);
      // SHADOW MODE: the old lines this note described are gone.
      setSatelliteFootageDisagreement({ santas: null, gingerbread: null });
      setSatelliteC9Lines([]);
      setSatelliteStakeLines([]);
      setSatelliteBistroLines([]);
      hadBistroLinesRef.current = false;
      holidayDeriveFrozenRef.current = false;
      permDeriveFrozenRef.current = false;
      setPermanentSatLines({ front: [], left: [], right: [], back: [] });
    }
    setGoogleAddress(data.formattedAddress ?? null);
    setSatellitePreview(`data:${data.satelliteMediaType};base64,${data.satelliteBase64}`);
    setSatelliteFeetPerPixel(data.satelliteFeetPerPixel ?? null);
    // No street photo in this response — the Design tab has nothing to show
    // yet, so surface the tab that DOES: the satellite the operator can draw on.
    setViewMode('satellite');
    setFewShotCount(0);
    // #443-style: persist the satellite IMAGE onto the design so the portal's
    // "Where the lights go" view has it, mirroring the imagery-only branch
    // below and applyAnalysisResult's ctx push.
    if (data.satelliteBase64) {
      const satCtx = {
        satelliteBase64: data.satelliteBase64,
        satelliteMediaType: data.satelliteMediaType ?? 'image/png',
        satelliteFeetPerPixel: data.satelliteFeetPerPixel ?? null,
      };
      // #204 review round (gap 3, MED): a design may already exist (a
      // reopened quote, or the operator already uploaded/analyzed a photo
      // earlier this session) — parking would sit unconsumed forever, since
      // the eager design effect only flushes pendingContextRef on a
      // photoBase64 CHANGE, which a satellite-only re-pull never causes.
      // Mirrors handleSatelliteSelect's designIdRef.current branch: push
      // directly when a design exists, park (+ stamp the address) otherwise.
      const id = designIdRef.current;
      if (id) {
        void pushAnalysisContext(id, satCtx);
      } else {
        const parked = parkSatelliteContext(pendingContextRef.current, satCtx, pulledForAddress);
        pendingContextRef.current = parked.context;
        pendingSatelliteAddressRef.current = parked.address;
      }
    }
    return true;
  };

  // #204: geocode the typed address and load JUST the satellite image + its
  // real scale — no AI, instant. Built for houses Street View can't serve
  // (analyze-address's full lookup 404s the WHOLE request on those); the
  // operator draws channels by hand and footage derives from the drawn
  // geometry as usual (same as any other satellite trace). Does NOT touch the
  // street photo slot — upload one separately, then Analyze; the #190 guard
  // (hasSatellitePayload) keeps this pulled scale intact through that later
  // analyze (see analysisSatellitePayload.ts / the #204 ordering test).
  const handlePullSatellite = async () => {
    if (quoteSaveInProgressRef.current || satelliteChangeInProgressRef.current) {
      setAnalysisError('Wait for the current satellite or quote save to finish, then try again.');
      return;
    }
    const addr = form.customer.address.trim();
    if (!addr) {
      setAnalysisError('Enter the property address above first.');
      return;
    }
    satelliteChangeInProgressRef.current = true;
    setLookingUp(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    setAnalysisNotes(null);
    try {
      const res = await fetch('/api/pull-satellite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Satellite pull failed');
      // Cancel = no-op (the operator declined the replace-confirm inside
      // applyPulledSatellite because lines were already drawn) — no message.
      if (!applyPulledSatellite(data, addr)) return;
      setAnalysisNotes(
        data.streetViewAvailable
          ? 'Satellite loaded. Draw the roofline/channels on the Satellite tab — footage follows the lines. Street View is also available for this address if you want the full "Analyze from Address" auto-measure instead.'
          : 'Satellite loaded — no Street View available at this address. Upload a front photo below, then Analyze; the pulled satellite + scale stay intact.',
      );
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Satellite pull failed');
    } finally {
      satelliteChangeInProgressRef.current = false;
      setLookingUp(false);
    }
  };

  const handleLookupAddress = async () => {
    if (quoteSaveInProgressRef.current || satelliteChangeInProgressRef.current) {
      setAnalysisError('Wait for the current satellite or quote save to finish, then try again.');
      return;
    }
    const addr = form.customer.address.trim();
    if (!addr) {
      setAnalysisError('Enter the property address above first.');
      return;
    }
    // Row 405: ask BEFORE analyzing, not after.
    //
    // A re-analyze replaces the traced sides, discarding any hand-typed
    // footage/corners override. The loss is intended — a fresh AI re-trace is
    // exactly the "geometry changed, the redraw wins" case the reconcile is
    // built around — but it happened with NO warning, while all three sibling
    // replacement paths (handleSatelliteSelect, applyPulledSatellite, and the
    // permanent_bistro branch) confirm first. Footage drives price.
    //
    // PRE-FLIGHT for a specific reason, found by a premerge customer lens on
    // the first version of this fix, which asked AFTER the analysis landed:
    // a decline there had to keep the old traced lines while the NEW address's
    // satellite image had ALREADY been applied and parked in pendingContextRef,
    // so the customer portal would render one house's photo underneath another
    // house's light lines. Declining here changes nothing whatsoever — no
    // request, no image, no scale, no state — and it also does not spend
    // 20-40s of analyzer time producing a result the operator has said they do
    // not want.
    //
    // `permanentSideOverriddenFields` asks the same question the reconcile
    // uses (a derived baseline the billed value has since drifted from), so
    // the dialog can never name different fields than a re-analyze would
    // actually overwrite. Non-permanent quotes never populate those baselines,
    // so this is silent for them by construction, as it is for the ordinary
    // case of a quote carrying no override at all.
    // Gated on the service type explicitly. The baselines are permanent-side
    // only, so a non-permanent quote is silent by construction anyway — but a
    // quote that was switched FROM permanent can still be carrying stale
    // permanentSatLines and form.permanent values, and there is no reason to
    // ask about fields that service type does not bill.
    const overriddenSideFields =
      form.serviceType === 'permanent'
        ? permanentSideOverriddenFields(effectivePermanentSideBaseline(), form.permanent)
        : [];
    if (overriddenSideFields.length > 0) {
      const proceed = window.confirm(
        `Re-analyzing replaces the traced sides, so these hand-entered numbers will be ` +
          `recalculated from the new trace:

` +
          `${overriddenSideFields.map(describePermanentSideField).join(', ')}

` +
          `Cancel to keep them as they are — nothing on this quote will change.`,
      );
      if (!proceed) return;
    }
    satelliteChangeInProgressRef.current = true;
    setLookingUp(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    setAnalysisNotes(null);
    try {
      const res = await fetch('/api/analyze-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, serviceType: form.serviceType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Address lookup failed');
      // #204: partial success — Street View isn't available at this address,
      // but the satellite leg doesn't need it. No AI ran server-side (nothing
      // to show it without a street photo) — populate the satellite tab and
      // tell the operator honestly, same shape as handlePullSatellite above.
      if (data.streetViewUnavailable) {
        // Cancel = no-op, same as handlePullSatellite (the operator declined
        // the replace-confirm because lines were already drawn).
        if (!applyPulledSatellite(data, addr)) return;
        setAnalysisWarning(
          'No Street View available at this address — upload a front photo below; the satellite image is loaded for measurements.',
        );
        return;
      }
      // Show street view as the editable photo
      const streetUrl = `data:${data.photoMediaType};base64,${data.photoBase64}`;
      setPhotoPreview(streetUrl);
      setPhotoFile(null);
      setSatellitePreview(`data:${data.satelliteMediaType};base64,${data.satelliteBase64}`);
      setGoogleAddress(data.formattedAddress ?? null);
      if (typeof data.lat === 'number') { setGeoLat(data.lat); setSvLat(data.lat); }
      if (typeof data.lng === 'number') { setGeoLng(data.lng); setSvLng(data.lng); }
      // Reset camera to default on fresh lookup so the rotation controls start
      // from Google's auto-chosen angle rather than a stale heading.
      setSvHeading(null);
      setSvPitch(0);
      setSvFov(80);
      // #88/#117: only holiday + event seed from the holiday analyzer result —
      // permanent designs from its own satellite analyzer (permanentImageryOnly
      // below) and permanent bistro designs manually, so a result here is
      // intentionally discarded for both rather than seeded onto their designs.
      if (data.result && (form.serviceType === 'holiday' || form.serviceType === 'event')) {
        applyAnalysisResult(data);
      } else {
        // Imagery loaded WITHOUT a holiday seed: permanent/bistro (which skip the
        // holiday analyzer/seed by design) or the fail-safe (analyzer down). The street
        // photo creates the design; the satellite + its scale stay for measuring.
        const photoNeedsSave = !!(
          data.photoBase64 &&
          data.photoMediaType &&
          designPhotoRef.current !== data.photoBase64
        );
        designPhotoChangeInProgressRef.current = photoNeedsSave;
        if (photoNeedsSave) setDesignPhotoRevision((revision) => revision + 1);
        setPhotoBase64(data.photoBase64 ?? null);
        setPhotoMediaType(data.photoMediaType ?? null);
        setSatelliteFeetPerPixel(data.satelliteFeetPerPixel ?? null);
        setFewShotCount(0);
        setViewMode('design');
        // #117 LOW: a fresh lookup is a NEW satellite image + scale. Discard any
        // bistro runs drawn on the PREVIOUS image so they don't silently rescale
        // into new billing footage — the operator redraws on the new image. Thaw
        // the rehydrate freeze (fresh live session) and flag hadBistroLines so the
        // derive resets the billed array to empty; then a redraw bills correctly.
        // #244 premerge finding 2 (staff, MED): unlike applyPulledSatellite's
        // "Pull satellite" sibling above (which window.confirms before
        // clearing ANY drawn satellite line, including bistro), this path
        // discarded bistro runs/overrides unconditionally. #244 raises the
        // stakes — this can now silently drop a staff-TYPED footage override,
        // not just re-derivable geometry. Mirror the sibling's confirm; a
        // decline KEEPS the existing runs/overrides (the new image/scale
        // above still apply — same tradeoff the #117 comment already accepts
        // for geometry alone). Silent when nothing would be lost.
        if (form.serviceType === 'permanent_bistro') {
          const hasBistroToLose =
            satelliteBistroLines.length > 0 || form.permanentBistro.bistro.length > 0;
          const keepExisting =
            hasBistroToLose &&
            !window.confirm(
              'Replaces the satellite image — traced bistro runs + footage will reset. Continue?',
            );
          if (!keepExisting) {
            // Row 345 finding 2: thaw via the shared helper (seeds the
            // permanent-SIDE baseline too) rather than clearing the ref
            // directly — see thawPermDerive's own comment.
            //
            // Row 379: pass the scale EXPLICITLY. setSatelliteFeetPerPixel
            // (the new scale, above) already fired this render — the
            // closure's satelliteFeetPerPixel is still the OLD value until
            // React flushes, so seeding off the default would stamp the
            // permanent-side baseline with a scale that's already stale,
            // reachable straight through this exact switch-to-bistro path.
            thawPermDerive(data.satelliteFeetPerPixel ?? null);
            hadBistroLinesRef.current = satelliteBistroLines.length > 0;
            setSatelliteBistroLines([]);
          } else {
            // #244 delta-verify HIGH (money-silent): unlike applyPulledSatellite,
            // this function already called setSatelliteFeetPerPixel(the NEW
            // scale) above, BEFORE this confirm ever ran — so a decline can't be
            // a true no-op the way the sibling's is. Without freezing here, the
            // kept satelliteBistroLines/overrides re-derive on the next effect
            // pass against the NEW scale; since the freshly-derived footage now
            // differs from prevBistroDerivedRef's baseline, reconcileBistroFootage's
            // "this run's geometry changed -> redraw wins" branch fires and
            // silently stamps the new-scale value over a hand-typed override
            // (e.g. 35ft -> ~22ft), reversing the explicit Cancel. Freeze the
            // derive (#142 idiom) so the kept billed array stays exactly as the
            // operator left it; a later real line edit thaws it as usual via
            // getSetter('bistro').
            permDeriveFrozenRef.current = true;
          }
        }
        // #443 fix (S23): persist the satellite IMAGE onto the design so the portal
        // can show the "Where the lights go" view. Holiday does this in
        // applyAnalysisResult; permanent has no analysis result, so without parking
        // the context here satellite_path stays null and the portal hides the
        // satellite even after the operator draws the side rooflines. The eager
        // design effect pushes this once the design exists.
        if (data.satelliteBase64) {
          pendingContextRef.current = {
            ...(pendingContextRef.current ?? {}),
            satelliteBase64: data.satelliteBase64,
            satelliteMediaType: data.satelliteMediaType ?? 'image/jpeg',
            satelliteFeetPerPixel: data.satelliteFeetPerPixel ?? null,
          };
        }
        if (data.permanentImageryOnly) {
          // WT-35: also park the RAW permanent satellite analyzer result as the
          // design's analysis provenance — mirrors applyAnalysisResult's
          // `ctx.analysis: r` for holiday/event above. Without this, seed_analysis
          // stays null forever for permanent designs and the jump ground-truth
          // few-shot signal (permanent/fewShot.ts asJumps, fed by
          // original_analysis.jumps) never has anything to read.
          // REOPEN-CLOBBER GUARD: this whole block only runs as the direct
          // response handler of THIS fetch (never an automatic derive/rehydrate
          // effect that could fire on mount), so there is no stale-ref path to
          // guard against — the only risk is a failed analyzer call on a
          // re-lookup pushing an empty/null analysis over a good saved one.
          // `data.permanentSatellite` is null exactly when the try/catch above
          // caught an analyzer failure, so gating on its truthiness ensures we
          // only ever push a REAL analysis that just ran this session.
          if (data.permanentSatellite) {
            pendingContextRef.current = {
              ...(pendingContextRef.current ?? {}),
              analysis: data.permanentSatellite,
            };
          }
          // #140 P2: the permanent satellite analyzer seeds the SAME editable
          // side channels the operator draws by hand — footage/corners and the
          // Extensions/Splitters counts then derive from the seeded lines via
          // the existing effects. Nothing is billed that isn't visible as a line.
          const seeded = data.permanentSatellite?.satelliteLines;
          const seededSides = seeded
            ? (PERMANENT_SIDES as readonly PermanentSideKey[]).filter(
                (s) => Array.isArray(seeded[s]) && seeded[s].length > 0,
              )
            : [];
          if (seeded && seededSides.length > 0) {
            // #142: a fresh analyze is a NEW live session — thaw any rehydrate
            // freeze so the seeded lines drive footage/counts immediately.
            //
            // Row 345 finding 2: deliberately a PLAIN thaw, not
            // thawPermDerive() — seeding the baseline first would be WRONG
            // here, not just unnecessary. The thaw sites that DO seed
            // preserve the current lines (a manual edit touches one side,
            // Recount re-derives from what's already drawn); this one
            // REPLACES all four sides wholesale with a fresh AI re-trace two
            // lines below — exactly the "geometry changed" case the
            // reconcile is supposed to let win outright, even over a
            // standing override. Seeding from the pre-replace (old/frozen)
            // lines would only matter in the rare coincidence where the AI
            // re-derives a side to the exact same footage/corners as
            // before — and in that one case seeding would make a stale
            // hand-typed override survive a fresh re-analysis the operator
            // explicitly asked for, which is the opposite of "drive
            // footage/counts immediately" above.
            //
            // Row 399 (was a live money bug, not a documentation exercise):
            // this comment used to ASSERT that leaving the baseline
            // un-seeded was enough to make every side "start this run with
            // no recorded baseline" — false. Nothing here reset
            // prevPermSideDerivedRef/prevPermSideScaleRef, so a SECOND
            // analyze in the same session (e.g. the operator corrects a
            // typo'd address and re-runs) inherited the FIRST analyze's
            // baseline + scale. Since almost any two different addresses
            // geocode to two different latitudes, satelliteFeetPerPixel
            // (set above) differs -> scaleChanged computes true against
            // that stale baseline -> reconcilePermanentSideField's
            // `scaleChanged && baseline != null` branch fires FIRST and
            // treats the second address's real (different-house) footage
            // as a pure scale artifact, silently keeping the FIRST
            // address's wrong number forever (see
            // reconcileSideFootage.test.ts's "second address" regression).
            // Actually resetting both refs here is what makes "every side
            // starts this run with no recorded baseline" true, so
            // scaleChanged short-circuits to false (prevPermSideScaleRef
            // reads back as `undefined`) and the reconcile's brand-new
            // branch takes the AI's fresh values unconditionally, exactly
            // as this comment always claimed.
            //
            // Known tradeoff, left alone on purpose (row 399 delta-verify):
            // a reopened quote that got a manual line edit first (so a real
            // override is on record), then a re-analyze for a DIFFERENT
            // address, DOES lose that standing override here — same as it
            // always has, even same-scale, before this fix existed. Unlike
            // the two satellite-replacement paths above (handleSatelliteSelect,
            // applyPulledSatellite), which window.confirm before discarding
            // anything drawn/overridden, this path has NO confirm dialog —
            // the operator gets no warning before a re-analyze silently wipes
            // a hand-typed number. Not introduced by row 399 (the same-scale
            // case already clobbered silently), so left unchanged; just
            // flagging it here so the next reader treats the silence as a
            // known gap, not an oversight.
            permDeriveFrozenRef.current = false;
            prevPermSideDerivedRef.current = {};
            prevPermSideScaleRef.current = undefined;
            setPermanentSatLines({
              front: seeded.front ?? [],
              left: seeded.left ?? [],
              right: seeded.right ?? [],
              back: seeded.back ?? [],
            });
            // #140 P3: street runs → editable bulbType:'permanent' strands on
            // the design (visual + portal; billing stays satellite-sourced).
            // Same dispatch-or-park flow the holiday seed uses.
            const streetRuns = (data.permanentSatellite?.streetRuns ?? []) as Array<{
              side: 'front' | 'left' | 'right';
              points: [number, number][];
            }>;
            if (streetRuns.length > 0) {
              const permSeed: AnalysisSeed = {
                permanentRuns: streetRuns.map((r) => ({ side: r.side, points: r.points })),
              };
              if (designId) {
                void seedDesignFromAnalysis(designId, permSeed); // bumps designEditorKey itself
              } else {
                pendingSeedRef.current = permSeed;
              }
            }
            // #140 P3: AI-detected jumps + splitter branch points feed the
            // Extensions/Splitters derive as `extras` (what geometry can't see).
            const jumps = (data.permanentSatellite?.jumps ?? []) as Array<{
              ft: number;
              splitter: boolean;
            }>;
            setPermanentAiExtras({
              splitters: jumps.filter((j) => j.splitter).length,
              jumpsFt: jumps.map((j) => j.ft).filter((f) => Number.isFinite(f) && f > 0),
            });
            const conf = data.permanentSatellite?.confidence;
            const aiNotes = data.permanentSatellite?.notes;
            setAnalysisNotes(
              `Satellite auto-trace drew ${seededSides.join(', ')} (${conf ?? 'low'} confidence)` +
                (streetRuns.length ? `, plus ${streetRuns.length} street run(s) on the design` : '') +
                (jumps.length ? `, ${jumps.length} jump(s)${jumps.some((j) => j.splitter) ? ' incl. splitter branch(es)' : ''}` : '') +
                '. Check each line — footage, corners, and extensions all follow the lines.' +
                (aiNotes ? ` AI notes: ${aiNotes}` : ''),
            );
          } else {
            setAnalysisNotes(
              data.permanentAnalysisError ??
                'Photos loaded. Draw each side of the roofline on the Satellite tab (front/left/right/back) — footage, corners, and extensions fill in from the drawing.',
            );
          }
        } else if (form.serviceType === 'permanent_bistro') {
          // #117: bistro is imagery-only (the analyze-address route returns
          // photos with no analyzer result for permanent_bistro) — bistro
          // designs manually, so surface that instead of a false "the
          // analyzer is unavailable" warning.
          setAnalysisNotes(
            'Photos loaded. Draw the bistro light runs on the Satellite tab (billing) and set the pole count below — there is no auto-trace for bistro.',
          );
        } else {
          setAnalysisWarning(
            data.analysisError ??
              'The auto-design analyzer is temporarily unavailable — your photos are loaded; design the house manually.',
          );
        }
      }
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Address lookup failed');
    } finally {
      satelliteChangeInProgressRef.current = false;
      setLookingUp(false);
    }
  };

  const handleAnalyzePhoto = async () => {
    if (!photoFile) return;
    if (quoteSaveInProgressRef.current || designPhotoChangeInProgressRef.current) {
      setAnalysisError('Wait for the current photo or quote save to finish, then try again.');
      return;
    }
    // #88/#117: permanent + permanent bistro design MANUALLY — no holiday
    // auto-measure/seed. Load the uploaded photo into a bare design (no
    // Anthropic call, no santas/gingerbread roofline drawn) so the operator
    // draws the runs themselves. Mirrors the analyzer-outage fail-safe below.
    if (form.serviceType === 'permanent' || form.serviceType === 'permanent_bistro') {
      designPhotoChangeInProgressRef.current = true;
      // Read the base64 from the File itself — photoPreview is a blob: object URL
      // (URL.createObjectURL), NOT a data URL, so it can't be split for base64.
      // #186: downscale before base64-encoding — see clientImage.ts.
      let dataUrl: string;
      let mediaType: string;
      try {
        ({ dataUrl, mediaType } = await downscaleForUpload(photoFile));
      } catch {
        designPhotoChangeInProgressRef.current = false;
        setAnalysisError("Couldn't read that photo. Try selecting it again.");
        return;
      }
      if (quoteSaveInProgressRef.current) {
        designPhotoChangeInProgressRef.current = false;
        setAnalysisError('Quote save started before the photo was ready. Load the photo again.');
        return;
      }
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const photoNeedsSave = designPhotoRef.current !== base64;
      designPhotoChangeInProgressRef.current = photoNeedsSave;
      if (photoNeedsSave) setDesignPhotoRevision((revision) => revision + 1);
      pendingSeedRef.current = null;
      setAnalysisError(null);
      setAnalysisWarning(null);
      setPhotoBase64(base64);
      setPhotoMediaType(mediaType);
      setFewShotCount(0);
      setViewMode('design');
      setAnalysisNotes(
        form.serviceType === 'permanent_bistro'
          ? 'Photo loaded. Draw the bistro light runs on the Satellite tab (billing) and set the pole count below — there is no auto-trace for bistro.'
          : 'Photo loaded. Billing footage comes from the Satellite tab draw (front/left/right/back) — an uploaded photo has no satellite, so use "Look up on Google Maps" for the auto-trace, or type the footage manually.',
      );
      return;
    }
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    setAnalysisNotes(null);

    // #186 phase 2: downscale before appending to FormData — this multipart
    // sender was deliberately deferred in phase 1 (which only wired the
    // base64-JSON paths) and kept 413ing on Vercel's raw-body cap.
    let uploadBlob: Blob;
    try {
      ({ blob: uploadBlob } = await downscaleForUploadAsBlob(photoFile));
    } catch {
      setAnalysisError("Couldn't read that photo. Try selecting it again.");
      setAnalyzing(false);
      return;
    }

    const fd = new FormData();
    // downscaleForUploadAsBlob returns the original File untouched on the
    // skip/fallback path (keep its real name) or a re-encoded plain Blob on
    // the resize path (named to match the re-encoded image/jpeg content —
    // the route validates via the Blob's own .type, not the filename, but a
    // mismatched extension is still confusing in logs/downloads).
    fd.append('photo', uploadBlob, uploadBlob instanceof File ? uploadBlob.name : 'photo.jpg');

    try {
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(await readUploadErrorMessage(res, 'Analysis failed'));
      const data = await res.json();
      // Do NOT clear the satellite here: #97 — handlePhotoSelect no longer wipes
      // the satellite on a street swap, and applyAnalysisResult only (re)sets it
      // when the analysis carried satellite data (it doesn't for analyze-photo).
      // So whatever satellite is present (address-pulled or manual, for THIS
      // house) is preserved with its traced lines + scale.
      if (data.result) {
        applyAnalysisResult(data);
      } else {
        // FAIL-SAFE: analyzer unavailable. Load the uploaded photo into the editor
        // (it isn't loaded until now — handlePhotoSelect nulls photoBase64) so
        // staff design MANUALLY. Skip the seed.
        const nextPhotoBase64 = data.photoBase64 ?? null;
        const nextPhotoMediaType = data.photoMediaType ?? null;
        const photoNeedsSave = !!(
          nextPhotoBase64 &&
          nextPhotoMediaType &&
          designPhotoRef.current !== nextPhotoBase64
        );
        designPhotoChangeInProgressRef.current = photoNeedsSave;
        if (photoNeedsSave) setDesignPhotoRevision((revision) => revision + 1);
        setPhotoBase64(nextPhotoBase64);
        setPhotoMediaType(nextPhotoMediaType);
        setFewShotCount(0);
        setViewMode('design');
        setAnalysisWarning(
          data.analysisError ??
            'The auto-design analyzer is temporarily unavailable — your photo is loaded; design the house manually.',
        );
      }
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const set = <K extends keyof QuoteFormData>(k: K, v: QuoteFormData[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  // #215 (fix round F1): the ONE place legacyRebook changes post-mount (the
  // chip click below + contact-pick tag inheritance a few hundred lines
  // down) — mirrors applyIsNce's ref-then-state ordering exactly so
  // legacyRebookRef.current is synchronously correct the instant this
  // returns, no deposit cascade needed here (legacyRebook has no money side
  // effect, unlike isNce).
  const applyLegacyRebook = (next: boolean) => {
    legacyRebookRef.current = next;
    setLegacyRebook(next);
  };

  // NCE 40% deposit default (#199): the ONE helper every LIVE isNce flip
  // funnels through (the chip click below + contact-pick tag inheritance a
  // few hundred lines down) — mirrors resolveTagPayload's shared-mechanism
  // convention so both sites can never drift. The rule itself is pure
  // (resolveNceDepositPercent, quoteForm.ts) and reads/writes depositPercent
  // via the SAME functional setForm update `set` uses, so it can't race a
  // same-tick edit. Locked (savedStatus approved/booked) quotes are a no-op —
  // the #177 freeze owns the deposit percent past approval; the tag itself
  // still flips (money is unaffected, matching the admin toggle route).
  //
  // #199 (wrap-review F4): a no-op flip (`next` equals the CURRENT isNce —
  // e.g. contact-pick inheritance re-confirming an already-false chip on a
  // re-pick) must never touch the deposit field at all, even in passing —
  // this is what made the OFF-side revert bug (below) invisible: the chip
  // never visibly changed, yet a hand-typed 40 vanished. Compared against
  // isNceRef (wrap-review LOW), not the render-closure isNce — always
  // synchronously current, kept in lockstep by this same function (the ONLY
  // place isNce ever changes).
  //
  // Hoisted to a named const (#215) so the chip's confirm copy
  // (nceConfirmMessage) can ask the identical "is this locked" question
  // before it prompts, instead of a second inline expression that could drift.
  const nceDepositLocked = savedStatus === 'approved' || savedStatus === 'booked';
  // Row 328(a): `moveDeposit: false` syncs the chip WITHOUT touching the
  // deposit — used only by the async contact-pick inheritance on a quote that
  // has left draft. See nceTagDepositWasSuppressed for why the money is held
  // back there and nowhere else.
  const applyIsNce = (next: boolean, opts?: { moveDeposit?: boolean }) => {
    const moveDeposit = opts?.moveDeposit !== false;
    const wasNce = isNceRef.current;
    isNceRef.current = next;
    setIsNce(next);
    if (next === wasNce) return;
    if (!moveDeposit) return; // chip only — deposit and its provenance untouched
    // Any path that DOES move the deposit is a deliberate act on it, so a
    // standing "we held your deposit back" notice from an earlier contact
    // pick is now answered and must go.
    setNceDepositHeldBack(null);
    // Read provenance NOW, not inside the updater: React runs the functional
    // updater at flush time, AFTER this handler finishes — by which point the
    // synchronous clear on the last line below has already set the ref to
    // `next`. On a turn-OFF that meant resolveNceDepositPercent always saw
    // wasRuleSet=false and the 40→blank revert was structurally dead on every
    // OFF path (chip click, contact-pick, #243 type-switch) — deposit stayed
    // 40 on an untagged quote. Device-check-found (S44).
    const wasRuleSet = nceDepositSetByRuleRef.current;
    setForm(f => {
      const resolved = resolveNceDepositPercent(
        f.depositPercent,
        next,
        nceDepositLocked,
        wasRuleSet,
      );
      // Provenance (row 328(b)): the rule owns only what it actually WROTE.
      // Claiming on every turn-ON adopted a hand-typed 40 that happened to
      // match the rule's own number, and the next turn-OFF then wiped that
      // negotiated value. Turning OFF never claims, and a locked quote never
      // claims because resolveNceDepositPercent wrote nothing.
      //
      // Recorded HERE, inside the updater, because `f.depositPercent` is the
      // authoritative pre-write value and the render closure's is not — this
      // runs from an async contact-pick `.then` too, where staff may have
      // typed since. Writing a ref inside an updater is safe in this one
      // shape: the value is a pure function of (f, next, locked), so React's
      // double-invocation in development computes the same answer twice. What
      // it is NOT safe for is READING back in the same tick, which is exactly
      // why `wasRuleSet` above is captured before this runs.
      if (!nceDepositLocked) {
        nceDepositSetByRuleRef.current = shouldClaimNceDepositProvenance({
          nextIsNce: next,
          locked: nceDepositLocked,
          current: f.depositPercent,
          resolved,
        });
      }
      return resolved === f.depositPercent ? f : { ...f, depositPercent: resolved };
    });
  };

  // ─── Referral program redemption (#41 PR 2) ─────────────────────────────
  // Credit banner: the button is disabled whenever some OTHER discount (a
  // manual %/flat entry, or an early-install promo) already occupies the
  // quote's one discount slot — applying credit never silently merges with
  // it. `form.referralCredit` marks "occupied by US", so that case alone
  // stays enabled/shows the applied state instead.
  const referralDiscountSlotOccupied =
    (form.discountEnabled || form.installTiming !== 'none') && !form.referralCredit;

  // Referral program redemption (#41 adversarial-review HIGH fix): Apply
  // already CONSUMED the credit server-side (the banner's own POST to
  // /api/referrals/consume flipped the referral rows to 'credited' before
  // this ever runs) — so the discount must land on THIS quote in the SAME
  // user action, or a Send-without-Calculate would hand the customer a
  // portal link with no discount for a credit that's already spent. Persists
  // immediately via the exact save path Calculate uses (runQuote), passing
  // the just-updated form so buildQuoteInputs picks up discount+referralCredit
  // without waiting on the async setForm. If that persist fails, the form
  // KEEPS referralCredit set (re-saving is idempotent — the rows are already
  // credited) and a loud, blocking message shows on the banner; Send stays
  // blocked (referralCreditUnsaved) until a Calculate actually saves it.
  const applyReferralCredit = async (result: { appliedUsd: number; consumedRowIds: string[]; balanceUsd: number }) => {
    const nextForm: QuoteFormData = {
      ...form,
      discountEnabled: true,
      discountType: 'flat',
      discountAmount: result.appliedUsd,
      // Referral credit always wins the one discount slot outright — clears
      // any early-install promo pick so buildQuoteInputs actually emits the
      // discount (the two are mutually exclusive; see quoteForm.ts).
      installTiming: 'none',
      referralCredit: { amount: result.appliedUsd, consumedRowIds: result.consumedRowIds },
    };
    setForm(nextForm);
    setReferralCreditUsd(result.balanceUsd);
    setReferralPersistError(null);
    setReferralCreditUnsaved(true);
    const persisted = await runQuote(undefined, nextForm);
    if (persisted) {
      setReferralCreditUnsaved(false);
    } else {
      setReferralPersistError("Credit applied but the quote didn't save. Click Calculate to finish.");
    }
  };

  // "Remove referral credit" (#41 adversarial-review MED fix): the banner
  // already RELEASED the credit server-side (POST /api/referrals/unconsume
  // flipped the rows back to 'booked') before this runs — clear the form's
  // discount + referralCredit and persist that removal the same way Apply
  // persists its own change, for the same reason: leaving THIS quote's saved
  // discount stale would let the same credit be double-spent (once here,
  // once wherever it gets applied next) even though it reads "removed" here.
  const handleReferralCreditRemoved = async (result: { releasedUsd: number }) => {
    const nextForm: QuoteFormData = {
      ...form,
      discountEnabled: false,
      discountType: 'percentage',
      discountAmount: 0,
      referralCredit: null,
    };
    setForm(nextForm);
    setReferralCreditUsd((prev) => prev + result.releasedUsd);
    setReferralPersistError(null);
    setReferralCreditUnsaved(true);
    const persisted = await runQuote(undefined, nextForm);
    if (persisted) {
      setReferralCreditUnsaved(false);
    } else {
      setReferralPersistError("Removed, but the quote didn't save. Click Calculate to finish.");
    }
  };

  // Spritzer banner (referee side): shown when THIS session picked a
  // referrer (referredBy) OR a saved/reopened quote already has a referral
  // row with this quote as the referee (initialQuote.isReferee, resolved
  // server-side since the client-side referredBy state never hydrates from a
  // saved quote — the relationship lives in the referrals table, not inputs).
  const isReferralReferee = !!referredBy || !!initialQuote?.isReferee;
  const REFERRAL_SPRITZER_LINE_ID = 'referral-spritzers';
  const spritzerLineAlreadyAdded = form.customLineItems.some((item) => item.id === REFERRAL_SPRITZER_LINE_ID);
  const addReferralSpritzers = () => {
    if (spritzerLineAlreadyAdded) return;
    set('customLineItems', [
      ...form.customLineItems,
      { id: REFERRAL_SPRITZER_LINE_ID, label: '2 Free 16" Spritzers (referral)', amount: 0, quantity: 1 },
    ]);
  };

  // #102: difficulty dropdown change. Choosing "Custom…" pre-seeds the $/ft field
  // from the current preset's rate (so staff tweak a real number, not 0) unless a
  // custom rate is already entered; preset choices just set the difficulty.
  const setDifficulty = (
    diffKey: 'santasDifficulty' | 'gingerbreadDifficulty' | 'winterWonderlandDifficulty' | 'stakeLightingDifficulty',
    rateKey: 'santasCustomRate' | 'gingerbreadCustomRate' | 'winterWonderlandCustomRate' | 'stakeLightingCustomRate',
    table: Record<'easy' | 'medium' | 'hard', number>,
    next: DifficultyChoice,
  ) =>
    setForm(f => {
      if (next !== 'custom') return { ...f, [diffKey]: next };
      const prev = f[diffKey];
      const seed = f[rateKey] > 0 ? f[rateKey] : prev === 'custom' ? table.medium : table[prev];
      // #104: choosing a custom $/ft clears any per-quote TOTAL override on that
      // same line — the two are mutually exclusive (takes effect on next Calculate).
      const overrides = { ...f.lineItemPriceOverrides };
      delete overrides[RATE_KEY_TO_OVERRIDE_ID[rateKey]];
      return { ...f, [diffKey]: 'custom', [rateKey]: seed, lineItemPriceOverrides: overrides };
    });

  const setCustomer = (k: keyof FormCustomer, v: string) =>
    setForm(f => ({ ...f, customer: { ...f.customer, [k]: v } }));

  // (#35: per-unit items — minis/spritzers/wreaths/garland/bows — are authored
  // ONLY on the design now; the manual form sections are gone. The engine still
  // accepts the arrays; the design projection populates them at Calculate.)

  // Custom / manual line items (#27 escape hatch) — staff-typed name + price for
  // off-design items. Not tied to the design; flow to the quote + portal.
  const addCustomLineItem = () =>
    set('customLineItems', [...form.customLineItems, { label: '', amount: 0, quantity: 1 }]);
  const removeCustomLineItem = (i: number) =>
    set('customLineItems', form.customLineItems.filter((_, idx) => idx !== i));
  const updateCustomLineItem = (i: number, patch: Partial<CustomLineItem>) =>
    set('customLineItems', form.customLineItems.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  // click-to-edit a line's TOTAL. Commit sets the override (clearing any #102 $/ft
  // on that line) and re-prices in place with the new form snapshot (bypassing
  // async state); reset removes the key.
  const commitLinePrice = (id: string, amount: number) => {
    let finalForm: QuoteFormData = {
      ...form,
      lineItemPriceOverrides: { ...form.lineItemPriceOverrides, [id]: { amount } },
    };
    const rate = OVERRIDE_ID_TO_RATE[id];
    if (rate) finalForm = { ...finalForm, [rate.diffKey]: rate.fallback, [rate.rateKey]: 0 };
    setForm(finalForm);
    void runQuote(undefined, finalForm);
  };
  const resetLinePrice = (id: string) => {
    const overrides = { ...form.lineItemPriceOverrides };
    delete overrides[id];
    const finalForm: QuoteFormData = { ...form, lineItemPriceOverrides: overrides };
    setForm(finalForm);
    void runQuote(undefined, finalForm);
  };

  // item-numbering-rename: click-to-rename a breakdown line's label (per-quote
  // override) — mirrors commitLinePrice/resetLinePrice exactly.
  const commitLineLabel = (id: string, label: string) => {
    const finalForm: QuoteFormData = {
      ...form,
      labelOverrides: { ...form.labelOverrides, [id]: label },
    };
    setForm(finalForm);
    void runQuote(undefined, finalForm);
  };
  const resetLineLabel = (id: string) => {
    const overrides = { ...form.labelOverrides };
    delete overrides[id];
    const finalForm: QuoteFormData = { ...form, labelOverrides: overrides };
    setForm(finalForm);
    void runQuote(undefined, finalForm);
  };

  // Pick a HighLevel contact → pre-fill the customer block below.
  // Precedence: HL data wins if the contact has a value for that field. If
  // HL has nothing (e.g., contact was created without an email), we keep
  // whatever is currently in the input — either typed by the operator or
  // left from a prior contact pick.
  //
  // Rationale: picking a contact is an explicit "use this person" action;
  // the operator expects the form to reflect the picked contact, not to
  // silently ignore HL's data because a prior value (including browser
  // autofill or a stray keystroke) was sitting in the field.
  const pickHighLevelContact = (c: CrmContact) => {
    const hlName = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ');
    // #251 (live incident, 2026-08-11): confirm BEFORE any state changes when
    // this quote is already linked to a DIFFERENT contact — see
    // contactRelinkConfirmMessage's own doc for why highlevelContact?.id is
    // preferred over the persisted dbLinked/initialQuote fallback, and why
    // both are in scope. window.confirm is synchronous, so returning here
    // happens before setHighLevelContact, before attachSeqRef is bumped, and
    // before the tag-lookup fetch below ever fires — a decline is a true
    // no-op, not just a skipped final step.
    // #839 fix-round HIGH (BYPASS 2): prefer everLinkedContactIdRef over the
    // live dbLinked/highlevelContact state — those are SESSION state and a
    // Clear click resets both, which would silently drop this comparison to
    // null on a clear-then-pick sequence. The ref remembers the last contact
    // this quote was actually linked to regardless of an intervening Clear.
    const currentContactId =
      everLinkedContactIdRef.current ??
      highlevelContact?.id ??
      (dbLinked ? (initialQuote?.highlevelContactId ?? null) : null);
    const confirmMsg = contactRelinkConfirmMessage(
      c.id,
      hlName || 'this contact',
      currentContactId,
      // Row 338 fix-round MED (staff lens): the STICKY signal, not the
      // non-sticky approvedAt alone — a revived previously-approved quote
      // must still get the frozen warning, matching what the server (which
      // checks the same sticky OR) will actually do with this pick.
      identityEverFrozen,
    );
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    if (quoteBuildTimingEligible) {
      void quoteBuildTimerRef.current?.start('contact_selected', savedQuoteId);
    }
    everLinkedContactIdRef.current = c.id;
    // Row 328(a) fix round (technical MED): a standing notice describes the
    // PREVIOUS pick. Clear it here, before this pick's own lookup can set it
    // again, so it can never name a contact that is no longer chosen.
    setNceDepositHeldBack(null);
    setHighLevelContact(c);
    const hlAddress = [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(', ');
    setForm(f => ({
      ...f,
      customer: {
        name: hlName || f.customer.name,
        phone: c.phone || f.customer.phone,
        email: c.email || f.customer.email,
        address: hlAddress || f.customer.address,
      },
      // #214 (c): the pick REPLACES the form's hl link — before this, a
      // lead-prefill's ghlContactId silently survived a re-pick, so the next
      // Calculate saved/resolved identity under the STALE contact id
      // (findOrCreateCustomer's hl-agree would then adopt the WRONG
      // customer and newest-win overwrite its stored fields with this
      // person's). The save body now always carries the contact actually
      // picked.
      highlevelContactId: c.id,
    }));
    // Reset attach status — the previous attach (if any) was against a
    // different contact and doesn't apply anymore. Bump the staleness token so
    // an in-flight attach for the OLD contact can't write the chip state.
    attachSeqRef.current++;
    setAttachStatus('idle');
    setAttachError(null);
    setAttachResurrected(false);
    // #172: if the quote is already saved, attach NOW. Picking alone only
    // turned the chip green — the DB link (highlevel_contact_id) waited for
    // the next Calculate, so pick → Send 400'd "no contact linked" while the
    // UI claimed the contact was linked. Same lastAttachKey guard as the
    // save flow so the next Calculate doesn't double-attach; queueAttach
    // serializes behind any in-flight attach/detach so the LAST pick wins
    // the DB row.
    if (savedQuoteId) {
      const attachKey = `${savedQuoteId}:${c.id}`;
      if (lastAttachKey.current !== attachKey) {
        lastAttachKey.current = attachKey;
        void queueAttach(savedQuoteId, c.id, contactIdentityOf(c));
      }
    }
    // NCE + YLL Neighbor tag inheritance (#198): if the picked contact maps
    // to a customers row, sync the UNTOUCHED chip(s) to that contact's
    // ACTUAL current tag state (true OR false) — review fix (staff MED×2 +
    // tech LOW, S34 #198 review). Was merge-only-true (never cleared), which
    // left a mis-pick's auto-true tag stuck after re-picking an untagged
    // contact. A chip staff has explicitly clicked (legacyRebookTouchedRef/
    // isNceTouchedRef — see their declaration) is NEVER auto-changed here;
    // staff-touched state always wins over whatever the currently-picked
    // contact carries.
    // Staleness guard mirrors the attach flow's OWN use of this exact token
    // 20-ish lines up (attachSeqRef bumped on every pick; a response whose
    // captured seq no longer matches belongs to a SUPERSEDED pick and is
    // dropped) — same shared ref, same pattern, not a second/parallel token.
    const tagLookupSeq = attachSeqRef.current;
    fetch(`/api/customers?hlContactId=${encodeURIComponent(c.id)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { customers?: Array<{ is_nce?: boolean; is_yll_neighbor?: boolean }> }) => {
        if (tagLookupSeq !== attachSeqRef.current) return; // superseded by a later pick
        const tags = data.customers?.[0];
        // #243 (domain rule locked 2026-08-11): never sync a tag to true on a
        // quote whose service type can't carry it — this quote's OWN type
        // decides, not the picked contact's. `false` still syncs normally
        // (matches an untagged/mismatched pick exactly as before); only the
        // `true` case is gated. canCarryNceOrYllNeighborTag is the single
        // source of truth every set/inherit site shares (serviceType.ts).
        // Fix-round HIGH: reads serviceTypeRef.current, NOT the render-closure
        // `form.serviceType` — see serviceTypeRef's own declaration for why a
        // direct read here is stale the instant staff switch service type
        // between the contact click and this fetch resolving.
        const eligibleForTags = canCarryNceOrYllNeighborTag(serviceTypeRef.current);
        if (!legacyRebookTouchedRef.current) {
          applyLegacyRebook(eligibleForTags && (tags?.is_yll_neighbor ?? false));
        }
        // #199: routed through applyIsNce (not a bare setIsNce) so an
        // inherited NCE tag also seeds the 40% deposit default, same as a
        // manual chip click.
        if (!isNceTouchedRef.current) {
          const inheritedNce = eligibleForTags && (tags?.is_nce ?? false);
          // Fix round (staff HIGH): applyIsNce no-ops when the value is
          // unchanged, so the notice must ask the same question first.
          // Without this, re-picking the SAME tagged contact on a sent quote
          // whose deposit is not exactly 40 fired a notice claiming the chip
          // had changed when nothing had happened at all — and a warning that
          // cries wolf is worse than no warning.
          const chipWouldChange = inheritedNce !== isNceRef.current;
          // Row 328(a): this runs SECONDS after the click, from a lookup the
          // staffer never asked for by name. On a quote that has already left
          // draft the customer may be looking at a portal link quoting the
          // current deposit, so the chip inherits but the money does not —
          // and the banner below says so, because a deposit that silently
          // did not change is exactly as surprising as one that did.
          // The render closure's depositPercent can be one keystroke stale
          // here (this resolves seconds after the click). That only decides
          // whether the informational line below appears — the deposit itself
          // is not touched on this path at all when the quote has left draft.
          const suppressed = nceTagDepositWasSuppressed({
            chipWouldChange,
            quoteLeftDraft,
            locked: nceDepositLocked,
            current: form.depositPercent,
            resolved: resolveNceDepositPercent(
              form.depositPercent,
              inheritedNce,
              nceDepositLocked,
              nceDepositSetByRuleRef.current,
            ),
          });
          applyIsNce(inheritedNce, { moveDeposit: !quoteLeftDraft });
          if (suppressed) setNceDepositHeldBack(inheritedNce);
        }
      })
      // Network error or non-OK response: leave chips exactly as they are —
      // "couldn't check" is not the same signal as "checked, no tags".
      .catch(() => {});
  };

  const clearHighLevelContact = () => {
    // #839 fix-round HIGH (BYPASS 3, customer+technical lenses): a client
    // confirm, not a hard block, is the deliberate shape here — see
    // clearContactConfirmMessage's own doc for the reasoning. window.confirm
    // is synchronous, so returning here is a true no-op — nothing below has
    // run yet. Row 338 correction: this comment used to say the route has
    // "no server-side guard at all" — false as of this PR. route.ts's
    // detach branch DOES refuse under the same sticky freeze CAS as the
    // attach write (identityEverFrozen below matches it); the confirm here
    // is the fast first line of defense, and the response-read restore a
    // few lines down is the real backstop for whatever the confirm's
    // point-in-time gate can't see (a revive racing this click, is_test's
    // bypass shape changing mid-session, etc).
    const clearMsg = clearContactConfirmMessage(identityEverFrozen);
    if (clearMsg && !window.confirm(clearMsg)) return;
    // Row 328(a) fix round 2 (delta-verify MED): a standing "deposit held
    // back" notice describes the contact that was just unlinked. Drop it here
    // for the same reason a new pick drops it — it must never name a contact
    // this quote is no longer pointing at.
    setNceDepositHeldBack(null);
    attachSeqRef.current++;
    const clearSeq = attachSeqRef.current;
    const freshClear = () => clearSeq === attachSeqRef.current;
    // Row 338 fix-round HIGH (staff lens): captured BEFORE the optimistic
    // flip below so a server-side identityFrozen refusal (read from the
    // detach response further down) can restore the UI to what the DB
    // actually still has — the detach fetch used to be pure best-effort
    // with no read of its own result, so the UI showed "unlinked" even when
    // the server had refused and the link was still live.
    const previousContact = highlevelContact;
    const previousFormHlId = form.highlevelContactId;
    setHighLevelContact(null);
    // #214 (c): a real undo clears the FORM's hl link too — leaving a
    // prefill/reopen-seeded id here would put the dropped contact right back
    // into the next save body (the same stale-id class the pick-time
    // replacement above closes). null is meaningful on the wire: it tells
    // /api/quote "this session has NO contact" so the update-path identity
    // never falls back to the stored id being detached below.
    setForm(f => ({ ...f, highlevelContactId: null }));
    setAttachStatus('idle');
    setAttachError(null);
    setAttachResurrected(false);
    lastAttachKey.current = null;
    // #172 (staff-lens HIGH): Clear must be a REAL undo. The pick-time attach
    // may already have written the DB link (or still be in flight — chaining
    // on attachPromiseRef serializes us after it), and a link the UI no longer
    // shows would make Send message the wrong person. Best-effort detach; the
    // pre-send guard re-links whatever is actually picked at send time.
    if (savedQuoteId) {
      setDbLinked(false);
      attachPromiseRef.current = (attachPromiseRef.current ?? Promise.resolve(false)).then(async () => {
        try {
          const res = await fetch('/api/integrations/highlevel/attach', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteId: savedQuoteId, detach: true }),
          });
          const data = await res.json().catch(() => null);
          // Row 338 fix-round HIGH: the server refused (frozen quote — the
          // detach branch's CAS, or a revive/approve landing in the race
          // window between the pre-read and the write) — restore the
          // optimistic flip above so the UI agrees with the DB instead of
          // silently claiming "unlinked" while the link is still live.
          // Only when this is still the LATEST clear/pick (freshClear): a
          // newer pick already owns the visible state and must not be
          // clobbered by a slow, now-superseded response.
          if (data?.identityFrozen === true && freshClear()) {
            setHighLevelContact(previousContact);
            setForm(f => ({ ...f, highlevelContactId: previousFormHlId }));
            setDbLinked(true);
            setAttachStatus('skipped');
            setAttachError(
              'This quote is approved or booked, so its customer identity is locked — the link was not cleared. There is no in-app way to unlink an approved quote to relink it elsewhere; contact support for a manual fix rather than retrying.',
            );
          }
        } catch {
          // Best-effort — a network failure leaves the old link in place,
          // which the visible "linked from a previous session" note then
          // reflects (unchanged from before this fix).
        }
        return false;
      });
    }
  };

  // #214 review fix (3-lens HIGH): the attach route's customers
  // re-resolution needs the PICKED CONTACT's own identity fields — the
  // stored quote row's fields are whoever the quote used to describe
  // (pre-pick), and pairing them with the fresh contact id builds a
  // self-inconsistent identity that can adopt + overwrite the WRONG
  // customer's row. Every attach call site derives this from the contact it
  // is actually attaching.
  const contactIdentityOf = (c: CrmContact) => {
    const name = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ');
    const address = [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(', ');
    return {
      contactName: name || undefined,
      contactEmail: c.email || undefined,
      contactPhone: c.phone || undefined,
      contactAddress: address || undefined,
    };
  };

  // #172: all attach/detach traffic runs through this chain — one at a time,
  // in click order — so concurrent picks/sends can't interleave DB writes.
  const queueAttach = (
    quoteId: string,
    contactId: string,
    contactIdentity?: ReturnType<typeof contactIdentityOf>,
  ): Promise<boolean> => {
    const run = (attachPromiseRef.current ?? Promise.resolve(false)).then(() =>
      attachQuoteToHighLevel(quoteId, contactId, contactIdentity),
    );
    attachPromiseRef.current = run;
    return run;
  };

  // Attach this quote's existing HL opportunity. Called async after save, on
  // an autocomplete pick when the quote is already saved (#172), and as the
  // pre-send guard. Returns true only when the GHL card exists AND the local
  // quote row was linked — the route's linked:false (card fine, DB write
  // failed) still leaves the send gate closed, so it counts as failure here.
  // contactIdentity: the picked contact's own fields (contactIdentityOf) —
  // the route's #214 customers re-resolution runs ONLY off these, never the
  // stored quote fields. Its contactName (the same pick-time value as
  // hlName, captured before the form state flushes) also supplies the
  // #247 fallback-create card name below, so no separate hint is needed.
  const attachQuoteToHighLevel = async (
    quoteId: string,
    contactId: string,
    contactIdentity?: ReturnType<typeof contactIdentityOf>,
  ): Promise<boolean> => {
    // Staleness token: if a later pick/clear bumps the seq while we're in
    // flight, our result still returns to OUR caller, but we stop writing the
    // shared chip state (it belongs to the newer selection now).
    const seq = attachSeqRef.current;
    const fresh = () => seq === attachSeqRef.current;
    if (fresh()) {
      setAttachStatus('attaching');
      setAttachError(null);
    }
    try {
      // #247: card name is the customer's name, matching the send route's
      // shape (quote.customer_name?.trim() || fallback) — was hardcoded
      // "Holiday Lights — {address}" regardless of vertical.
      const customerName = (contactIdentity?.contactName || form.customer.name || '').trim();
      const res = await fetch('/api/integrations/highlevel/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId,
          contactId,
          opportunityName: customerName || undefined,
          // #107: the GHL card carries the "Full Yule" ceiling pre-approval (the
          // deposit webhook later resets it to the customer's actual selection).
          monetaryValue: result?.fullYule?.total ?? result?.total,
          ...(contactIdentity ?? {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Attach failed (${res.status})`);
      // Row 338 fix-round HIGH (staff lens): a frozen refusal (route.ts's
      // #251/#839 CAS gates) used to fall into the generic linked:false
      // branch below and claim "Card attached... try again" — false (nothing
      // attached) and a retry can never succeed once the quote is frozen.
      // Read the flag first and throw a distinct, honest error the catch
      // block routes to the non-alarming 'skipped' status (matching the
      // identityFrozenNotice banner's copy voice) instead of 'error'.
      if (data.identityFrozen === true) {
        const frozenErr = new Error(
          'This quote is approved or booked, so its customer identity is locked — this contact wasn’t linked and nothing changed. There is no in-app way to relink an approved quote to a different customer; contact support for a manual fix rather than retrying.',
        ) as Error & { identityFrozen?: boolean };
        frozenErr.identityFrozen = true;
        throw frozenErr;
      }
      if (data.linked === false) {
        throw new Error('Card attached in HighLevel but the quote link didn’t save — try again.');
      }
      setDbLinked(true);
      if (fresh()) {
        setAttachStatus('attached');
        setAttachResurrected(data.resurrected === true);
      }
      return true;
    } catch (err) {
      if (fresh()) {
        const frozen = err instanceof Error && (err as Error & { identityFrozen?: boolean }).identityFrozen === true;
        setAttachStatus(frozen ? 'skipped' : 'error');
        setAttachError(err instanceof Error ? err.message : 'Attach failed');
      }
      return false;
    }
  };

  // Build the portal URL from the saved quote id. Used both for the
  // "Send to Customer" action (which moves the HL stage) and for the
  // clipboard copy.
  const portalUrlFor = (quoteId: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/portal/${quoteId}`;
  };

  // "Send Quote to Customer" — copies the portal URL to clipboard AND
  // calls /api/quotes/:id/send which moves the HL opportunity stage to
  // "Bid Sent". The admin still manually shares the URL (email/SMS/
  // messaging app) — we don't auto-send yet. Phase 2 could add that.
  const handleSendToCustomer = async () => {
    // #172 (review HIGH): synchronous double-click guard. The pre-send attach
    // below awaits a network round trip, and React state guards race — two
    // clicks in one tick both read stale state. The ref flips before any await.
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      await doSendToCustomer();
    } finally {
      sendInFlightRef.current = false;
    }
  };

  const doSendToCustomer = async () => {
    if (!savedQuoteId) return;
    // Referral program redemption (#41 adversarial-review HIGH fix): a
    // referral-credit change (Apply or Remove) that hasn't been confirmed
    // saved yet must block Send outright — the button is also disabled for
    // this below, but the handler guards too (belt-and-suspenders for a
    // money-safety path). The message renders next to the Send button.
    if (referralCreditUnsaved) return;
    if (hasNoPricedItems) {
      setSendBlockedMsg('Add at least one priced line item and click Calculate before sending.');
      return;
    }
    setSendStatus('sending');
    setSendError(null);
    setSendBlockedMsg(null);
    setGhlSyncWarning(null);
    setDeliveryWarning(null);
    setDeliveryRetryChannel(null);
    setDeliveryFailureHedged(false);
    setAlreadySentAt(null);
    setAlreadySentChannels(null);
    setCopiedUrl(false);
    setRetryIneligible(false);

    // #172 pre-send guard: the picked contact may not be attached yet (a
    // pick-time attach can fail, or still be in flight). A real send
    // hard-requires quotes.highlevel_contact_id, so settle the link first and
    // stop if it fails — the send route would 400 no-contact anyway. If the
    // pick-time attach for THIS pair is in flight, await it instead of firing
    // a duplicate; retry once through the serialized queue on failure.
    // Test quotes skip: the send route exempts them from the contact gate.
    if (!isTest && highlevelContact?.id && attachStatus !== 'attached') {
      const attachKey = `${savedQuoteId}:${highlevelContact.id}`;
      let linked = false;
      if (lastAttachKey.current === attachKey && attachPromiseRef.current) {
        linked = await attachPromiseRef.current;
      }
      if (!linked) {
        lastAttachKey.current = attachKey;
        linked = await queueAttach(savedQuoteId, highlevelContact.id, contactIdentityOf(highlevelContact));
      }
      if (!linked) {
        setSendStatus('idle');
        setSendBlockedMsg('HighLevel link failed — see the link status above, fix it, then send again.');
        return;
      }
    }

    // #92 — re-check fulfillability against the FRESHEST design at Send time: the
    // breakdown-driven gate can be stale if the operator edited the canvas after
    // Calculate. Flush the editor's pending save, re-fetch the live scene, re-check.
    // Fails open (offered unknown / fetch error → don't block on the re-check) —
    // EXCEPT a flush rejection: #110 #80-102 (sibling of W3-006), a flush failure
    // means an in-flight edit never made it to the server, so proceeding would
    // send the customer a link priced/gated off a stale, pre-edit scene. Warn
    // and abort instead.
    if (designId && editorFlushRef.current) {
      try {
        await editorFlushRef.current();
      } catch {
        setSendStatus('idle');
        setSendError('Design may not have saved — retry before sending');
        return;
      }
    }
    if (designId && offeredIsKnown(offeredColors)) {
      try {
        const dres = await fetch(`/api/designs/${designId}`);
        const ddata = await dres.json();
        if (dres.ok) {
          const liveScene = ddata?.design?.scene ?? { yardsticks: [], items: [] };
          const bad = detectUnfulfillable(liveScene.items, offeredFromLists(offeredColors));
          if (bad.length > 0) {
            setSendBlockedMsg(
              `Can’t send — ${bad.length} item${bad.length === 1 ? '' : 's'} we can’t supply. Recolor or remove ${bad.length === 1 ? 'it' : 'them'} (see “From your design”), then Calculate again. Don’t share the link until it’s fixed.`,
            );
            setSendStatus('idle');
            return;
          }
        }
      } catch {
        // The re-check itself failed (network) — don't block the send on it.
      }
    }

    const url = portalUrlFor(savedQuoteId);
    // Copy first so if the stage-move fails the operator still has the
    // URL on their clipboard to share manually.
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
    } catch {
      // Non-fatal — some browsers block clipboard without user gesture.
      setCopiedUrl(false);
    }

    try {
      void quoteBuildTimerRef.current?.link(savedQuoteId);
      const quoteBuildTimerId = quoteBuildTimerRef.current?.currentId();
      const postSend = (confirmUnderBilled: boolean) =>
        fetch(`/api/quotes/${savedQuoteId}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(confirmUnderBilled ? { 'x-confirm-underbilled': 'yes' } : {}),
          },
          body: JSON.stringify({ quoteBuildTimerId }),
        });
      let res = await postSend(false);
      let data = await res.json();
      // Ledger row 434: the route refuses a FIRST send that would under-bill a
      // mini group (more drawn members than the billed string count) until it is
      // confirmed. Ask once, in the operator's own words, and resend with the
      // confirm header if they accept. Declining leaves the quote UNSENT so they
      // can go fix the count.
      if (res.status === 428 && data.code === 'underbilled-mini-groups') {
        const proceed = window.confirm(
          `${data.error}

Send anyway?`,
        );
        if (!proceed) {
          setSendStatus('idle');
          setSendBlockedMsg(
            'Send cancelled. Adjust the group String count fields, then Calculate and send again.',
          );
          return;
        }
        res = await postSend(true);
        data = await res.json();
      }
      const failedChannels = Array.isArray(data.failedChannels)
        ? data.failedChannels.filter((value: unknown): value is 'sms' | 'email' => value === 'sms' || value === 'email')
        : [];
      if (!res.ok) {
        if (data.code === 'delivery-failed' && failedChannels.length > 0) {
          setDeliveryRetryChannel(failedChannels.length === 2 ? 'both' : failedChannels[0]);
          // Row 269 fix round: captured HERE, at the point data.error is
          // known — see deliveryFailureHedged's own state comment for why.
          setDeliveryFailureHedged(isTimeoutHedgedFailure(data.error));
        }
        throw new Error(data.error ?? `Send failed (${res.status})`);
      }
      // #241: the route short-circuited — this click delivered NOTHING itself
      // (no CRM stage move, no re-stamped quote_sent_at, no message sent BY
      // THIS CLICK). Don't render the identical success state; surface it
      // loudly and offer a redeliver via the existing ?retryDelivery=1 path
      // instead of falling through to the normal "sent" handling below.
      //
      // Row 269: the ORIGINAL send may still have delivered one or both
      // channels — data.channelOutcomes (route.ts) is a best-effort read of
      // that history. Scope the redeliver offer to only the channel(s) that
      // did NOT confirm-deliver, instead of the old hardcoded 'both' (which
      // could re-fire a channel that already succeeded — GHL's
      // /conversations/messages has no idempotency key, so that's a REAL
      // duplicate text/email, not just a wasted click). A missing
      // channelOutcomes field (the read itself failed) classifies both
      // channels 'unknown' via classifyChannelOutcome's own null/undefined
      // branch, which naturally reproduces today's 'both' offer — no special
      // case needed here.
      if (data.alreadySent) {
        setSendStatus('already-sent');
        setAlreadySentAt(typeof data.sentAt === 'string' ? data.sentAt : null);
        // Row 269 fix round FIX 4: parseChannelOutcomeEntry validates each
        // entry instead of trusting an unchecked `as` cast — see that
        // function's own comment above for why.
        const smsEntry = parseChannelOutcomeEntry(data.channelOutcomes?.sms);
        const emailEntry = parseChannelOutcomeEntry(data.channelOutcomes?.email);
        const smsClass = classifyChannelOutcome(smsEntry);
        const emailClass = classifyChannelOutcome(emailEntry);
        // FIX 2: hadAttempt distinguishes "no delivery row logged" from "a
        // row exists but it's a timeout-hedged failure" — see
        // channelDeliveryPhrase's own comment for why classification alone
        // can't tell the two apart.
        setAlreadySentChannels({
          sms: { classification: smsClass, at: smsEntry?.at ?? null, hadAttempt: smsEntry !== null },
          email: { classification: emailClass, at: emailEntry?.at ?? null, hadAttempt: emailEntry !== null },
        });
        const notConfirmed: ('sms' | 'email')[] = [];
        if (smsClass !== 'delivered') notConfirmed.push('sms');
        if (emailClass !== 'delivered') notConfirmed.push('email');
        setDeliveryRetryChannel(
          notConfirmed.length === 0 ? null : notConfirmed.length === 2 ? 'both' : notConfirmed[0],
        );
        return;
      }
      setSendStatus('sent');
      if (failedChannels.length > 0) {
        const retryChannel = failedChannels.length === 2 ? 'both' : failedChannels[0];
        setDeliveryRetryChannel(retryChannel);
        // #264 round 2, FIX 3: data.messageError already carries the
        // backend's own honesty hedge (deliveryErrorMessage in route.ts —
        // "timeout — delivery outcome unknown (GHL may have still delivered
        // it): …" whenever the failure's true outcome is unknown — a request
        // timeout, a socket reset, a DNS failure, connection refused, or
        // anything else short of a definitive HTTP response from GHL (row
        // 269 fix round 2 widened this beyond literal timeouts — see
        // timeoutHedgedErrorMessage's comment in the send route), vs. the
        // real rejection text for a confirmed HTTP-status rejection). This
        // hardcoded sentence was silently discarding it, so a channel whose
        // outcome was actually unknown rendered a confidently wrong "failed"
        // here even though the backend explicitly did not know that. Appends
        // it rather than re-deriving a new sentence, mirroring the existing
        // pattern in src/app/admin/invoices/[id]/page.tsx's sendBalanceLink
        // (surfaces body.messageError verbatim).
        setDeliveryWarning(
          `${failedChannels.map((c: 'sms' | 'email') => c.toUpperCase()).join(' and ')} failed. The other requested channel was delivered.${data.messageError ? ` (${data.messageError})` : ''}`,
        );
        // Row 269 fix round: see deliveryFailureHedged's state comment.
        setDeliveryFailureHedged(isTimeoutHedgedFailure(data.messageError));
      }
      // PostHog v1 — staff-side confirmation the quote actually sent.
      track('quote_sent', { quote_id: savedQuoteId, service_type: form.serviceType });
      // The quote is sent locally regardless; surface a non-blocking warning if
      // the HighLevel "Bid Sent" stage move didn't go through, so the operator
      // doesn't wrongly believe the CRM card advanced.
      setGhlSyncWarning(
        data.ghlSynced === false
          ? (data.stageError ?? 'The HighLevel card may not have advanced to Bid Sent.')
          : null,
      );
      // FIX A (#237 fix round): see eventDateSyncWarning's own state comment
      // for why this is separate from ghlSyncWarning above. data.
      // eventDateSyncError is only ever present for an event quote whose
      // push was attempted and failed — undefined otherwise, which clears
      // any stale warning from a prior send.
      setEventDateSyncWarning(data.eventDateSyncError ?? null);
      // Auto-capture (#8 Stage A / #141): sending = staff vouching the design
      // is right, so the staff-final state becomes a training example
      // (replaces this quote's previous auto snapshot on a re-send).
      // Best-effort. Positive gate: permanent quotes teach the SEPARATE
      // permanent-analyzer library, holiday + event teach the holiday one, and
      // permanent bistro teaches NEITHER (#117 — no analyzer, nothing to train;
      // a bistro photo must never pollute either library).
      if (form.serviceType === 'permanent') {
        void capturePermanentExample('auto-send');
      } else if (form.serviceType === 'holiday' || form.serviceType === 'event') {
        void captureExample('auto-send');
      }
    } catch (err) {
      setSendStatus('error');
      setSendError(err instanceof Error ? err.message : 'Send failed');
    }
  };

  const handleRetryDelivery = async () => {
    if (!savedQuoteId || !deliveryRetryChannel) return;
    // #241 (review MEDIUM, mirrors #172's sendInFlightRef guard on
    // handleSendToCustomer above — see the comment at its declaration): a
    // genuine double-click on Force Redeliver has no synchronous guard
    // otherwise, and the route has no idempotency key of its own for a
    // retry — two clicks in one tick really do text/email the customer
    // twice. Shared with Send's own guard since both hit the same real
    // delivery mechanism; either one in flight blocks the other.
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSendStatus('sending');
    setSendError(null);
    try {
      const res = await fetch(`/api/quotes/${savedQuoteId}/send?retryDelivery=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: deliveryRetryChannel }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Row 269 fix round: captured HERE, at the point data.error is known
        // — see deliveryFailureHedged's own state comment for why.
        setDeliveryFailureHedged(isTimeoutHedgedFailure(data.error));
        throw new Error(data.error ?? `Delivery retry failed (${res.status})`);
      }
      // #241 defect 2 (review MEDIUM): the retry can ALSO fall through the
      // route's alreadySent short-circuit (e.g. the customer approved or
      // the job got booked between the original send and this click — see
      // send/route.ts's isDeliveryRetry / W1-017 comment). A 200 here is
      // not proof of delivery; don't render "✓ Sent". Drop the retry
      // affordance (clicking it again hits the identical short-circuit)
      // and tell the operator plainly instead of a false success.
      if (data.alreadySent) {
        setSendStatus('already-sent');
        setDeliveryRetryChannel(null);
        setRetryIneligible(true);
        return;
      }
      // #264 round 2, FIX 4: mirror handleSendToCustomer's own failedChannels
      // handling (above) — this success branch previously cleared
      // deliveryWarning/deliveryRetryChannel UNCONDITIONALLY on any res.ok,
      // never inspecting data.failedChannels. A PARTIAL retry failure (one
      // channel finally delivered, the other times out/fails again) rendered
      // a clean "✓ Sent" and dropped the retry affordance for the channel
      // that's STILL undelivered. Only a full success now clears the
      // warning/retry state; a partial failure keeps both, scoped to
      // whichever channel(s) remain failed.
      const retryFailedChannels = Array.isArray(data.failedChannels)
        ? data.failedChannels.filter((value: unknown): value is 'sms' | 'email' => value === 'sms' || value === 'email')
        : [];
      setSendStatus('sent');
      setAlreadySentAt(null);
      if (retryFailedChannels.length > 0) {
        const retryChannel = retryFailedChannels.length === 2 ? 'both' : retryFailedChannels[0];
        setDeliveryRetryChannel(retryChannel);
        setDeliveryWarning(
          `${retryFailedChannels.map((c: 'sms' | 'email') => c.toUpperCase()).join(' and ')} failed. The other requested channel was delivered.${data.messageError ? ` (${data.messageError})` : ''}`,
        );
        // Row 269 fix round: see deliveryFailureHedged's state comment.
        setDeliveryFailureHedged(isTimeoutHedgedFailure(data.messageError));
      } else {
        setDeliveryWarning(null);
        setDeliveryRetryChannel(null);
        setDeliveryFailureHedged(false);
      }
      // #264 round 2, FIX 6: a delivery-only retry structurally never
      // attempts the GHL stage move — route.ts's ghlStageChain returns
      // immediately whenever isDeliveryRetry (see its own comment) — so
      // data.ghlSynced here can ONLY ever reflect a PRIOR sync, never one
      // just performed by this call. This branch previously never read it at
      // all, silently leaving whatever STALE ghlSyncWarning value was
      // already in state. On the exact sequence this fix targets (the
      // original stamp write times out client-side but commits server-side —
      // the route returns before ever reaching ghlStageChain, so
      // ghl_stage_synced_at is still null — the operator sees a bare error,
      // retries, hits alreadySent, clicks Force Redeliver), that stale value
      // was null, so the button rendered the FALSE "✓ Sent — stage moved to
      // Bid Sent" (see the button label a few hundred lines down) even
      // though no request in the whole sequence ever ran the stage move.
      // data.stageError is always undefined here (ghlStageChain never ran to
      // set it), so the generic handleSendToCustomer fallback text would be
      // misleading about WHY — this uses delivery-retry-specific wording
      // instead. Setting ghlSyncWarning also surfaces the existing "Retry CRM
      // sync" button (?retryGhl) for free — that render block isn't gated to
      // fresh sends only.
      setGhlSyncWarning(
        data.ghlSynced === false
          ? 'This was a delivery-only retry, which never touches the CRM card.'
          : null,
      );
      // FIX A (#237 fix round): deliberately NOT touching eventDateSyncWarning
      // here — a delivery-only retry structurally never re-runs the
      // event-date push either (route.ts's ghlStageChain returns immediately
      // on isDeliveryRetry, same as the stage move), and unlike ghlSynced
      // there's no persisted server-side flag (no ghl_stage_synced_at
      // equivalent) this route could read to reconstruct "was a PRIOR push
      // failing." Leaving the state as-is is the honest choice: it already
      // reflects the outcome of the last attempt that actually ran, and this
      // click made no new attempt.
    } catch (err) {
      setSendStatus('error');
      setSendError(err instanceof Error ? err.message : 'Delivery retry failed');
    } finally {
      sendInFlightRef.current = false;
    }
  };

  // Row 269 fix round: none of the three redeliver buttons below had ANY
  // confirm gate — a stray click blind-fired a real customer text/email with
  // zero friction. The two wrappers below gate handleRetryDelivery itself
  // (never called directly from a button anymore), mirroring
  // PipelineActionsMenu.tsx's redeliverAndReport idiom (window.prompt +
  // exact-"YES" + mistype feedback for typed-yes; plain window.confirm
  // otherwise) so a declined/mistyped gate makes ZERO network requests —
  // handleRetryDelivery's own fetch is the only thing that reaches the wire.

  // The alreadySent-origin button. Row 269 fix round FIX 3 (MED —
  // over-gating): used to be always typed-YES, unconditionally, with no
  // regard for WHY deliveryRetryChannel is being offered. alreadySentChannels
  // (state, set when the alreadySent response was processed — see its own
  // comment) carries per-channel classification for the SAME channel(s)
  // deliveryRetryChannel offers. A channel classified 'failed' there is a
  // CONFIRMED rejection on the EARLIER send (the customer verifiably got
  // nothing on that channel), so a duplicate is structurally impossible and
  // the low-friction plain confirm from RetryGate's doc comment
  // (pipelineSendOutcome.ts) is correct — over-gating trains operators to
  // type YES reflexively, eroding the gate where it actually matters. A
  // channel classified 'unknown' (no delivery row logged, or a
  // timeout-hedged failure) keeps typed-YES: the customer may already have
  // it. The strictest classification among the offered channels wins for a
  // 'both' offer (same reasoning as retryOfferFor's timeoutHedged param,
  // below, and decideSendOutcome's identical alreadySent-branch rule for
  // PipelineActionsMenu — row 269 fix round FIX 1).
  //
  // retryOfferFor does NOT fit here (tried first, per the fix brief): its
  // hedged branch is worded "This attempt's outcome is unknown" (row 269 fix
  // round 2: reworded from the earlier "This attempt included a timeout",
  // which named the wrong cause once the hedge widened beyond literal
  // timeouts — see retryOfferFor's own comment) — correct for
  // handleScopedRetryClick below, where THIS click's own delivery attempt
  // just failed, but wrong here, where the ambiguous outcome belongs to an
  // EARLIER send, not this click. Kept as its own small, local gate
  // derivation with wording specific to the alreadySent context instead of
  // reusing a function whose copy would misdescribe what actually happened.
  const handleForceRedeliverClick = async () => {
    if (!deliveryRetryChannel) return;
    const label = deliveryRetryChannel === 'both' ? 'SMS + email' : deliveryRetryChannel.toUpperCase();
    const offeredClassifications: ChannelDeliveryClassification[] =
      deliveryRetryChannel === 'both'
        ? [alreadySentChannels?.sms.classification ?? 'unknown', alreadySentChannels?.email.classification ?? 'unknown']
        : [alreadySentChannels?.[deliveryRetryChannel].classification ?? 'unknown'];
    const gate: RetryGate = offeredClassifications.some((c) => c === 'unknown') ? 'typed-yes' : 'confirm';
    if (gate === 'typed-yes') {
      const typed = window.prompt(
        `This quote was already sent and the customer may already have it. Type YES to redeliver ${label} now:`,
      );
      if (typed === null) return; // Cancel — deliberate, stays silent.
      if (typed.trim().toUpperCase() !== 'YES') {
        window.alert('Not redelivered — type YES exactly to confirm.');
        return;
      }
    } else if (
      !window.confirm(`This quote was already sent, but ${label} confirmed failed to deliver on that send — redeliver it now?`)
    ) {
      return;
    }
    await handleRetryDelivery();
  };

  // The partial-failure (~6135) and error-state (~6120) buttons: derives its
  // gate from retryOfferFor (pipelineSendOutcome.ts) — the SAME function
  // PipelineActionsMenu uses — off deliveryFailureHedged (captured at the
  // moment the current failure/warning was set, not re-sniffed from the
  // rendered string here). A confirmed failure stays low-friction (a
  // duplicate is impossible — the customer got nothing from THIS attempt); a
  // timeout-hedged failure steps up to typed-YES (GHL may have delivered it
  // anyway).
  const handleScopedRetryClick = async () => {
    if (!deliveryRetryChannel) return;
    const { retryPrompt, retryGate } = retryOfferFor(deliveryRetryChannel, true, deliveryFailureHedged);
    if (retryGate === 'typed-yes') {
      const typed = window.prompt(retryPrompt);
      if (typed === null) return; // Cancel — deliberate, stays silent.
      if (typed.trim().toUpperCase() !== 'YES') {
        window.alert('Not redelivered — type YES exactly to confirm.');
        return;
      }
    } else if (!window.confirm(retryPrompt)) {
      return;
    }
    await handleRetryDelivery();
  };

  // Re-run ONLY the HighLevel stage-sync for a quote that was sent locally but
  // whose pipeline card never advanced (?retryGhl). Does not re-stamp sent or
  // re-message the customer (the route guards that). Best-effort.
  const handleRetryGhlSync = async () => {
    if (!savedQuoteId) return;
    setSendStatus('sending');
    try {
      const res = await fetch(`/api/quotes/${savedQuoteId}/send?retryGhl=1`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Retry failed (${res.status})`);
      setSendStatus('sent');
      setGhlSyncWarning(
        data.ghlSynced === false
          ? (data.stageError ?? 'The HighLevel card still has not advanced — check the integration.')
          : null,
      );
      // FIX A (#237 fix round): ?retryGhl re-runs the WHOLE stage chain
      // (route.ts), including the event-date push — see that route's
      // comment on the push's placement — so this retry's own outcome for
      // BOTH banners comes back in the same response.
      setEventDateSyncWarning(data.eventDateSyncError ?? null);
    } catch (err) {
      // It was already sent; only the sync retry failed. The request itself
      // never completed, so there's no per-banner outcome to distinguish —
      // both warnings reflect the one real fact: this retry attempt failed.
      // eventDateSyncWarning only for an event quote (form.serviceType
      // guard): a non-event quote never had an event date to sync in the
      // first place, so showing that banner here would be a false claim,
      // not an honest one.
      setSendStatus('sent');
      const message = err instanceof Error ? err.message : 'CRM sync retry failed.';
      setGhlSyncWarning(message);
      if (form.serviceType === 'event') setEventDateSyncWarning(message);
    }
  };

  // Run the quote calculation. `rooflineChoiceOverride` lets the breakdown's
  // staff-pick radios re-quote with a specific Santa's/Gingerbread choice
  // (#17 Phase 1b) without waiting on the async form-state update.
  // Returns whether the save actually PERSISTED (data.persisted from
  // /api/quote — a 200 with quoteId:null / persisted:false means the DB write
  // itself failed even though pricing succeeded). Referral program (#41
  // adversarial-review HIGH fix): applyReferralCredit / handleReferralCreditRemoved
  // await this to know whether their own persist attempt actually landed, so
  // they can surface a blocking warning instead of assuming success. Existing
  // callers (the plain Calculate button, commitLinePrice/resetLinePrice) all
  // call this with `void` and never read the return value — adding it is
  // purely additive.
  const runQuote = async (
    rooflineChoiceOverride?: RooflineChoice,
    // #104: an explicit form snapshot to price with (bypasses async form state,
    // like rooflineChoiceOverride) when a click-to-edit commit re-prices in place
    // and may also clear the #102 $/ft on that line.
    formOverride?: QuoteFormData,
  ): Promise<boolean> => {
    if (quoteSaveInProgressRef.current) return false;
    if (satelliteChangeInProgressRef.current || designPhotoChangeInProgressRef.current) {
      setResult(null);
      setError('Wait for the house images to finish loading, then Calculate again.');
      return false;
    }
    const satelliteTraceVersionAtStart = satelliteTraceVersionRef.current;
    quoteSaveInProgressRef.current = true;
    setLoading(true);
    setError(null);
    // Premerge finding 3 fix: keep the last-known-good result/baseline around
    // so a rejected save can restore them instead of leaving the breakdown
    // vaporized (see the 409 handling below).
    const prevResult = result;
    const prevBaseline = baselineResult;
    setResult(null);
    // #172: keep a genuinely-attached chip through a recalculation — the
    // save-flow's lastAttachKey guard skips re-attaching the same pair, so
    // resetting here would blank a link that is still real (review LOW).
    const attachKeyNow = savedQuoteId && highlevelContact?.id ? `${savedQuoteId}:${highlevelContact.id}` : null;
    if (!(attachStatus === 'attached' && attachKeyNow && lastAttachKey.current === attachKeyNow)) {
      setAttachStatus('idle');
      setAttachError(null);
    }
    setSendStatus('idle');
    setSendError(null);
    setAlreadySentAt(null);
    // #839 fix-round MED: reset before every Calculate — a PRIOR call's freeze
    // must not keep showing after a later call that didn't hit it (e.g. an
    // unrelated field edit right after a frozen attempt).
    setIdentityFrozenNotice(false);
    // #241: reset alongside its siblings. Not visible today (the notice that
    // reads it is gated on sendStatus === 'already-sent', which this same block
    // clears, and both places that re-enter that status reset this flag first)
    // — but leaving it dangling true after a recalc is a trap for any future
    // path that sets 'already-sent' without going through those two functions.
    setRetryIneligible(false);
    // Row 269 fix round FIX 5 (LOW): the two fields this fix round added
    // (deliveryFailureHedged, alreadySentChannels) were missing from this
    // same reset block — the exact "trap for any future path" the comment
    // above already warns about. Inert today for the same reason
    // retryIneligible is (both re-entry points reset these first), but
    // leaving them dangling here is the trap, not a bug yet.
    setDeliveryFailureHedged(false);
    setAlreadySentChannels(null);
    setCopiedUrl(false);
    setTrainStatus('idle');
    setTrainError(null);

    // Once a quote exists (edit mode, or any Calculate after the first on a
    // new quote), recalculating UPDATES that row in place — no more duplicate
    // rows piling up in /admin/quotes (#31).
    const existingQuoteId = savedQuoteId;
    // Row 406: the snapshot this save actually SENDS. Recorded as the new
    // persisted baseline only once the server confirms the row was written
    // (persisted === true, below) — never on a 200 that failed to save, which
    // would silently clear the unsaved-changes warning on work still at risk.
    const sentForm = formOverride ?? form;
    const inputs = buildQuoteInputs(sentForm, rooflineChoiceOverride);
    const quoteBuildTimer = quoteBuildTimerRef.current?.current();

    try {
      // Flush a pending design edit first (#8 M6): /api/quote projects the
      // design's scene server-side, so an un-persisted edit would price a
      // stale design. No-op when nothing's pending.
      // #110 #80-102 (sibling of W3-006): a flush rejection here would silently
      // price a stale, pre-edit scene — warn instead of proceeding as if the
      // operator's latest edits were included.
      if (designId && editorFlushRef.current) {
        try {
          await editorFlushRef.current();
        } catch {
          setError('Design may not have saved — retry before calculating');
          return false;
        }
      }
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // designId → if the linked design has per-unit items, the route uses
        // them (design-driven pricing); otherwise the form's per-unit entry
        // drives it (decision 2a fallback).
        body: JSON.stringify({
          customer: form.customer,
          serviceType: form.serviceType,
          inputs,
          quoteId: existingQuoteId ?? undefined,
          designId: designId ?? undefined,
          // Test Quote (#93): carried only into the first save (saveQuote);
          // ignored on update, so is_test is set once and never flips.
          isTest,
          // Amend re-price (audit follow-up): re-pricing a BOOKED order in place is
          // server-locked (409 quote-locked) UNLESS this operator-only flag is set —
          // that lock otherwise freezes the amend delta at 0 forever. The job page's
          // "Amend order" flow tells the operator to open the booked quote here and
          // Calculate to re-price; this is that re-price. Gated to exactly 'booked'
          // (the one locked-but-amendable status; the server only honors it there),
          // so a normal edit of an unbooked quote sends nothing and stays locked.
          // `undefined` is dropped by JSON.stringify, so no key ships when not booked.
          amendReprice: savedStatus === 'booked' ? true : undefined,
          // Referral program (#41): sent on every save. The server creates
          // the pending "mention" referral on a NEW quote's first save
          // (saveQuote) and ALSO on an update when none exists yet for this
          // quote (updateQuote) — e.g. staff picking a referrer after
          // reopening a quote that never had one (adversarial-review fix;
          // both paths are idempotent, so a resave never duplicates it).
          referredByCustomerId: referredBy?.id ?? undefined,
          // #214: the session's LIVE hl link, sent explicitly on every save
          // (string = linked via prefill/pick/reopen-seed · null = no
          // contact this session). Insert: lands in the row (saveQuote).
          // Update: identity-resolution input only — the server never
          // writes the highlevel_contact_id column from this (the attach
          // route stays that column's post-insert writer), so it can't
          // clobber the stored link; explicit null stops the server falling
          // back to a stored id the session already cleared.
          highlevelContactId: form.highlevelContactId,
          // NCE + YLL Neighbor tags (#198): 'insert' (no existingQuoteId yet
          // — this save creates the row) sends the displayed value outright,
          // so an inherited-but-unclicked tag lands on the brand-new quote;
          // 'update' (existingQuoteId present) gates on touched, so a
          // Calculate on a tab left open can't clobber a concurrent
          // admin-detail toggle — see resolveTagPayload's doc comment.
          ...resolveTagPayload(
            legacyRebook,
            legacyRebookTouchedRef.current,
            isNce,
            isNceTouchedRef.current,
            existingQuoteId ? 'update' : 'insert',
          ),
          ...(quoteBuildTimer ? quoteBuildTimer : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Premerge finding 3 fix: a 409 from one of the three post-approval
        // lock codes (route.ts:~716-737) means a stale tab tried to save a
        // price/label/bistro-footage edit against a quote that's since been
        // approved (or, per finding 4, whose approval this tab's own derived
        // state hadn't caught up to). setResult(null) above already nulled
        // the breakdown; every price/label/footage control lives inside
        // `{result && (...)}`, so leaving it null here would strand the tab
        // on a red banner with no way back short of a full reload (losing any
        // other unsaved edits). Restore the last-known-good result/baseline
        // and flip the tab to frozen so the controls lock with the honest
        // post-approval copy — the tab self-corrects to server truth instead
        // of staying editable and re-erroring on every retry.
        // Row 367 delta-verify MED: 'design-locked' deliberately does NOT
        // belong here. This set is only ever matched against /api/quote's
        // response, and /api/quote never returns that code (grep-confirmed) —
        // adding it read as a self-correction that could not fire. The design
        // routes that DO return it self-correct through noteDesignLocked()
        // below instead.
        // Row 444 joins this set for the same reason the other three are in it:
        // setResult(null) has already nulled the breakdown, and every pricing
        // control lives inside `{result && (...)}`, so without the restore below
        // a staffer who clicks Calculate on a migrated quote is left staring at
        // a red banner with no way back short of a reload. The tab self-corrects
        // to server truth - which for a migrated order is "these figures are not
        // ours to recompute" - instead of staying editable and re-erroring.
        const LOCK_CODES = new Set([
          'price-override-locked',
          'label-override-locked',
          'bistro-footage-locked',
          'migrated-quote-locked',
        ]);
        if (res.status === 409 && typeof data?.code === 'string' && LOCK_CODES.has(data.code)) {
          setResult(prevResult);
          setBaselineResult(prevBaseline);
          setStaleApprovalFrozen(true);
        }
        throw new Error(data.error ?? 'Request failed');
      }
      // #41 adversarial-review HIGH fix: the real save-succeeded signal — a
      // 200 with persisted:false means the DB write failed even though
      // pricing succeeded (see /api/quote's own persisted: saved !== null).
      const persisted = data.persisted === true;
      // Row 406: the database now matches `sentForm`, so that becomes the
      // baseline the unsaved-changes warning compares against. Anything the
      // operator typed WHILE this save was in flight differs from it and stays
      // flagged, which is the intended behaviour.
      if (persisted) setLastPersistedForm(stableStringify(sentForm));
      // #839 fix-round MED: surface the #251 freeze when it actually fired on
      // THIS save (route.ts only sends the key when updateQuote set it —
      // absent/falsy on every normal save, including a brand-new insert).
      if (data.identityFrozen === true) setIdentityFrozenNotice(true);
      // Row 344 Part B: surface a scene-driven reprice of an approved-
      // not-booked quote the same way — route.ts only sends this key when
      // the save actually changed the total (see its own comment).
      if (
        data.repricedAfterApproval &&
        typeof data.repricedAfterApproval.previousTotalUsd === 'number' &&
        typeof data.repricedAfterApproval.newTotalUsd === 'number' &&
        typeof data.repricedAfterApproval.deltaUsd === 'number' &&
        typeof data.repricedAfterApproval.portalShowsFrozenPrice === 'boolean' &&
        typeof data.repricedAfterApproval.hasAcceptedAmendment === 'boolean'
      ) {
        setPostApprovalRepriceNotice(data.repricedAfterApproval);
      }
      // The result is deliberately NOT exposed here. It is set AFTER the
      // satellite plan is durably stored (below), so a failed plan save cannot
      // leave a Send-ready quote on screen beside its own error banner.
      const newQuoteId = typeof data.quoteId === 'string' ? data.quoteId : null;
      // Only overwrite savedQuoteId on a real id (#110 W3-004 / #80-105). A 200
      // response with quoteId:null means the server-side save/update failed
      // (e.g. a transient Supabase error on an in-place re-price) — nulling a
      // previously-valid id here would orphan that row and make the next
      // Calculate INSERT a duplicate instead of updating it. Mirrors the same
      // guard already used by recommendRoofline below.
      if (newQuoteId) {
        setSavedQuoteId(newQuoteId);
        void quoteBuildTimerRef.current?.link(newQuoteId);
        // Draft autosave (quote-forms-partial-save): the saved row is now the
        // store of record, so drop the local draft + hide the restored note.
        clearQuoteDraft();
        setDraftRestored(false);
      }
      // Persist the staff-confirmed satellite measurement lines onto the
      // design (#8 Stage A) — Calculate is the "measurement finalized"
      // moment. Only when a satellite session is actually active: a reopened
      // quote with no satellite state must NOT clobber stored lines.
      const holidaySatelliteActive =
        satellitePreview != null &&
        (satelliteSantasLines.length > 0 || satelliteGingerbreadLines.length > 0 || satelliteC9Lines.length > 0 || satelliteStakeLines.length > 0);
      // Permanent (#88/S23): persist the four side traces so the portal draws them.
      const permanentSatelliteActive =
        form.serviceType === 'permanent' && PERMANENT_SIDES.some((s) => permanentSatLines[s].length > 0);
      // Permanent Bistro Lighting (#117): persist the bistro runs so the portal
      // draws them (the drawn geometry, not the derived footage — the design's
      // satelliteLines mirror the builder's own line shape, same as permanent).
      const bistroSatelliteActive =
        form.serviceType === 'permanent_bistro' && satelliteBistroLines.length > 0;
      if (newQuoteId && (holidaySatelliteActive || permanentSatelliteActive || bistroSatelliteActive)) {
        const satelliteLines = permanentSatelliteActive
          ? {
              front: permanentSatLines.front,
              left: permanentSatLines.left,
              right: permanentSatLines.right,
              back: permanentSatLines.back,
            }
          : bistroSatelliteActive
            ? { bistro: satelliteBistroLines }
            : {
                santas: satelliteSantasLines,
                gingerbread: satelliteGingerbreadLines,
                c9: satelliteC9Lines,
                stake: satelliteStakeLines,
                ...(satFootage.santas != null ? { santasFootage: satFootage.santas } : {}),
                ...(satFootage.ginger != null ? { gingerbreadFootage: satFootage.ginger } : {}),
              };
        try {
          // A photo lookup may already be creating or updating the design.
          // Reuse that row and let it drain any parked satellite first.
          if (designPhotoOperationRef.current) await designPhotoOperationRef.current;
          // The photo operation can start a background satellite save, so read
          // both refs only AFTER that operation has settled.
          const inFlightSatelliteSave = satelliteContextSaveRef.current;
          const parkedSatelliteContext = pendingContextRef.current?.satelliteBase64
            ? pendingContextRef.current
            : null;
          const satelliteContext = parkedSatelliteContext ?? inFlightSatelliteSave?.context ?? null;
          await persistSatelliteMeasurements({
            designId: designIdRef.current ?? designId,
            quoteId: newQuoteId,
            satelliteContext,
            satelliteLines,
            inFlightSatelliteSave,
            onDesignCreated: (id) => {
              designIdRef.current = id;
              setDesignId(id);
            },
          });
          if (pendingContextRef.current === satelliteContext) {
            pendingContextRef.current = null;
            pendingSatelliteAddressRef.current = null;
          }
          if (satelliteContextSaveRef.current === inFlightSatelliteSave) {
            satelliteContextSaveRef.current = null;
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'Unknown satellite save error';
          throw new Error(`Quote saved, but its satellite plan did not save: ${detail}`);
        }
      }
      // Do not expose a sendable result until the customer-facing satellite
      // plan is durably stored. A failed image/trace save leaves an explicit
      // retry error instead of a quote that looks ready to send.
      if (satelliteTraceVersionRef.current !== satelliteTraceVersionAtStart) {
        throw new Error('Quote saved, but the satellite trace changed while saving. Click Calculate again.');
      }
      setResult(data.result);
      setBaselineResult(data.baseline ?? data.result); // #104 "was $X" source
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
      // Attach to HL opportunity in parallel, if an HL contact was picked
      // (skipped when this quote+contact pair is already attached).
      const attachKey = newQuoteId && highlevelContact?.id ? `${newQuoteId}:${highlevelContact.id}` : null;
      if (attachKey && newQuoteId && highlevelContact?.id && lastAttachKey.current !== attachKey) {
        lastAttachKey.current = attachKey;
        // S30 wrap review MED: route through the serialized queue like every
        // other attach call site — a direct call could race a rapid re-pick
        // and leave the DB linked to the stale contact.
        void queueAttach(newQuoteId, highlevelContact.id, contactIdentityOf(highlevelContact));
      } else if (highlevelContact?.id && !newQuoteId) {
        // Quote wasn't persisted (Supabase not configured). Tell the
        // operator the HL link won't be made either.
        setAttachStatus('skipped');
        setAttachError('Quote not persisted — HighLevel link skipped. Check Supabase config.');
      }
      return persisted;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    } finally {
      quoteSaveInProgressRef.current = false;
      setLoading(false);
    }
  };

  // Staff recommends which roofline the customer sees by default. Lighter than
  // a full re-quote: re-prices the EXISTING quote in place (no new row, no
  // re-render, no scroll) so only the price/breakdown updates (#17 Phase 1b).
  const recommendRoofline = async (choice: RooflineChoice) => {
    if (loading) return;
    const prevChoice = form.rooflineChoice;
    setForm((f) => ({ ...f, rooflineChoice: choice }));
    setLoading(true);
    setError(null);
    try {
      const inputs = buildQuoteInputs(form, choice);
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // quoteId → re-price that quote in place; falls back to a fresh save
        // if the quote wasn't persisted (Supabase unconfigured).
        body: JSON.stringify({
          customer: form.customer,
          serviceType: form.serviceType,
          inputs,
          quoteId: savedQuoteId ?? undefined,
          designId: designId ?? undefined,
          // #214 review fix (staff MED): recommendRoofline is the builder's
          // SECOND /api/quote caller and was missed by the first #214 pass —
          // sending customer WITHOUT the session hl made the server fall
          // back to the STORED hl id (possibly the pre-pick one, if the
          // pick-time attach hadn't landed) paired with the FRESH form
          // fields: the same self-inconsistent identity class as the attach
          // route's stale-fields bug, inverted. Same live value runQuote
          // sends.
          highlevelContactId: form.highlevelContactId,
          // NCE + YLL Neighbor tags (#198 review fix, staff HIGH): this
          // payload used to omit the tags entirely, so a toggled chip
          // followed by a roofline-radio pick + Send never persisted the
          // toggle (recommendRoofline is its own /api/quote round trip, not
          // routed through runQuote). Same resolveTagPayload rule as the
          // main Calculate/Save call, INCLUDING the insert/update derivation
          // — recommendRoofline can itself fire pre-first-save (savedQuoteId
          // still null: e.g. Supabase was briefly unconfigured on the
          // original Calculate, so persisted:false and savedQuoteId was
          // never set), so this re-derives mode from savedQuoteId fresh here
          // rather than assuming an existing row.
          ...resolveTagPayload(
            legacyRebook,
            legacyRebookTouchedRef.current,
            isNce,
            isNceTouchedRef.current,
            savedQuoteId ? 'update' : 'insert',
          ),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data.result);
      setBaselineResult(data.baseline ?? data.result); // #104
      if (typeof data.quoteId === 'string') setSavedQuoteId(data.quoteId);
      // Row 406 premerge (THREE lenses converged — admin, staff, technical):
      // recommendRoofline is the builder's SECOND /api/quote writer, and the
      // unsaved-changes baseline lived only in runQuote's success branch. The
      // roofline radio is a real input, so `userTouched` latches, and this
      // call then changes form.rooflineChoice and SAVES it — leaving the
      // banner and the leave-site prompt armed forever after a routine
      // one-click action that had already persisted. A warning that can only
      // accumulate is exactly how staff learn to ignore warnings.
      //
      // The sibling-guard parity rule in AGENTS.md Pitfalls, one more time:
      // this file's own #214 and #198 fix rounds both caught recommendRoofline
      // missing something runQuote had. Gated on `persisted` for the same
      // reason runQuote is — a 200 that failed to write must not clear a
      // warning about work still at risk. The snapshot is the one this call
      // actually sent: `form` as captured above, with the new choice.
      if (data.persisted === true) {
        setLastPersistedForm(stableStringify({ ...form, rooflineChoice: choice }));
      }
    } catch (err) {
      // #110 W3-005: revert the optimistic rooflineChoice write on failure —
      // otherwise form.rooflineChoice stays desynced from the billed
      // result.rooflineChoice, and the next plain Calculate silently re-bills
      // the never-confirmed choice.
      setForm((f) => ({ ...f, rooflineChoice: prevChoice }));
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  // ─── Per-item "recommended" flag (#12) ───────────────────────────────────
  // Load the live design scene whenever a result lands (or after a write-back
  // remount) so the breakdown can link each line-item row to its scene item(s).
  // No design → null (only custom rows are then toggleable). Best-effort.
  useEffect(() => {
    let stale = false;
    // Defer so the setState isn't synchronous within the effect body
    // (project rule: react-hooks/set-state-in-effect is an error).
    queueMicrotask(() => {
      if (stale) return;
      if (!result || !designId) {
        setBreakdownScene(null);
        setBreakdownPhotoLabels(new Map());
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`/api/designs/${designId}`);
          const data = await res.json();
          if (!res.ok) return;
          const scene: Scene | undefined = data?.design?.scene;
          if (!stale && scene) {
            setBreakdownScene(scene);
            setBreakdownPhotoLabels(extraPhotoLabels(data?.design?.extraPhotos));
          }
        } catch {
          // Non-fatal: the breakdown still renders; only the design-item
          // checkboxes are unavailable until the next load.
        }
      })();
    });
    return () => { stale = true; };
  }, [result, designId, designEditorKey]);

  // Portal line items WITH scene links + the per-item `recommended` flag,
  // computed from the current result + the live scene. Aligns 1:1-by-order with
  // the breakdown's non-roofline rows (buildPortalLineItems prepends the
  // roofline OPTION rows and drops the billed roofline; the breakdown filters
  // the billed roofline the same way — so dropping the option ids leaves the
  // same rows in the same order).
  // #110 W3-015: memoized so the full scene projection (buildPortalLineItems →
  // attachSceneLinks/projectScene) only reruns when a field that actually feeds
  // pricing/labels changes — not on every render (e.g. a satellite-drag
  // pointermove or a keystroke in an unrelated form input).
  const breakdownLinked: PortalLineItem[] = useMemo(() => {
    if (!result) return [];
    const inputs = buildQuoteInputs(form);
    const { lineItems, roofline } = buildPortalLineItems(result, inputs);
    const linked = breakdownScene ? attachSceneLinks(lineItems, breakdownScene) : lineItems;
    const optionIds = new Set(roofline?.itemIds ?? []);
    return linked.filter((li) => !optionIds.has(li.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    result,
    breakdownScene,
    form.customLineItems,
    form.lineItemPriceOverrides,
    form.winterWonderlandRecommended,
    form.stakeLightingRecommended,
    form.rooflineChoice,
    form.permanent?.frontRecommended,
    form.permanent?.leftRecommended,
    form.permanent?.rightRecommended,
    form.permanent?.backRecommended,
  ]);

  // #12: the "recommended subtotal" = what the customer's portal opens with when
  // staff have recommended items = the checked per-unit/custom items PLUS the
  // recommended roofline (the portal always pre-selects it). Lets staff confirm
  // the recommendation clears the $1,000 minimum before sending.
  const recommendedCount = breakdownLinked.filter((li) => li.recommended).length;
  const recommendedRooflineAmount =
    result?.rooflineChoice === 'santas'
      ? result.rooflineOptions?.santas?.amount ?? 0
      : result?.rooflineChoice === 'gingerbread'
        ? result.rooflineOptions?.gingerbread?.amount ?? 0
        : 0;
  const recommendedSubtotal =
    breakdownLinked.reduce((s, li) => (li.recommended ? s + li.price : s), 0) +
    recommendedRooflineAmount;
  // #131: the summary below gates against the RIGHT minimum — a permanent quote
  // gates at its frozen snapshot minimumJobAmount, and a permanent bistro quote
  // at its own frozen snapshot minimum (#117 — 0 is a valid "gate off" value,
  // which the >= / < comparisons below already treat as "always clears").
  // Neither is the holiday $1,000.
  const breakdownMinimum =
    form.serviceType === 'permanent'
      ? result?.permanentRatesSnapshot?.minimumJobAmount ?? 2500
      : form.serviceType === 'permanent_bistro'
        ? result?.permanentBistroRatesSnapshot?.minimum ?? 0
        : BUSINESS_RULES.minimumQuoteAmount;

  // The engine emits one row per VALID custom line item, last, in order, with a
  // deterministic label. Map each to its index in form.customLineItems so a
  // checkbox toggle on a custom breakdown row writes back to the right form
  // entry. Built in the same order the engine consumes them.
  const customRowMatchers: { label: string; formIndex: number }[] = form.customLineItems
    .map((c, formIndex) => ({ c, formIndex }))
    .filter(({ c }) =>
      c &&
      typeof c.label === 'string' &&
      c.label.trim().length > 0 &&
      typeof c.amount === 'number' &&
      Number.isFinite(c.amount) &&
      c.amount >= 0,
    )
    .map(({ c, formIndex }) => {
      const qty =
        typeof c.quantity === 'number' && Number.isFinite(c.quantity) && c.quantity >= 1
          ? Math.floor(c.quantity)
          : 1;
      const label = qty === 1 ? c.label.trim() : `${c.label.trim()} × ${qty}`;
      return { label, formIndex };
    });

  // Write back a per-item recommended toggle. For a DESIGN row: flush the editor
  // first (avoid racing the autosave), GET the live scene, patch `recommended`
  // on the target scene item id(s), PUT it, then remount the editor + refetch.
  // For a CUSTOM row: flip it in form state (persists on the next Calculate,
  // consistent with how custom edits already work).
  const toggleDesignItemRecommended = async (sceneItemIds: string[], next: boolean) => {
    if (!designId || recommendBusy || sceneItemIds.length === 0) return;
    setRecommendBusy(true);
    try {
      // Persist any pending edit so we read + patch the freshest scene.
      if (editorFlushRef.current) {
        try { await editorFlushRef.current(); } catch { /* proceed with last-saved scene */ }
      }
      const getRes = await fetch(`/api/designs/${designId}`);
      const getData = await getRes.json();
      if (!getRes.ok) throw new Error(getData.error ?? 'Could not load the design');
      const scene: Scene = getData?.design?.scene ?? { yardsticks: [], items: [] };
      // Ledger row 260: round-trip the version this scene was read at as the
      // PUT's compare-and-swap precondition — this is a read-modify-write on
      // a scene we just flushed + fetched fresh, but another tab/operator
      // could still land a write in the gap, and the guard is what turns that
      // into an honest error instead of a silent overwrite.
      const readVersion: number | null = typeof getData?.design?.version === 'number' ? getData.design.version : null;
      const targets = new Set(sceneItemIds);
      const items = Array.isArray(scene.items) ? scene.items : [];
      const patched: Scene = {
        ...scene,
        items: items.map((it) => {
          // Direct hit: the projected line item maps to this scene item.
          if (targets.has(it.id)) return { ...it, recommended: next };
          // A grouped railing (#27 A2): projectScene reads `recommended` from
          // the GROUP item but its sceneItemIds are the MEMBER ids — so flag the
          // group whose members this row controls, or the flag won't round-trip.
          if (it.kind === 'miniGroup' && it.memberIds.length > 0 && it.memberIds.every((m) => targets.has(m))) {
            return { ...it, recommended: next };
          }
          return it;
        }),
      };
      const putRes = await fetch(`/api/designs/${designId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene: patched, version: readVersion }),
      });
      if (!putRes.ok) {
        const putData = await putRes.json().catch(() => ({}));
        noteDesignLocked(putData);
        throw new Error(putData.error ?? 'Could not save recommendation');
      }
      // Remount the editor + re-fetch the scene (also refreshes DesignSummary).
      setDesignEditorKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save recommendation');
    } finally {
      setRecommendBusy(false);
    }
  };

  return (
    <OperatorShell active="new">
      {/* Row 406: capture-phase input/change listener for the whole builder.
          Capture (not bubble) so a child that stops propagation cannot hide an
          edit from the guard, and on the inner wrapper rather than the shell so
          the nav's own controls never mark a quote dirty. */}
      <div
        className="max-w-3xl mx-auto"
        onInputCapture={markUserTouched}
        onChangeCapture={markUserTouched}
        onPointerDownCapture={markUserTouched}
        onKeyDownCapture={markUserTouched}
      >

        {/* TEST MODE banner (#93) — persistent while building/driving a test
            quote. Violet (not error-red / warning-amber) so it reads clearly as
            a non-production state, never as something broken. */}
        {isTest && (
          <div
            className="mb-6 rounded-lg border-2 border-dashed px-4 py-3 flex items-start gap-3"
            style={{ borderColor: '#7c3aed', backgroundColor: '#f5f3ff' }}
            role="status"
          >
            <span className="text-lg leading-none" aria-hidden>🧪</span>
            <div>
              <p className="text-sm font-bold uppercase tracking-wide" style={{ color: '#6d28d9' }}>
                Test Mode
              </p>
              <p className="text-xs mt-0.5" style={{ color: '#5b21b6' }}>
                Fully-simulated test quote. It flows the whole pipeline (send → approve → deposit → job → inventory)
                but never sends a real text/email or charges a card, and is excluded from every dashboard metric.
                Clean it up anytime with “Delete test data” in Settings.
              </p>
            </div>
          </div>
        )}

        {/* Row 413: recovered-edits offer. Rendered at the top (a mount-time
            decision the operator should see before touching anything), and an
            OFFER by design — restoring never happens automatically, and the
            offer withdraws itself on the first real edit (markUserTouched).
            It can only appear at all when the server row still matches the
            base the draft was edited on top of (quoteEditDraft's CAS-style
            check), so Restore can never clobber someone else's newer save. */}
        {editDraftOffer && (
          <div
            className="mb-6 rounded-lg border px-4 py-3 flex items-start gap-3"
            style={{ borderColor: '#f59e0b', backgroundColor: '#fffbeb' }}
            role="status"
          >
            <span aria-hidden="true">●</span>
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: '#92400e' }}>
                Unsaved edits from an earlier visit were recovered.
              </p>
              <p className="text-xs mt-0.5" style={{ color: '#92400e' }}>
                You edited this quote {formatDraftAge(editDraftOffer.savedAt)} but never clicked
                Calculate, so those changes are not in the saved quote. Restore them to keep
                working, or discard them to stay with what&rsquo;s saved.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="text-xs font-semibold px-3 py-1.5 rounded-md text-white"
                  style={{ backgroundColor: '#d97706' }}
                  onClick={() => {
                    const draft = editDraftOffer;
                    setEditDraftOffer(null);
                    if (!draft) return;
                    // Restoring IS an edit: latch the dirty machinery so the
                    // row-406 banner + beforeunload arm immediately, and the
                    // stash effect re-saves this draft until Calculate lands.
                    userTouchedRef.current = true;
                    setUserTouched(true);
                    setForm(draft.form);
                  }}
                >
                  Restore my edits
                </button>
                <button
                  type="button"
                  className="text-xs font-semibold px-3 py-1.5 rounded-md border"
                  style={{ borderColor: '#d97706', color: '#92400e' }}
                  onClick={() => {
                    // PR #972 staff lens MED: destructive with no undo, 8px
                    // from Restore - confirm, matching this file's convention
                    // for every other destructive action.
                    if (!window.confirm('Discard the recovered edits? This cannot be undone.')) return;
                    setEditDraftOffer(null);
                    if (editQuoteId) clearQuoteEditDraft(editQuoteId);
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PR #972 staff lens MED: the informational half - a stash existed
            but the quote changed since it was made, so it was discarded (the
            server wins, by design). Told once, dismissible, grey not amber:
            nothing is wrong and nothing is recoverable. */}
        {editDraftDiscardedNotice && (
          <div
            className="mb-6 rounded-lg border px-4 py-2.5 flex items-start gap-2 text-xs"
            style={{ borderColor: '#d1d5db', backgroundColor: '#f9fafb', color: '#4b5563' }}
            role="status"
          >
            <span className="flex-1">
              Unsaved edits from an earlier visit were found, but this quote has been changed since
              they were made - so they were discarded to protect the newer save.
            </span>
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => setEditDraftDiscardedNotice(false)}
            >
              OK
            </button>
          </div>
        )}

        {/* Row 420: sibling of the notice above, for a draft discarded because
            the quote's LIFECYCLE moved (approved / booked / declined since the
            stash). Different words on purpose: the form the draft was priced
            against may be untouched — what moved is the order's state, and
            restoring old numbers onto it is exactly what was refused. */}
        {editDraftLifecycleNotice && (
          <div
            className="mb-6 rounded-lg border px-4 py-2.5 flex items-start gap-2 text-xs"
            style={{ borderColor: '#d1d5db', backgroundColor: '#f9fafb', color: '#4b5563' }}
            role="status"
          >
            <span className="flex-1">
              Unsaved edits from an earlier visit were found, but they could not be safely
              re-applied - this quote&apos;s status has moved since they were made (approved, booked,
              declined), or they predate the status check - so they were discarded.
            </span>
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => setEditDraftLifecycleNotice(false)}
            >
              OK
            </button>
          </div>
        )}

        {/* PS-G2: booked-order banner — persistent so it's visible whether the
            operator arrives here to re-price or just to look. Re-pricing here
            (Calculate) only updates the number; it does NOT record the
            amendment (reason, balance re-sync, audit trail, customer notice).
            That control lives only on the job page, which the builder
            otherwise never links to — this closes that dead end. */}
        {savedStatus === 'booked' && savedJobId && !isMigrated && (
          <div className="mb-6 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            This order is booked. Calculate here to re-price, then{' '}
            <Link href={`/admin/jobs/${savedJobId}`} className="font-semibold underline hover:no-underline">
              open the job to record the amendment
            </Link>{' '}
            — that is what updates the balance, audit trail, and customer notice.
          </div>
        )}
        {/* Row 444, browser-check residual: the banner above invites a
            Calculate, which /api/quote refuses outright on a migrated order —
            and the amend flow it points at derives its delta from a fresh
            result, so it can never compute one either. Both halves of that
            instruction are dead here, so the banner is replaced rather than
            shown alongside a lock that contradicts it. */}
        {isMigrated && (
          <div className="mb-6 rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-800">
            <strong>This order came from home.works.</strong> Its figures are a record of what the customer agreed
            and paid — this tool did not calculate them and cannot re-price them, so Calculate and the amend flow
            are both closed here. To change this order, agree the new figures with Jason and record them directly.
          </div>
        )}

        {/* Header */}
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
            Yule Love Lights
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{editMode ? 'Edit Quote' : 'New Quote'}</h1>
            {isTest && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                Test
              </span>
            )}
            {/* Row 444, browser-check residual: the badge was wired into the
                quotes LIST and the read-only detail page but never into the
                builder — and the job page, the invoice page and the customer
                page all link straight here. A staffer arriving from any of them
                saw a locked screen with nothing on it saying why. */}
            {isMigrated && <MigratedBadge />}
            {/* View-only portal (#176) — mirrors the admin detail page's pill. */}
            {viewOnly && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">
                View-only
              </span>
            )}
            {/* Customer tenure (#178) — "Nth year — 2023 · 2024 · 2025", display-only. */}
            {customerTenureLabel && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700"
                title="Years with YLL"
              >
                {customerTenureLabel}
              </span>
            )}
            {/* Canonical lifecycle pill (BUG-1, S22): a declined/cancelled quote
                reads correctly instead of the old timestamp-only Approved/Sent. */}
            {savedStatus && (
              <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_BADGE[savedStatus].cls}`}>
                {STATUS_BADGE[savedStatus].label}
              </span>
            )}
            {/* Quote ID — appears once the quote exists (after the first Calculate
                on a new quote, or immediately when editing a saved one). Shows the
                sequential display number (#1010) when allocated, else the UUID
                prefix (a brand-new just-calculated quote until it's reopened). */}
            {savedQuoteId && (
              <span
                className="text-[11px] font-mono text-gray-500 bg-gray-100 px-2 py-0.5 rounded whitespace-nowrap"
                title={`Quote ID: ${savedQuoteId}`}
              >
                {quoteNumber != null ? `#${quoteNumber}` : `ID ${savedQuoteId.slice(0, 8)}`}
              </span>
            )}
          </div>
          {/* NCE + YLL Neighbor tag chips (#198) — directly under the heading,
              toggleable in BOTH new-quote and edit modes. Sets form state only,
              no immediate API call (unlike the admin detail page's
              LegacyRebookToggle/NceToggle, which fetch on click) — the chosen
              state persists on the next Calculate/Save like any other form
              field, same mount-hydrate-only convention as isTest/viewOnly (a
              customer tagged elsewhere mid-session isn't live-reflected
              here; staff re-check on reopen). This strip is the ONE place to
              see + set both tags in the builder — it replaces the old
              read-only YllNeighborBadge display that used to sit in the
              badge row above (no duplicate/contradictory Neighbor UI).
              NCE-tagging here also seeds the 40% deposit default via
              applyIsNce (#199, pre-approval only — see its own comment);
              the deposit input itself stays hand-editable after.
              #215: a MANUAL click now window.confirms first — Neighbor in
              BOTH directions, NCE in ON always and OFF when there's a real
              deposit or propagation consequence to disclose — mirroring the
              admin siblings' confirm+list pattern (legacyRebookConfirmMessage/
              nceConfirmMessage, quoteForm.ts — each owns its own per-direction
              when-to-prompt rule and exact copy). Automatic paths (the
              contact-pick tag inheritance a few hundred lines down, the
              mount-hydrate useState above) call applyLegacyRebook/applyIsNce
              directly and never prompt. Declining leaves the tag, deposit,
              and touched-ref exactly as they were — the touched-ref is set
              AFTER the confirm returns true, never before.
              #243 (domain rule locked 2026-08-11): the whole strip is HIDDEN
              on a non-holiday quote — permanent/event/bistro can carry
              neither tag, and the locked design is "silently do not inherit,
              no disabled-with-reason UI" (no tooltip-explains-why chip). The
              service-type switch handler a few hundred lines down clears any
              already-true tag the instant staff switch AWAY from holiday, so
              there's never a true-but-hidden tag left dangling from this UI
              alone (a REOPENED quote that was already tagged before this
              gate shipped is a separate, deliberately untouched case — see
              that handler's own comment). */}
          {canCarryNceOrYllNeighborTag(form.serviceType) && (
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => {
                // Direction comes from legacyRebookRef, NOT the render-closure
                // legacyRebook (#215 fix round F1 — sibling-guard parity with
                // the isNceRef fix just below): a stale closure read here
                // would prompt with one direction's consequences and then
                // apply the other's.
                const turningOn = !legacyRebookRef.current;
                const confirmMsg = legacyRebookConfirmMessage(turningOn, quoteLeftDraft);
                if (confirmMsg && !window.confirm(confirmMsg)) return;
                legacyRebookTouchedRef.current = true;
                applyLegacyRebook(turningOn);
              }}
              aria-pressed={legacyRebook}
              title={legacyRebook ? 'YLL Neighbor — click to remove' : 'Mark as YLL Neighbor'}
              className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border transition-colors ${
                legacyRebook
                  ? 'bg-sky-100 text-sky-700 border-sky-300'
                  : 'text-gray-400 border-gray-300 hover:bg-gray-50'
              }`}
            >
              YLL Neighbor
            </button>
            <button
              type="button"
              onClick={() => {
                // Direction comes from isNceRef, NOT the render-closure isNce
                // (#199 wrap-review LOW): restores the always-current guarantee
                // the pre-#199 bare `setIsNce((v) => !v)` functional form had.
                // #215 derives `turningOn` from that SAME ref so the confirm
                // copy and the apply can never disagree about which way this
                // click goes — a stale closure here would prompt with one
                // direction's consequences and then apply the other's.
                const turningOn = !isNceRef.current;
                const confirmMsg = nceConfirmMessage(
                  turningOn,
                  form.depositPercent,
                  nceDepositLocked,
                  nceDepositSetByRuleRef.current,
                  quoteLeftDraft,
                );
                if (confirmMsg && !window.confirm(confirmMsg)) return;
                isNceTouchedRef.current = true;
                // #199: applyIsNce (not a bare toggle) so turning the chip
                // on/off also sets/reverts the 40% deposit default.
                applyIsNce(turningOn);
              }}
              aria-pressed={isNce}
              title={isNce ? 'NCE — click to remove' : 'Mark as NCE (barter/trade network)'}
              className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border transition-colors ${
                isNce
                  ? 'bg-rose-100 text-rose-700 border-rose-300'
                  : 'text-gray-400 border-gray-300 hover:bg-gray-50'
              }`}
            >
              NCE
            </button>
          </div>
          )}
          {editMode && (
            <p className="text-xs text-gray-500 mt-1">
              Editing saved quote <span className="font-mono">{quoteNumber != null ? `#${quoteNumber}` : initialQuote?.quoteId.slice(0, 8)}</span> —
              {/* Row 444, browser-check residual: "Calculate updates this quote
                  in place" is false for a migrated order, where Calculate is
                  refused. Same class as the banner and the design-lock copy
                  above: a sentence written for the ordinary case, left standing
                  in a case where it is now a lie. */}
              {' '}
              {isMigrated
                ? 'its figures came from home.works and cannot be re-priced here.'
                : <>Calculate updates this quote in place{initialQuote?.approvedAt
                ? '. ⚠️ The customer already APPROVED this quote; edits change what their portal shows.'
                : initialQuote?.sentAt
                  ? '. ⚠️ This quote was already sent; edits change what the customer sees on their portal.'
                  : '.'}</>}
            </p>
          )}
        </div>

        {/* No <form> wrapper (#35): the embedded design editor's vanilla
            buttons carry no type attribute and would implicitly submit a
            surrounding form on every click. Calculate is a plain button. */}
        <div>

          {/* ── Customer Info ── */}
          <Section title="Customer Info">
            {/* HighLevel contact autocomplete — pick an existing lead to
                pre-fill the fields below. If no match (or if we're doing
                a walk-in quote), just type straight into the fields. */}
            <HighLevelContactAutocomplete
              selected={highlevelContact}
              onPick={pickHighLevelContact}
              onClear={clearHighLevelContact}
            />
            <p className="text-xs text-gray-500 mb-1">
              Name, phone, and email are optional here. The quote still saves. Address is optional too, and it
              helps if you want to tie the quote to a real property.
            </p>
            {/* PS-F4: the send route requires a linked HighLevel contact for any
                real (non-test) quote (no contact = the customer never gets
                texted/emailed and the pipeline card never moves) — say so up
                front instead of letting the operator fill in manual fields and
                only discover the block when Send 400s. Test quotes are exempt
                (the send route skips this check for them), so hide it there. */}
            {!isTest && !highlevelContact && !dbLinked && (
              <p className="text-xs text-amber-600 mb-3">
                A HighLevel contact is required before this quote can be sent. Pick one above, or fill in the
                fields below and link a contact before sending.
              </p>
            )}
            {/* #172: a reopened quote can be linked in the DB while the chip
                (session-only) is empty — say so instead of showing the amber
                "required" warning, which invited wrong re-picks on live jobs. */}
            {!isTest && !highlevelContact && dbLinked && (
              <p className="text-xs text-gray-500 mb-3">
                Linked to a HighLevel contact from a previous session. Pick a contact above only if you need to
                change the link.
              </p>
            )}
            {/* Draft autosave (quote-forms-partial-save): restored the customer
                info this browser had unsaved from a previous, un-Calculated
                quote. Dismiss+wipe with Clear. */}
            {draftRestored && (
              <div className="flex items-center justify-between gap-3 mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                <span>Restored customer info you started earlier but didn&apos;t save.</span>
                <button
                  type="button"
                  onClick={clearDraftAndReset}
                  className="font-semibold underline hover:text-blue-900 whitespace-nowrap"
                >
                  Clear
                </button>
              </div>
            )}
            {/* Row 206: a saved draft existed but was left untouched because a
                lead prefill was applied here — grey/dismissible, same
                convention as rows 413/420 (nothing is wrong, nothing was
                lost; the draft is still sitting in storage for a plain
                /quote/new visit). No Clear button: this notice never touched
                the draft, so there's nothing here to undo. */}
            {draftWithheldByPrefill && (
              <div
                className="flex items-center justify-between gap-3 mb-3 rounded-md border px-3 py-2 text-xs"
                style={{ borderColor: '#d1d5db', backgroundColor: '#f9fafb', color: '#4b5563' }}
                role="status"
              >
                <span>
                  A saved draft from an earlier, unfinished quote was found, but this quote was
                  started from a lead — so the draft was left untouched instead of overwriting
                  these fields. To get back to it, open{' '}
                  {/* A plain <a>, NOT next/link: this navigates to the SAME
                      route minus the ?prefill params, and the restore effect
                      is mount-once — a client transition would keep this
                      component instance alive and never re-offer the draft.
                      A full load guarantees a fresh mount (and the row-406
                      beforeunload warning still guards unsaved typing). */}
                  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full
                      document load is REQUIRED here, see comment above */}
                  <a href="/quote/new" className="font-semibold underline">
                    + New quote
                  </a>{' '}
                  directly (without a lead) and it will be offered there.
                </span>
                <button
                  type="button"
                  onClick={() => setDraftWithheldByPrefill(false)}
                  className="font-semibold underline whitespace-nowrap"
                >
                  OK
                </button>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Row 444 (premerge staff lens HIGH): these four were the only
                  editable fields left on a migrated quote, and the save that
                  would persist them is refused — so a staffer could type a
                  corrected phone number, see it sit there as if accepted, and
                  lose it. Read-only, with the reason on the field itself. */}
              <div>
                <label className={lbl} htmlFor="customer-name">Name</label>
                <input id="customer-name" className={inp} placeholder="Jane Smith (optional)"
                  readOnly={isMigrated} title={isMigrated ? MIGRATED_LOCK_REASON : undefined}
                  value={form.customer.name} onChange={e => setCustomer('name', e.target.value)} />
              </div>
              <div>
                <label className={lbl} htmlFor="customer-phone">Phone</label>
                <input id="customer-phone" className={inp} placeholder="(516) 555-0123"
                  readOnly={isMigrated} title={isMigrated ? MIGRATED_LOCK_REASON : undefined}
                  value={form.customer.phone} onChange={e => setCustomer('phone', e.target.value)} />
              </div>
              <div>
                <label className={lbl} htmlFor="customer-email">Email</label>
                <input id="customer-email" className={inp} type="email" placeholder="jane@example.com"
                  readOnly={isMigrated} title={isMigrated ? MIGRATED_LOCK_REASON : undefined}
                  value={form.customer.email} onChange={e => setCustomer('email', e.target.value)} />
              </div>
              <div>
                <label className={lbl} htmlFor="customer-address">Property Address</label>
                <input id="customer-address" className={inp} placeholder="123 Main St, Smithtown, NY 11787"
                  readOnly={isMigrated} title={isMigrated ? MIGRATED_LOCK_REASON : undefined}
                  value={form.customer.address} onChange={e => setCustomer('address', e.target.value)} />
              </div>
            </div>

            {/* Referral program (#41 "mention" attribution) — an existing
                customer staff picks as "Referred by" while building THIS quote. */}
            {/* ...and the prompt that stops that pick being missed. A referral
                only pays if the referrer is set BEFORE the deposit; adding it
                later does not accrue the credit. This reads back the 'link'
                row the friend created at /refer/<code>, which nothing else in
                the app has ever looked at. */}
            <ReferralPrefillNotice
              phone={form.customer.phone}
              email={form.customer.email}
              excludeCustomerId={linkedCustomerId}
              alreadySet={!!referredBy}
              onUse={setReferredBy}
            />
            <ReferredByPicker value={referredBy} onChange={setReferredBy} />

            {/* Referral program redemption (#41 PR 2) — referee side: this
                customer gets 2 free spritzers on their first quote. Shows once
                staff pick a referrer this session, OR (on a reopened quote)
                once the server already knows this quote is a referee.
                #117 review: positive service-type gate — spritzers are a
                product only on holiday and event; a permanent or bistro
                referee quote must not offer holiday stake decor as its reward. */}
            {isReferralReferee &&
              (form.serviceType === 'holiday' || form.serviceType === 'event') && (
              <ReferralSpritzerBanner alreadyAdded={spritzerLineAlreadyAdded} onAdd={addReferralSpritzers} />
            )}

            {/* Referral program redemption (#41 PR 2) — referrer side: this
                customer's own spendable credit. Only resolvable once the
                quote's customer is linked (a saved/reopened quote). */}
            {linkedCustomerId && savedQuoteId && (
              <ReferralCreditBanner
                customerId={linkedCustomerId}
                quoteId={savedQuoteId}
                balanceUsd={referralCreditUsd}
                appliedCredit={form.referralCredit}
                discountSlotOccupied={referralDiscountSlotOccupied}
                persistError={referralPersistError}
                onApplied={applyReferralCredit}
                onRemoved={handleReferralCreditRemoved}
              />
            )}

            {/* Service type (#58 Phase 2b) — which line this quote belongs to.
                Defaults to Holiday; drives the dashboard's per-service sections. */}
            <div className="mt-4">
              <label className={lbl}>Service type</label>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Service type">
                {SERVICE_TYPES.map(st => {
                  const selected = form.serviceType === st;
                  return (
                    <button
                      key={st}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        // Fix-round LOW-MED: a no-op re-click on the ALREADY-
                        // selected type must do nothing. Without this, the
                        // comment two blocks down ("this only fires when staff
                        // actually click a service-type button") was false —
                        // clicking the currently-selected button on a reopened
                        // quote holding a stale is_nce=true (e.g. from before
                        // this gate shipped) would still run
                        // clearNceOrNeighborOnServiceTypeSwitch, mark the tag
                        // TOUCHED, and write `false` on the next save. That only
                        // ever pushes toward the correct end state, but it's an
                        // unintended side effect of a click that changed nothing.
                        if (st === form.serviceType) return;
                        // #243 (domain rule locked 2026-08-11): switching AWAY
                        // from a type that can carry NCE/YLL Neighbor silently
                        // clears any currently-true chip — this ENFORCES the
                        // domain rule (same "silently, no disabled-with-reason
                        // UI" posture as the chip strip's own visibility gate
                        // above), it isn't offering staff a discretionary keep-
                        // or-drop choice. Reuses applyIsNce/applyLegacyRebook
                        // (not a hand-rolled clear) so the SAME deposit-revert +
                        // ref-sync a manual chip-off click gets also runs here —
                        // including staying a no-op on the deposit once the
                        // #177 freeze locks it (resolveNceDepositPercent's own
                        // `locked` branch; applyIsNce still flips the tag).
                        // Marks both touched-refs true so the correction
                        // actually PERSISTS on the next Calculate/Save — an
                        // UNTOUCHED chip sends `undefined` on an update ("leave
                        // the stored value alone"), which would otherwise leave
                        // this exact correction inert. A REOPENED quote that
                        // already carries a violating tag from before this
                        // gate shipped and is never re-typed here at all stays
                        // untouched by design (resolveTagPayload's own
                        // touched-gating protects it) — this only fires when
                        // staff actually click a DIFFERENT service-type button
                        // (the no-op re-click guard just above).
                        const { clearIsNce, clearLegacyRebook } =
                          clearNceOrNeighborOnServiceTypeSwitch(st, isNceRef.current, legacyRebookRef.current);
                        // Fix-round MED: this auto-clear reverts a MONEY setting
                        // (isNce's 40% deposit) with none of the disclosure the
                        // manual chip-off click a few hundred lines up gives —
                        // same end state, one path silent. Reuses the identical
                        // legacyRebookConfirmMessage/nceConfirmMessage(turningOn:
                        // false, ...) builders the manual click calls, so the
                        // copy can never drift between the two paths — a staff
                        // member sees the SAME "reverts your deposit from X% to
                        // blank" / "won't move any existing GHL card" bullets
                        // either way. Decision: confirm BEFORE, not a notice
                        // after — this is a money revert, and the manual OFF
                        // path already sets that bar. Declining aborts the WHOLE
                        // type switch (return before any apply/setForm below),
                        // never a partial state, because the #243 domain rule
                        // above is non-discretionary — there is no "switch type
                        // but keep the ineligible tag" outcome to decline into.
                        // Silent when clearIsNce/clearLegacyRebook are both
                        // false (nothing to disclose) or when nceConfirmMessage
                        // itself has nothing to disclose (deposit unaffected,
                        // never left draft) — exactly mirrors the manual click's
                        // own `confirmMsg && !window.confirm(...)` gate.
                        const clearMessages = [
                          clearLegacyRebook ? legacyRebookConfirmMessage(false, quoteLeftDraft) : null,
                          clearIsNce
                            ? nceConfirmMessage(
                                false,
                                form.depositPercent,
                                nceDepositLocked,
                                nceDepositSetByRuleRef.current,
                                quoteLeftDraft,
                              )
                            : null,
                        ].filter((m): m is string => m != null);
                        if (clearMessages.length > 0) {
                          const switchConfirmMsg = [
                            `Switching to ${SERVICE_TYPE_LABELS[st]} clears the tag(s) below — ${SERVICE_TYPE_LABELS[st]} can never carry NCE or YLL Neighbor:`,
                            '',
                            clearMessages.join('\n\n'),
                          ].join('\n');
                          if (!window.confirm(switchConfirmMsg)) return;
                        }
                        if (clearIsNce) {
                          isNceTouchedRef.current = true;
                          applyIsNce(false);
                        }
                        if (clearLegacyRebook) {
                          legacyRebookTouchedRef.current = true;
                          applyLegacyRebook(false);
                        }
                        setForm(f => ({
                          ...f,
                          serviceType: st,
                          // #212: September/October early-install is a holiday-seasonal
                          // pick — leaving it set while switching to a non-holiday type
                          // would silently block buildQuoteInputs's `discount` field
                          // (guarded on installTiming === 'none') while the builder's
                          // discount checkbox still LOOKED applied. clearHolidayOnlyDiscountState
                          // (quoteForm.ts) clears installTiming AND brings
                          // discountEnabled/discountAmount to a coherent rest state along
                          // with it — a no-op for a same-type click, a switch INTO holiday,
                          // or when installTiming was already 'none' (a genuine typed
                          // manual discount survives untouched; see that function's doc).
                          ...clearHolidayOnlyDiscountState(st, f),
                        }));
                      }}
                      className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${
                        selected
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {SERVICE_TYPE_LABELS[st]}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Holiday = seasonal install + takedown · Permanent = year-round · Event = date-driven (weddings, parties) · Bistro = permanent café lights.
              </p>
            </div>
          </Section>

          {form.serviceType === 'event' && (
            <Section title="Event details">
              <EventSection
                value={form.event}
                onChange={ev => setForm(f => ({ ...f, event: ev }))}
                onValidityChange={setEventDatesValid}
              />
            </Section>
          )}

          {/* ── Photo Analysis ── */}
          <Section title="House Photo — Auto-Measure">
            {/* Row 427b (premerge staff lens): this note used to live inside the
                "Move the Camera" box, which only renders when a Google geocode
                succeeded — so an approved quote where staff went straight to a
                manual upload showed NO visible lock text at all, just a
                disabled attribute and a title that is invisible on touch. At
                section level it covers every control in the section, and the
                copy now names them instead of only the camera. */}
            {postApprovalFrozen && (
              /* Row 444, browser-check residual: this section's copy was written
                 out longhand rather than reading POST_APPROVAL_DESIGN_LOCK_REASON,
                 so branching that constant for migrated orders left THIS block
                 still telling staff to decline, revive and re-send — futile,
                 since reviving does not clear the migration stamp. */
              <p className="text-xs text-amber-700 mb-3">
                {isMigrated ? (
                  <>
                    🔒 <strong>Locked — migrated order.</strong> This design and these figures came from
                    home.works, not from this tool, so nothing in this section can change them.
                  </>
                ) : (
                  <>
                    🔒 <strong>Locked after approval.</strong> The customer agreed to this photo and design,
                    so nothing in this section can change it — analyzing, moving the camera, saving an angle,
                    pulling or uploading a satellite image, and uploading a house photo are all disabled.
                    To change it: decline this quote, revive it, edit, and re-send. (A booked order is changed
                    through the amend flow.)
                  </>
                )}
              </p>
            )}
            <p className="text-xs text-gray-400 mb-3">
              {form.serviceType === 'permanent'
                ? 'Look up the address on Google Maps — the satellite auto-trace draws the four side rooflines (editable), and footage/corners/extensions follow the lines. Or upload a photo and draw/type manually.'
                : form.serviceType === 'permanent_bistro'
                  ? 'Look up the address on Google Maps for Street View + satellite imagery, or upload a photo. There is no auto-trace for bistro — draw the light runs on the Satellite tab (billing) and set the pole count below.'
                  : 'Look up the address on Google Maps (Street View + satellite) or upload a photo. Claude will estimate front gutterline, ridge + sides, bushes, trees, and columns.'}
            </p>

            {/* Google lookup — pulls Street View + satellite. Permanent skips the
                holiday analyzer (imagery only) so it never designs as Christmas. */}
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm font-medium text-blue-900">Look up on Google Maps</span>
                {/* Jason (2026-08-26): "Pull satellite" moved DOWN to the
                    manual satellite-photo row — it belongs with the satellite
                    slot it fills, not beside the full auto-measure. */}
                <button
                  type="button"
                  onClick={handleLookupAddress}
                  // Row 367, found by a live device check on approved quote
                  // #1290: this is the OTHER entry point into a scene seed
                  // (handleLookupAddress -> applyAnalysisResult ->
                  // seedDesignFromAnalysis -> POST seed-analysis). Its sibling
                  // "Analyze with Claude" was gated when the freeze shipped and
                  // this one was missed, so on an approved quote the server
                  // correctly refused the write while the button still invited
                  // the click. "Pull satellite" deliberately stays enabled: it
                  // fills the satellite slot and never seeds the scene, and the
                  // satellite trace is intentionally not frozen (Jason,
                  // 2026-08-27 — a re-Calculate must keep working).
                  disabled={lookingUp || loading || !form.customer.address.trim() || postApprovalFrozen}
                  title={
                    postApprovalFrozen
                      ? POST_APPROVAL_DESIGN_LOCK_REASON
                      : form.customer.address.trim()
                        ? undefined
                        : 'Enter the property address above first.'
                  }
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-medium text-sm px-4 py-2 rounded-md whitespace-nowrap"
                >
                  {lookingUp ? 'Looking up…' : '🏠 Analyze from Address'}
                </button>
              </div>
              <p className="text-xs text-blue-700">
                {form.serviceType === 'permanent'
                  ? 'Uses the Property Address above. Fetches Street View + satellite (with scale) so you draw the permanent roofline on a real photo.'
                  : form.serviceType === 'permanent_bistro'
                    ? 'Uses the Property Address above. Fetches Street View + satellite (with scale) so you draw the bistro runs on the Satellite tab.'
                    : 'Uses the Property Address above. Fetches Street View + satellite view, sends both to Claude.'}
                {' '}
                {'No Street View at the address? Use the "Pull satellite" button in the satellite section below — just the satellite image + scale, instant, then upload your own front photo.'}
              </p>
              {/* #95: quick link to open the house on Google Maps (standard pin, not
                  Street View) — precise coords once analyzed, else the matched/typed
                  address. Lets staff jump to the location themselves. */}
              {(form.customer.address.trim() !== '' || googleAddress != null) && (
                <p className="mt-2 text-xs">
                  <a
                    href={
                      geoLat != null && geoLng != null
                        ? `https://www.google.com/maps/search/?api=1&query=${geoLat},${geoLng}`
                        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(googleAddress ?? form.customer.address.trim())}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-700 font-medium underline hover:text-blue-900"
                  >
                    View on Google Maps ↗
                  </a>
                </p>
              )}
              {(form.customer.address.trim() !== '' || googleAddress != null) && (
                <p className="mt-2 text-xs">
                  <a
                    href={
                      geoLat != null && geoLng != null
                        ? `https://earth.google.com/web/search/${geoLat},${geoLng}`
                        : `https://earth.google.com/web/search/${encodeURIComponent(googleAddress ?? form.customer.address.trim())}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-700 font-medium underline hover:text-blue-900"
                  >
                    View on Google Earth ↗
                  </a>
                </p>
              )}
              {googleAddress && (
                <p className="mt-2 text-xs text-blue-800">
                  <span className="font-semibold">Matched:</span> {googleAddress}
                </p>
              )}
            </div>

            {/* Manual upload */}
            <p className="text-xs text-gray-500 font-medium mb-2">— Or upload a photo manually —</p>
            <div className="space-y-3">
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoSelect}
                // Row 427b, found by a live prod check on approved quote #1290:
                // the satellite upload beside it was gated and this one was not.
                //
                // Corrected after a premerge lens traced it: choosing a file
                // does NOT itself write. handlePhotoSelect sets photoFile /
                // photoPreview only; the eager design effect keys on
                // photoBase64, which the Analyze button sets — and that button
                // was already frozen. So this is a CONSISTENCY fix, not a
                // closed write path: it stops staff picking a photo, watching
                // the preview appear, and then finding the only button that can
                // do anything with it greyed out. The comment here first
                // claimed it closed a live write; it did not.
                disabled={loading || postApprovalFrozen}
                title={postApprovalFrozen ? POST_APPROVAL_DESIGN_LOCK_REASON : undefined}
                className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
              />
              {photoPreview && photoFile && (
                <div className="space-y-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoPreview} alt="House preview" className="w-48 h-auto rounded-md border border-gray-200" />
                  <button
                    type="button"
                    onClick={handleAnalyzePhoto}
                    // Row 367: seeding a scene past approval rewrites the
                    // picture the customer signed off on, and the server now
                    // refuses it — disable rather than let staff click into a
                    // 409 they can do nothing about.
                    disabled={analyzing || loading || postApprovalFrozen}
                    title={postApprovalFrozen ? POST_APPROVAL_DESIGN_LOCK_REASON : undefined}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-medium py-2 px-4 rounded-md text-sm"
                  >
                    {analyzing
                      ? 'Analyzing…'
                      : form.serviceType === 'permanent' || form.serviceType === 'permanent_bistro'
                        ? 'Load photo to design'
                        : 'Analyze with Claude'}
                  </button>
                </div>
              )}
              {/* Manual satellite slot (#9): so a hand-photographed house also
                  carries a top-down view into the design + training capture.
                  No auto-scale (that comes from the Google pull only) — staff
                  type the footage and trace lines for training value. */}
              <div className="pt-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Satellite photo (optional) — screenshot from Google Maps top-down
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleSatelliteSelect}
                    // Row 427: same write, same freeze — uploading a satellite
                    // photo replaces the image the customer approved.
                    disabled={loading || postApprovalFrozen}
                    title={postApprovalFrozen ? POST_APPROVAL_DESIGN_LOCK_REASON : undefined}
                    className="block flex-1 min-w-[14rem] text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                  />
                  {/* Jason (2026-08-26): moved here from the Google-Maps box
                      header — this button FILLS this satellite slot (image +
                      real scale, instant, no AI), so it lives beside it. Same
                      handler, same gating, pure relocation. */}
                  <button
                    type="button"
                    onClick={handlePullSatellite}
                    // Row 427 (premerge staff lens): this PR froze the write
                    // this button ends in (POST analysis-context swaps the
                    // satellite IMAGE the portal renders), so leaving it
                    // enabled meant a click that optimistically wiped the drawn
                    // trace, hit a 409, swallowed it in pushAnalysisContext's
                    // catch, and still told staff "Satellite loaded". The
                    // comment defending it as safe was written BEFORE this PR
                    // froze that route and went stale against my own change.
                    disabled={lookingUp || loading || !form.customer.address.trim() || postApprovalFrozen}
                    title={
                      postApprovalFrozen
                        ? POST_APPROVAL_DESIGN_LOCK_REASON
                        : form.customer.address.trim()
                          ? 'No Street View at this address? Skip straight to the satellite image + real scale — instant, no AI. Draw channels by hand.'
                          : 'Enter the property address above first.'
                    }
                    className="bg-white hover:bg-blue-50 disabled:bg-blue-50 disabled:text-blue-300 text-blue-700 border border-blue-300 font-medium text-sm px-3 py-2 rounded-md whitespace-nowrap"
                  >
                    {lookingUp ? 'Working…' : '🛰️ Pull satellite'}
                  </button>
                </div>
                {satellitePreview != null && satelliteFeetPerPixel == null && (
                  <p className="mt-1 text-xs text-amber-700">
                    Manual satellite has no known scale — trace the roofline on the Satellite tab for
                    reference, then type the footage into the fields below.
                  </p>
                )}
              </div>
              {satellitePreview && (
                <p className="text-xs text-gray-500 italic">
                  Roof measurements come from the Satellite tab below (or type them manually).
                </p>
              )}
              {analysisNotes && (
                <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800">
                  <strong className="block mb-1">
                    {form.serviceType === 'permanent' || form.serviceType === 'permanent_bistro'
                      ? 'Photo loaded for the design canvas.'
                      : 'Analysis complete — measurements auto-filled, roofline drawn on the design.'}
                    {fewShotCount > 0 && (
                      <span className="ml-1 font-normal">
                        • Using {fewShotCount} {fewShotRanking === 'similarity' ? 'similar' : 'recent'} past example{fewShotCount === 1 ? '' : 's'} as reference
                        {/* WT-33: similarity was expected (Voyage configured + a query
                            image) but still fell back to recency — likely a Voyage
                            outage, not the benign small-library case. A distinct badge
                            so this doesn't look identical to the ordinary 'recent' case. */}
                        {fewShotDegraded && (
                          <span className="ml-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800">
                            similarity search unavailable — verify against these examples
                          </span>
                        )}
                      </span>
                    )}
                  </strong>
                  {analysisNotes}
                </div>
              )}
              {(satelliteFootageDisagreement.santas || satelliteFootageDisagreement.gingerbread) && (
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-sm text-amber-800">
                  <strong className="block mb-1">Double-check the drawn satellite lines</strong>
                  {[satelliteFootageDisagreement.santas, satelliteFootageDisagreement.gingerbread]
                    .filter((note): note is string => note != null)
                    .map((note, i) => (
                      <p key={i} className={i > 0 ? 'mt-1' : undefined}>
                        {note}
                      </p>
                    ))}
                </div>
              )}
              {analysisWarning && (
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-sm text-amber-800">
                  <strong className="block mb-1">Auto-design unavailable — design manually</strong>
                  {analysisWarning}
                </div>
              )}
              {analysisError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                  {analysisError}
                </div>
              )}
            </div>
          </Section>

          {/* ── House — Design (street) + Satellite measurement (#35) ── */}
          {(designId || photoPreview || satellitePreview || designBusy) ? (
            /* #44 — break this section out wider than the form's max-w-3xl so the
               embedded editor (vanilla sidebar + Konva canvas) isn't squished and
               uses the empty L/R space on desktop. Centered via width + an
               auto-centering inline-start margin — deliberately NOT a CSS
               transform: a transformed ancestor would become the containing block
               for the editor's position:fixed full-screen overlay and break it.
               Width is capped to the viewport minus a gutter so it never overflows
               into a horizontal scrollbar; below lg it stays within the form column. */
            <div className="lg:[width:min(1120px,calc(100vw_-_3rem))] lg:[margin-inline-start:calc((100%_-_min(1120px,calc(100vw_-_3rem)))/2)]">
            <Section title="House — Design & Measure">
              {/* Tab switcher. Both panes stay MOUNTED across switches (CSS
                  hidden) so the design editor and the satellite lines never
                  lose state; switching to Design nudges a window resize so the
                  Konva canvas refits after being unhidden. */}
              <div className="mb-3 flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setViewMode('design');
                      requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))));
                    }}
                    className={`px-3 py-1.5 font-medium ${viewMode === 'design' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                  >
                    Design (Street)
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('satellite')}
                    disabled={!satellitePreview}
                    title={satellitePreview ? undefined : 'No satellite view — look up the address to get one.'}
                    className={`px-3 py-1.5 font-medium border-l border-gray-300 ${viewMode === 'satellite' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'} disabled:text-gray-300 disabled:hover:bg-white`}
                  >
                    Satellite (top-down)
                  </button>
                </div>
                {/* Santa's/Gingerbread roofline footage — holiday + event only
                    (the same engines that price those two fields; permanent and
                    permanent bistro don't). Positive list so a future type
                    defaults to hidden, not shown. */}
                {(form.serviceType === 'holiday' || form.serviceType === 'event') && satelliteFeetPerPixel != null && (
                  <div className="text-xs rounded border border-green-200 bg-green-50 px-2 py-1.5 font-semibold text-gray-700">
                    Satellite: front {satFootage.santas ?? '—'}ft · ridge+sides {satFootage.ginger ?? '—'}ft
                  </div>
                )}
              </div>

              {/* ── DESIGN tab — the design tool IS the street view (#35) ── */}
              <div className={viewMode === 'design' ? '' : 'hidden'}>
                {/* Street View angle controls — rotate around obstacles (trees,
                    parked cars). Only shown when we have Google coordinates.
                    Re-capturing swaps the design's base photo underneath the
                    drawn items — fix the angle BEFORE designing. */}
                {geoLat != null && geoLng != null && (
                  <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded-md">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                        Move the Camera
                      </span>
                      <span className="text-[11px] text-gray-500">
                        Tree or truck in the way? Move along the street, rotate, tilt, or zoom — then re-analyze. Best done before designing.
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Row 427: every camera move REPLACES the design's base
                          photo (moveStreetView/recaptureStreetView -> setPhotoBase64
                          -> POST /api/designs/[id]/photo), and saving an angle adds a
                          quoted extra photo. Both change the picture the customer
                          approved, so both are frozen with the rest of it - the server
                          refuses them too, this just stops staff clicking into a
                          refusal. Found by three premerge lenses on PR #998. */}
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => moveStreetView('left')}
                        title="Move the camera to the next panorama along the street (re-aims at the house)"
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ Along street
                      </button>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => moveStreetView('right')}
                        title="Move the camera to the next panorama along the street (re-aims at the house)"
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Along street ▶
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) - 30 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ Rotate −30°
                      </button>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) - 10 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ −10°
                      </button>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) + 10 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        +10° ▶
                      </button>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) + 30 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Rotate +30° ▶
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ pitch: Math.min(90, svPitch + 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ▲ Tilt Up
                      </button>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ pitch: Math.max(-90, svPitch - 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ▼ Tilt Down
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ fov: Math.min(120, svFov + 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        − Zoom Out
                      </button>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ fov: Math.max(30, svFov - 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        + Zoom In
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing || postApprovalFrozen}
                        onClick={() => recaptureStreetView({ heading: null, pitch: 0, fov: 80 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Reset
                      </button>
                      <button type="button" disabled={analyzing || recapturing || postApprovalFrozen}
                        title={postApprovalFrozen ? POST_APPROVAL_DESIGN_LOCK_REASON : undefined}
                        onClick={reanalyzeCurrent}
                        className="ml-auto text-xs font-semibold text-white bg-green-600 hover:bg-green-700 disabled:bg-green-300 rounded px-3 py-1.5">
                        {analyzing ? 'Re-analyzing…' : 'Re-analyze This View'}
                      </button>
                    </div>
                    {/* #13: grab an adjacent pano as an EXTRA photo (the main
                        camera + base photo stay put; the editor strip gains a
                        tab to draw the new angle on). */}
                    {designId && (
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <button type="button" disabled={savingVantage || recapturing || postApprovalFrozen}
                          onClick={() => void saveVantageAsExtra('left')}
                          title="Fetch the next panorama to the left (aimed at the house) and add it as an extra photo of the design — the current photo stays put"
                          className="text-xs font-medium border border-green-300 hover:border-green-500 text-green-800 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                          📌 ◀ Save prev angle as extra photo
                        </button>
                        <button type="button" disabled={savingVantage || recapturing || postApprovalFrozen}
                          onClick={() => void saveVantageAsExtra('right')}
                          title="Fetch the next panorama to the right (aimed at the house) and add it as an extra photo of the design — the current photo stays put"
                          className="text-xs font-medium border border-green-300 hover:border-green-500 text-green-800 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                          Save next angle as extra photo ▶ 📌
                        </button>
                        {savingVantage && <span className="text-[11px] text-blue-700 font-medium">Saving extra photo…</span>}
                      </div>
                    )}
                    <div className="mt-2 text-[11px] text-gray-500 tabular-nums">
                      heading {svHeading ?? 'auto'}° · pitch {svPitch}° · fov {svFov}°
                      {recapturing && <span className="ml-2 text-blue-700 font-medium">Fetching new angle…</span>}
                    </div>
                  </div>
                )}
                {designError && <p className="text-sm text-red-600 mb-2">{designError}</p>}
                {garlandUnestimated > 0 && (
                  <p className="text-sm text-amber-700 mb-2">
                    ⚠️ {garlandUnestimated} garland {garlandUnestimated === 1 ? 'run' : 'runs'} had no scale to
                    estimate length — billed as 1 section{garlandUnestimated === 1 ? '' : ' each'} for now. Draw a
                    yardstick or set the section count on the design before quoting.
                  </p>
                )}
                {/* #255 / #741 defects 3+4: a re-analyze OR a photo delete can drop
                    a staff-created mini group (its member strands weren't
                    re-detected, or lived only on the deleted photo) — unlike
                    routine strand cleanup in the editor, this quietly removes a
                    billed line with nothing else calling it out, so it gets the
                    same standing-warning treatment as the garland-scale notice
                    above. The closing guidance is CAUSE-SPECIFIC (defect 4): a
                    re-analyze miss may genuinely still be drawn on the photo,
                    undetected — true "redraw if still there". A photo-delete
                    prune's strands lived on a photo the server permanently
                    deleted along with them — there is nothing left to "still be
                    there"; that copy would be false. */}
                {prunedMiniGroups && (
                  <p className="text-sm text-amber-700 mb-2">
                    ⚠️ Removed {prunedMiniGroups.groups.length} mini{' '}
                    {prunedMiniGroups.groups.length === 1 ? 'group' : 'groups'} that lost all their strands:{' '}
                    {prunedMiniGroups.groups
                      .map((g, i) => {
                        const label = miniSurfaceLabel(g.surface);
                        const n = g.stringCount;
                        return `${label} — ${n} string${n === 1 ? '' : 's'}${i < prunedMiniGroups.groups.length - 1 ? ', ' : ''}`;
                      })
                      .join('')}
                    .{' '}
                    {prunedMiniGroups.cause === 'reanalyze'
                      ? "Redraw them on the design if they're still there."
                      : 'They lived on the deleted photo, which is gone for good — recreate the group if you still need it.'}
                  </p>
                )}
                {designId ? (
                  <>
                    <DesignEditor
                      key={designEditorKey}
                      designId={designId}
                      height={640}
                      permanentOnly={form.serviceType === 'permanent'}
                      bistroOnly={form.serviceType === 'permanent_bistro'}
                      // Row 367: the design's post-approval freeze rides the
                      // SAME predicate as the money freeze on this page, so the
                      // picture and the price can never be locked on different
                      // rules. Server-enforced too (PUT /api/designs/[id]).
                      locked={postApprovalFrozen}
                      // Row 367 delta-verify MED: the editor mounted unlocked and
                      // the server said otherwise — bring the rest of the page
                      // into line instead of leaving money controls that 409.
                      onDesignLocked={() => setStaleApprovalFrozen(true)}
                      onReady={(flush, discard) => { editorFlushRef.current = flush; editorDiscardRef.current = discard; }}
                      onPrunedMiniGroups={(groups) => reportPrunedMiniGroups('photo-delete', groups)}
                    />
                    {form.serviceType === 'permanent' ? (
                      <p className="text-xs text-gray-400 mt-2">
                        Drawing here is VISUAL (the portal shows these runs lit). Billing footage, corners
                        &amp; extensions come from the Satellite tab&apos;s side lines — auto-traced on address
                        lookup, hand-editable. Saves automatically and attaches to this quote on Calculate.
                      </p>
                    ) : form.serviceType === 'permanent_bistro' ? (
                      <p className="text-xs text-gray-400 mt-2">
                        Drawing here is VISUAL (the portal shows these runs lit). Billing footage comes from
                        the Satellite tab&apos;s bistro runs — draw them there (true-scale, no yardstick
                        needed). Saves automatically and attaches to this quote on Calculate.
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-2">
                        Draw the install on the photo — roofline, minis, wreaths, garland, bows. The design IS the
                        quote&apos;s item list (Custom line items below are the escape hatch for anything it can&apos;t
                        represent). Saves automatically and attaches to this quote on Calculate.
                      </p>
                    )}
                    {/* #88/#117: the "From your design" billable-items summary
                        (minis/spritzers/wreaths/garland/bows) is holiday/event
                        only — permanent bills from the Permanent section and
                        permanent bistro from its own poles section + the Satellite
                        tab's bistro runs, neither of which this preview panel prices
                        (it calls the generic holiday engine, which ignores bistro
                        runs — see permanentBistro/types.ts), so showing it here
                        would misreport a bistro quote as having 0 billable items. */}
                    {(form.serviceType === 'holiday' || form.serviceType === 'event') && (
                      <DesignSummary designId={designId} refreshKey={designEditorKey} />
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-500 py-10 text-center">
                    {designBusy
                      ? 'Setting up the design canvas…'
                      : 'Analyze from address (or upload + analyze a photo) and the design canvas opens here with the house photo.'}
                  </p>
                )}
              </div>

              {/* ── SATELLITE tab — roof measurement lines (the ONLY line-
                  measurement source; no satellite → type footage manually) ── */}
              <div className={viewMode === 'satellite' ? '' : 'hidden'}>
                {satellitePreview ? (
                  <>
                    {/* This warns about the Claude-traced santas/gingerbread roofline
                        lines below — holiday + event only; permanent and permanent
                        bistro don't get an AI-traced roofline to verify. */}
                    {(form.serviceType === 'holiday' || form.serviceType === 'event') && (
                      <div className="mb-3 bg-amber-50 border border-amber-200 rounded-md p-2.5 text-xs text-amber-900">
                        <strong>Verify the roof outline.</strong> Claude often traces the property edge or driveway instead of the actual roof. Drag points or re-draw the lines to hug the real shingle/ridge edges — footage auto-updates from what you draw.
                      </div>
                    )}
                    {/* Zoom/pan controls (#26) */}
                    <div className="flex items-center justify-between mb-1.5 text-[11px] text-gray-500">
                      <span>Scroll to zoom · drag to pan{satZoom.isZoomed ? ` · ${Math.round(satZoom.zoom * 100)}%` : ''}</span>
                      {satZoom.isZoomed && (
                        <button type="button" onClick={satZoom.reset}
                          className="font-medium border border-gray-300 hover:border-gray-500 rounded px-2 py-0.5 bg-white">
                          Reset view
                        </button>
                      )}
                    </div>
                    {/* Outer clip box — owns wheel-zoom + drag-to-pan (#26). */}
                    <div
                      ref={satWrapperRef}
                      {...satZoom.panHandlers}
                      className="relative w-full overflow-hidden rounded-md"
                    >
                    <div
                      ref={imgContainerRef}
                      onClick={addMode ? handleImageClick : undefined}
                      style={satZoom.transformStyle}
                      className={`relative w-full ${addMode ? 'cursor-crosshair' : satZoom.isZoomed ? 'cursor-grab' : ''}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={satellitePreview}
                        alt="Satellite view"
                        className="w-full h-auto rounded-md border border-gray-200 block select-none pointer-events-none"
                        draggable={false}
                        onLoad={e => {
                          const img = e.currentTarget;
                          if (img.naturalHeight > 0) setSatelliteAspect(img.naturalWidth / img.naturalHeight);
                        }}
                      />
                      <svg
                        viewBox="0 0 1 1"
                        preserveAspectRatio="none"
                        className="absolute inset-0 w-full h-full"
                        style={{ pointerEvents: 'none' }}
                      >
                        {activeSantasLines.map((line, i) => (
                          <polyline
                            key={`s-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#ef4444"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {activeGingerbreadLines.map((line, i) => (
                          <polyline
                            key={`g-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#3b82f6"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {activeC9Lines.map((line, i) => (
                          <polyline
                            key={`c9-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#10b981"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {activeStakeLines.map((line, i) => (
                          <polyline
                            key={`stake-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#a855f7"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {form.serviceType === 'permanent' && PERMANENT_SIDES.flatMap((side) =>
                          permanentSatLines[side].map((line, i) => (
                            <polyline
                              key={`perm-${side}-${i}`}
                              points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                              fill="none"
                              stroke={PERMANENT_SIDE_META[side].color}
                              strokeWidth="4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              vectorEffect="non-scaling-stroke"
                            />
                          )),
                        )}
                        {form.serviceType === 'permanent_bistro' && satelliteBistroLines.map((line, i) => (
                          <polyline
                            key={`bistro-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#14b8a6"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {pendingPoints.length > 0 && (
                          <polyline
                            points={pendingPoints.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke={isPermanentSide(addMode ?? '') ? PERMANENT_SIDE_META[addMode as PermanentSideKey].color : addMode === 'bistro' ? '#14b8a6' : addMode === 'santas' ? '#ef4444' : addMode === 'gingerbread' ? '#3b82f6' : addMode === 'stake' ? '#a855f7' : '#10b981'}
                            strokeWidth="3"
                            strokeDasharray="6 4"
                            vectorEffect="non-scaling-stroke"
                          />
                        )}
                      </svg>
                      {/* Draggable point handles (HTML elements, positioned absolute) */}
                      {!addMode && activeSantasLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`sh-${li}-${pi}`}
                          className="absolute w-5 h-5 rounded-full bg-red-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform touch-none"
                          style={{ left: `calc(${x * 100}% - 10px)`, top: `calc(${y * 100}% - 10px)` }}
                          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'santas', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('santas', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {!addMode && activeGingerbreadLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`gh-${li}-${pi}`}
                          className="absolute w-5 h-5 rounded-full bg-blue-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform touch-none"
                          style={{ left: `calc(${x * 100}% - 10px)`, top: `calc(${y * 100}% - 10px)` }}
                          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'gingerbread', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('gingerbread', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {!addMode && activeC9Lines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`c9h-${li}-${pi}`}
                          className="absolute w-5 h-5 rounded-full bg-emerald-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform touch-none"
                          style={{ left: `calc(${x * 100}% - 10px)`, top: `calc(${y * 100}% - 10px)` }}
                          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'c9', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('c9', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {!addMode && activeStakeLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`stakeh-${li}-${pi}`}
                          className="absolute w-5 h-5 rounded-full bg-purple-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform touch-none"
                          style={{ left: `calc(${x * 100}% - 10px)`, top: `calc(${y * 100}% - 10px)` }}
                          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'stake', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('stake', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {!addMode && form.serviceType === 'permanent' && PERMANENT_SIDES.flatMap((side) =>
                        permanentSatLines[side].flatMap((line, li) => line.points.map(([x, y], pi) => (
                          <div
                            key={`perm-h-${side}-${li}-${pi}`}
                            className="absolute w-5 h-5 rounded-full border-2 border-white shadow cursor-move hover:scale-125 transition-transform touch-none"
                            style={{ left: `calc(${x * 100}% - 10px)`, top: `calc(${y * 100}% - 10px)`, backgroundColor: PERMANENT_SIDE_META[side].color }}
                            onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: side, lineIdx: li, ptIdx: pi }); }}
                            onDoubleClick={() => deletePoint(side, li, pi)}
                            title="Drag to move • Double-click to delete"
                          />
                        ))),
                      )}
                      {!addMode && form.serviceType === 'permanent_bistro' && satelliteBistroLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`bistro-h-${li}-${pi}`}
                          className="absolute w-5 h-5 rounded-full border-2 border-white shadow cursor-move hover:scale-125 transition-transform touch-none"
                          style={{ left: `calc(${x * 100}% - 10px)`, top: `calc(${y * 100}% - 10px)`, backgroundColor: '#14b8a6' }}
                          onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'bistro', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('bistro', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {pendingPoints.map(([x, y], i) => (
                        <div
                          key={`pp-${i}`}
                          className="absolute w-3 h-3 rounded-full border-2 border-white shadow"
                          style={{ left: `calc(${x * 100}% - 6px)`, top: `calc(${y * 100}% - 6px)`, backgroundColor: isPermanentSide(addMode ?? '') ? PERMANENT_SIDE_META[addMode as PermanentSideKey].color : addMode === 'bistro' ? '#14b8a6' : addMode === 'santas' ? '#ef4444' : addMode === 'gingerbread' ? '#3b82f6' : addMode === 'stake' ? '#a855f7' : '#10b981' }}
                        />
                      ))}
                    </div>
                    </div>

                    {/* #88 / S23: permanent measures its four sides HERE — draw each
                        side's roofline on the satellite and it feeds that side's
                        footage (× Google's scale) + corners (vertex count) into the
                        Permanent section, and persists to the design for the portal. */}
                    {form.serviceType === 'permanent' ? (
                      <>
                        <p className="mt-3 text-sm text-gray-500">
                          Draw each roofline on the satellite view by side. Footage &amp; corners fill in
                          automatically below.
                          {satelliteFeetPerPixel == null && (
                            <span className="text-amber-600">
                              {' '}No satellite scale on this photo — corners still count, but type each
                              side&apos;s footage by hand.
                            </span>
                          )}
                        </p>
                        {addMode ? (
                          <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-md p-3 flex items-center justify-between">
                            <span className="text-sm text-yellow-900">
                              Adding new {isPermanentSide(addMode) ? PERMANENT_SIDE_META[addMode].label : ''} roofline
                              — click on the photo to add points ({pendingPoints.length} placed).
                            </span>
                            <div className="flex gap-2">
                              <button type="button" onClick={finishAddingLine} disabled={pendingPoints.length < 2}
                                className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-xs font-medium px-3 py-1.5 rounded">
                                Done
                              </button>
                              <button type="button" onClick={cancelAdd}
                                className="bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium px-3 py-1.5 rounded">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {PERMANENT_SIDES.map((side) => (
                              <button key={side} type="button"
                                onClick={() => { setAddMode(side); setPendingPoints([]); }}
                                className="text-xs font-medium border rounded px-3 py-1.5 hover:opacity-70"
                                style={{ color: PERMANENT_SIDE_META[side].color, borderColor: PERMANENT_SIDE_META[side].color }}>
                                + Add {PERMANENT_SIDE_META[side].label}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {PERMANENT_SIDES.map((side) => {
                            const lines = permanentSatLines[side];
                            const m = deriveSideMeasure(lines, satelliteFeetPerPixel, satelliteAspect);
                            return (
                              <div key={side}>
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="w-4 h-1 rounded" style={{ backgroundColor: PERMANENT_SIDE_META[side].color }}></span>
                                  <span className="text-sm font-semibold text-gray-800">
                                    {PERMANENT_SIDE_META[side].label} — {m.footage != null ? `${m.footage}ft` : '—'} · {m.corners} corner{m.corners === 1 ? '' : 's'}
                                  </span>
                                </div>
                                {lines.length > 0 ? (
                                  <ul className="space-y-1 ml-6">
                                    {lines.map((line, i) => (
                                      <li key={`${side}-${i}`} className="flex items-center gap-2 text-xs">
                                        <span className="flex-1 text-gray-500">Run {i + 1} — {line.points.length} pts</span>
                                        <button type="button" onClick={() => deleteLine(side, i)}
                                          className="text-red-400 hover:text-red-600 font-bold">×</button>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="text-xs text-gray-400 ml-6">No runs drawn</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : form.serviceType === 'permanent_bistro' ? (
                      // #117: bistro measures HERE, on the satellite view — each
                      // freeform run's true-scale footage (no yardstick) is the
                      // BILLING source (form.permanentBistro.bistro). The Design
                      // tab's bistro strand stays visual-only for the portal.
                      <>
                        <p className="mt-3 text-sm text-gray-500">
                          Draw each bistro light run on the satellite view. Footage fills in automatically
                          below — this is the billing source.
                          {satelliteFeetPerPixel == null && (
                            <span className="text-amber-600">
                              {' '}No satellite scale on this photo — type the footage manually once a
                              scaled address lookup restores it.
                            </span>
                          )}
                        </p>
                        {addMode === 'bistro' ? (
                          <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-md p-3 flex items-center justify-between">
                            <span className="text-sm text-yellow-900">
                              Adding new Bistro Run — click on the photo to add points ({pendingPoints.length} placed).
                            </span>
                            <div className="flex gap-2">
                              <button type="button" onClick={finishAddingLine} disabled={pendingPoints.length < 2}
                                className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-xs font-medium px-3 py-1.5 rounded">
                                Done
                              </button>
                              <button type="button" onClick={cancelAdd}
                                className="bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium px-3 py-1.5 rounded">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button type="button" onClick={() => { setAddMode('bistro'); setPendingPoints([]); }}
                              className="text-xs font-medium border rounded px-3 py-1.5 hover:opacity-70"
                              style={{ color: '#14b8a6', borderColor: '#14b8a6' }}>
                              + Add Bistro Run
                            </button>
                          </div>
                        )}
                        <div className="mt-4">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="w-4 h-1 rounded" style={{ backgroundColor: '#14b8a6' }}></span>
                            <span className="text-sm font-semibold text-gray-800">
                              Bistro Runs — {satelliteBistroLines.reduce(
                                (sum, line) => sum + (billedBistroFootage(line) ?? 0),
                                0,
                              )}ft total
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 ml-6 mb-2">
                            Auto-measured from photo. Adjust if needed.
                          </p>
                          {satelliteBistroLines.length > 0 ? (
                            <ul className="space-y-1 ml-6">
                              {satelliteBistroLines.map((line, i) => {
                                const ft = billedBistroFootage(line);
                                return (
                                  <li key={line.id ?? `bistro-${i}`} className="flex items-center gap-2 text-xs">
                                    <span className="text-gray-500 whitespace-nowrap">
                                      Run {i + 1} ({line.points.length} pts)
                                    </span>
                                    {line.id ? (
                                      <>
                                        <input
                                          className="w-20 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:bg-gray-100 disabled:text-gray-400"
                                          type="number" min="0" placeholder="0"
                                          value={ft || ''}
                                          disabled={postApprovalFrozen}
                                          title={postApprovalFrozen ? POST_APPROVAL_LOCK_REASON : undefined}
                                          onChange={(e) => updateBistroRunFootage(line.id, Math.max(0, Number(e.target.value) || 0))}
                                          onBlur={() => {
                                            // #244 premerge finding 1 (HIGH, money — #139 parity):
                                            // round a hand-typed override up to the next 5ft step on
                                            // blur, same as PermanentSection's roundFootageOnBlur —
                                            // calculatePermanentBistro never re-rounds, so an
                                            // un-rounded override silently under-bills.
                                            const rounded = roundBistroFootageOnBlur(ft);
                                            if (rounded != null) updateBistroRunFootage(line.id, rounded);
                                          }}
                                        />
                                        <span className="text-gray-400">ft</span>
                                      </>
                                    ) : (
                                      <span className="flex-1 text-gray-500">{ft != null ? `${ft} ft` : 'no scale'}</span>
                                    )}
                                    <button type="button" onClick={() => deleteLine('bistro', i)}
                                      className="ml-auto text-red-400 hover:text-red-600 font-bold">×</button>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : (
                            <p className="text-xs text-gray-400 ml-6">No runs drawn</p>
                          )}
                        </div>
                      </>
                    ) : (
                    <>
                    {/* Add-line controls */}
                    {addMode ? (
                      <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-md p-3 flex items-center justify-between">
                        <span className="text-sm text-yellow-900">
                          Adding new {addMode === 'santas' ? 'front gutterline (red)' : addMode === 'gingerbread' ? 'ridge / side line (blue)' : addMode === 'stake' ? 'stake run (purple)' : 'C9 run (green)'} — click on the photo to add points ({pendingPoints.length} placed).
                        </span>
                        <div className="flex gap-2">
                          <button type="button" onClick={finishAddingLine} disabled={pendingPoints.length < 2}
                            className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-xs font-medium px-3 py-1.5 rounded">
                            Done
                          </button>
                          <button type="button" onClick={cancelAdd}
                            className="bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium px-3 py-1.5 rounded">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => { setAddMode('santas'); setPendingPoints([]); }}
                          className="text-xs font-medium text-red-700 border border-red-300 hover:border-red-500 rounded px-3 py-1.5">
                          + Add Front Gutterline
                        </button>
                        <button type="button" onClick={() => { setAddMode('gingerbread'); setPendingPoints([]); }}
                          className="text-xs font-medium text-blue-700 border border-blue-300 hover:border-blue-500 rounded px-3 py-1.5">
                          + Add Ridge / Side
                        </button>
                        {/* C9 Custom Runs + Stake are holiday-only — the event/permanent
                            engines don't price winterWonderland/stakeLighting (finding #1). */}
                        {form.serviceType === 'holiday' && (
                          <>
                            <button type="button" onClick={() => { setAddMode('c9'); setPendingPoints([]); }}
                              className="text-xs font-medium text-emerald-700 border border-emerald-300 hover:border-emerald-500 rounded px-3 py-1.5">
                              + Add C9 Run
                            </button>
                            <button type="button" onClick={() => { setAddMode('stake'); setPendingPoints([]); }}
                              className="text-xs font-medium text-purple-700 border border-purple-300 hover:border-purple-500 rounded px-3 py-1.5">
                              + Add Stake Run
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {/* Per-line edit panels — front gutterline / ridge+sides / C9s / Stake. */}
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-4 h-1 bg-red-500 rounded"></span>
                          <span className="text-sm font-semibold text-gray-800">Front Gutterline — {form.santasFootage}ft</span>
                          {activeSantasLines.length >= 2 && (
                            <button type="button" onClick={() => clearAllLines('santas')}
                              className="ml-auto text-[11px] font-medium text-gray-500 hover:text-red-600 border border-gray-300 hover:border-red-400 rounded px-2 py-0.5">
                              Clear all
                            </button>
                          )}
                        </div>
                        {activeSantasLines.length > 0 ? (
                          <ul className="space-y-1 ml-6">
                            {activeSantasLines.map((line, i) => (
                              <li key={`sl-${i}`} className="flex items-center gap-2 text-xs">
                                <input
                                  value={line.label}
                                  onChange={e => updateLineLabel('santas', i, e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                                />
                                <span className="text-gray-400">{line.points.length}pts</span>
                                <button type="button" onClick={() => deleteLine('santas', i)}
                                  className="text-red-400 hover:text-red-600 font-bold">×</button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-gray-400 ml-6">No segments</p>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-4 h-1 bg-blue-500 rounded"></span>
                          <span className="text-sm font-semibold text-gray-800">Ridge + Sides — {form.gingerbreadFootage}ft</span>
                          {activeGingerbreadLines.length >= 2 && (
                            <button type="button" onClick={() => clearAllLines('gingerbread')}
                              className="ml-auto text-[11px] font-medium text-gray-500 hover:text-red-600 border border-gray-300 hover:border-red-400 rounded px-2 py-0.5">
                              Clear all
                            </button>
                          )}
                        </div>
                        {activeGingerbreadLines.length > 0 ? (
                          <ul className="space-y-1 ml-6">
                            {activeGingerbreadLines.map((line, i) => (
                              <li key={`gl-${i}`} className="flex items-center gap-2 text-xs">
                                <input
                                  value={line.label}
                                  onChange={e => updateLineLabel('gingerbread', i, e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                                />
                                <span className="text-gray-400">{line.points.length}pts</span>
                                <button type="button" onClick={() => deleteLine('gingerbread', i)}
                                  className="text-red-400 hover:text-red-600 font-bold">×</button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-gray-400 ml-6">No segments</p>
                        )}
                      </div>
                      {/* C9 Custom Runs + Stake summary/edit panels — holiday-only; the
                          event/permanent engines don't price these fields (finding #1). */}
                      {form.serviceType === 'holiday' && (<>
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-4 h-1 bg-emerald-500 rounded"></span>
                          <span className="text-sm font-semibold text-gray-800">C9s — {form.winterWonderlandFootage}ft</span>
                        </div>
                        {activeC9Lines.length > 0 ? (
                          <ul className="space-y-1 ml-6">
                            {activeC9Lines.map((line, i) => (
                              <li key={`c9l-${i}`} className="flex items-center gap-2 text-xs">
                                <input
                                  value={line.label}
                                  onChange={e => updateLineLabel('c9', i, e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                                />
                                <span className="text-gray-400">{line.points.length}pts</span>
                                <button type="button" onClick={() => deleteLine('c9', i)}
                                  className="text-red-400 hover:text-red-600 font-bold">×</button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="ml-6">
                            <p className="text-xs text-gray-400 mb-2">No segments — draw on photo, or enter manually:</p>
                            <div className="flex items-center gap-2">
                              <input className="border border-gray-200 rounded px-2 py-1 text-xs w-20" type="number" min="0" placeholder="0"
                                value={form.winterWonderlandFootage || ''}
                                onChange={e => set('winterWonderlandFootage', Number(e.target.value))} />
                              <span className="text-xs text-gray-500">ft</span>
                              <select className="border border-gray-200 rounded px-2 py-1 text-xs bg-white" value={form.winterWonderlandDifficulty}
                                onChange={e => setDifficulty('winterWonderlandDifficulty', 'winterWonderlandCustomRate', BUSINESS_RULES.rooflineRates, e.target.value as DifficultyChoice)}>
                                <option value="easy">Easy</option>
                                <option value="medium">Medium</option>
                                <option value="hard">Hard</option>
                                <option value="custom">Custom…</option>
                              </select>
                              {form.winterWonderlandDifficulty === 'custom' && (
                                <>
                                  <input className="border border-gray-200 rounded px-2 py-1 text-xs w-16" type="number" min="0" step="0.5" placeholder="0"
                                    value={form.winterWonderlandCustomRate || ''}
                                    onChange={e => set('winterWonderlandCustomRate', Number(e.target.value))} />
                                  <span className="text-xs text-gray-500">$/ft</span>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-4 h-1 bg-purple-500 rounded"></span>
                          <span className="text-sm font-semibold text-gray-800">Stake Lighting — {form.stakeLightingFootage}ft</span>
                        </div>
                        {activeStakeLines.length > 0 ? (
                          <ul className="space-y-1 ml-6">
                            {activeStakeLines.map((line, i) => (
                              <li key={`stakel-${i}`} className="flex items-center gap-2 text-xs">
                                <input
                                  value={line.label}
                                  onChange={e => updateLineLabel('stake', i, e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                                />
                                <span className="text-gray-400">{line.points.length}pts</span>
                                <button type="button" onClick={() => deleteLine('stake', i)}
                                  className="text-red-400 hover:text-red-600 font-bold">×</button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="ml-6">
                            <p className="text-xs text-gray-400 mb-2">No segments — draw on photo, or enter manually:</p>
                            <div className="flex items-center gap-2">
                              <input className="border border-gray-200 rounded px-2 py-1 text-xs w-20" type="number" min="0" placeholder="0"
                                value={form.stakeLightingFootage || ''}
                                onChange={e => set('stakeLightingFootage', Number(e.target.value))} />
                              <span className="text-xs text-gray-500">ft</span>
                              <select className="border border-gray-200 rounded px-2 py-1 text-xs bg-white" value={form.stakeLightingDifficulty}
                                onChange={e => setDifficulty('stakeLightingDifficulty', 'stakeLightingCustomRate', BUSINESS_RULES.stakeLightingRates, e.target.value as DifficultyChoice)}>
                                <option value="easy">Easy</option>
                                <option value="medium">Medium</option>
                                <option value="hard">Hard</option>
                                <option value="custom">Custom…</option>
                              </select>
                              {form.stakeLightingDifficulty === 'custom' && (
                                <>
                                  <input className="border border-gray-200 rounded px-2 py-1 text-xs w-16" type="number" min="0" step="0.5" placeholder="0"
                                    value={form.stakeLightingCustomRate || ''}
                                    onChange={e => set('stakeLightingCustomRate', Number(e.target.value))} />
                                  <span className="text-xs text-gray-500">$/ft</span>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      </>)}
                    </div>
                    </>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-500 py-10 text-center">
                    No satellite view (manual photo upload) — enter the roof measurements in the sections below.
                  </p>
                )}
              </div>
            </Section>
            </div>
          ) : null}

          {/* Permanent Lighting (#88): its own footage/corners/gaps/track section,
              replacing the holiday item sections. Holiday item sections are hidden
              for permanent so the operator can't enter Christmas footage on it. */}
          {form.serviceType === 'permanent' && (
            <PermanentSection
              form={form}
              setForm={setForm}
              onRecount={() => {
                // #142: Recount = explicit re-derive. Row 345 finding 2: this
                // button only intends to hand the ACCESSORIES count back to
                // auto (see recountAccessories in PermanentSection.tsx), but
                // permDeriveFrozenRef is shared with the footage/corners
                // derive above — clearing it directly here used to leave
                // that derive's baseline permanently empty (seeded only from
                // the isPermanentSide getSetter, which requires frozen ===
                // true, so it could never fire again after this ran). Route
                // through the shared helper so an unrelated Recount click
                // can't clobber every side's footage/corners override on the
                // operator's NEXT line edit.
                thawPermDerive();
              }}
              // PS-B1: a billed side (footage > 0) with no drawn satellite trace
              // never shows on the portal's roof map — surface that mismatch
              // inline so the operator draws it or knowingly proceeds.
              tracedSides={{
                front: permanentSatLines.front.length > 0,
                left: permanentSatLines.left.length > 0,
                right: permanentSatLines.right.length > 0,
                back: permanentSatLines.back.length > 0,
              }}
              tracedReady={permTraceHydrated}
            />
          )}

          {/* Santa's/Gingerbread (+ holiday-only C9/Stake below) price only on the
              holiday and event engines (event's roofline allow-list is santas +
              gingerbread only). Positive list, not "!== permanent": permanent
              bistro's engine prices none of this, and a new future type should
              default to hidden too, not inherit it. */}
          {(form.serviceType === 'holiday' || form.serviceType === 'event') && (
          <>
          {/* ── Santa's — Front Gutterline ── */}
          <div className={`transition-opacity ${form.santasFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Santa's — Front Gutterline (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">
                Footage is auto-measured from the photo — adjust if needed. <strong>Difficulty is not:</strong>{' '}
                it stays where you left it (new quotes start at Easy $8/ft) and only changes when you pick a
                different value here. Bump it for a genuinely hard roof.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.santasFootage || ''}
                    onChange={e => set('santasFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.santasDifficulty}
                    onChange={e => setDifficulty('santasDifficulty', 'santasCustomRate', BUSINESS_RULES.rooflineRates, e.target.value as DifficultyChoice)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                    <option value="custom">Custom…</option>
                  </select>
                  {form.santasDifficulty === 'custom' && (
                    <div className="mt-2 flex items-center gap-1">
                      <span className="text-sm text-gray-500">$</span>
                      <input className={inp} type="number" min="0" step="0.5" placeholder="0"
                        value={form.santasCustomRate || ''}
                        onChange={e => set('santasCustomRate', Number(e.target.value))} />
                      <span className="text-sm text-gray-500 whitespace-nowrap">/ft</span>
                    </div>
                  )}
                </div>
              </div>
              {form.santasFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── Gingerbread — Ridge + Sides ── */}
          <div className={`transition-opacity ${form.gingerbreadFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Gingerbread — Ridge + Sides (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">
                Footage is auto-measured from the photo — adjust if needed. <strong>Difficulty is not:</strong>{' '}
                it stays where you left it (new quotes start at Easy $8/ft) and only changes when you pick a
                different value here. Bump it for a genuinely hard roof.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.gingerbreadFootage || ''}
                    onChange={e => set('gingerbreadFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.gingerbreadDifficulty}
                    onChange={e => setDifficulty('gingerbreadDifficulty', 'gingerbreadCustomRate', BUSINESS_RULES.rooflineRates, e.target.value as DifficultyChoice)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                    <option value="custom">Custom…</option>
                  </select>
                  {form.gingerbreadDifficulty === 'custom' && (
                    <div className="mt-2 flex items-center gap-1">
                      <span className="text-sm text-gray-500">$</span>
                      <input className={inp} type="number" min="0" step="0.5" placeholder="0"
                        value={form.gingerbreadCustomRate || ''}
                        onChange={e => set('gingerbreadCustomRate', Number(e.target.value))} />
                      <span className="text-sm text-gray-500 whitespace-nowrap">/ft</span>
                    </div>
                  )}
                </div>
              </div>
              {form.gingerbreadFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── C9s — Custom Runs + Stake Lighting: holiday-only. The event pricing
              engine (calculateEventQuote/eventRooflineOptions) is an allow-list that
              prices ONLY santasFootage + gingerbreadFootage — winterWonderlandFootage
              and stakeLightingFootage have no event rate table, so showing these on
              an event quote let staff fill them in and never bill for them (silent
              under-bill). Gate to holiday only; permanent already excludes this whole
              fragment above. */}
          {form.serviceType === 'holiday' && (
          <>
          {/* ── C9s — Custom Runs ── */}
          <div className={`transition-opacity ${form.winterWonderlandFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="C9s — Custom Runs">
              <p className="text-xs text-gray-400 mb-3">Enter manually — C9 bulb runs.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.winterWonderlandFootage || ''}
                    onChange={e => set('winterWonderlandFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.winterWonderlandDifficulty}
                    onChange={e => setDifficulty('winterWonderlandDifficulty', 'winterWonderlandCustomRate', BUSINESS_RULES.rooflineRates, e.target.value as DifficultyChoice)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                    <option value="custom">Custom…</option>
                  </select>
                  {form.winterWonderlandDifficulty === 'custom' && (
                    <div className="mt-2 flex items-center gap-1">
                      <span className="text-sm text-gray-500">$</span>
                      <input className={inp} type="number" min="0" step="0.5" placeholder="0"
                        value={form.winterWonderlandCustomRate || ''}
                        onChange={e => set('winterWonderlandCustomRate', Number(e.target.value))} />
                      <span className="text-sm text-gray-500 whitespace-nowrap">/ft</span>
                    </div>
                  )}
                </div>
              </div>
              {form.winterWonderlandFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── Stake Lighting ── independent staked ground runs (own $6/$7/$8 rates) */}
          <div className={`transition-opacity ${form.stakeLightingFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Stake Lighting">
              <p className="text-xs text-gray-400 mb-3">Enter manually — staked ground runs.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.stakeLightingFootage || ''}
                    onChange={e => set('stakeLightingFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.stakeLightingDifficulty}
                    onChange={e => setDifficulty('stakeLightingDifficulty', 'stakeLightingCustomRate', BUSINESS_RULES.stakeLightingRates, e.target.value as DifficultyChoice)}>
                    <option value="easy">Easy — $6/ft</option>
                    <option value="medium">Medium — $7/ft</option>
                    <option value="hard">Hard — $8/ft</option>
                    <option value="custom">Custom…</option>
                  </select>
                  {form.stakeLightingDifficulty === 'custom' && (
                    <div className="mt-2 flex items-center gap-1">
                      <span className="text-sm text-gray-500">$</span>
                      <input className={inp} type="number" min="0" step="0.5" placeholder="0"
                        value={form.stakeLightingCustomRate || ''}
                        onChange={e => set('stakeLightingCustomRate', Number(e.target.value))} />
                      <span className="text-sm text-gray-500 whitespace-nowrap">/ft</span>
                    </div>
                  )}
                </div>
              </div>
              {form.stakeLightingFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>
          </>
          )}
          </>
          )}

          {form.serviceType === 'event' && (
            <Section title="Freestanding pole & base supports">
              <input
                type="number"
                min={0}
                step="1"
                className="border border-gray-300 rounded px-2 py-1 text-sm w-24 text-right"
                value={form.event.barrelBoxes || ''}
                onChange={ev => setForm(f => ({ ...f, event: { ...f.event, barrelBoxes: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } }))}
              />
              <span className="ml-2 text-xs text-gray-400">$ each (rate in Settings)</span>
            </Section>
          )}

          {/* Permanent Bistro Lighting (#117) — poles/supports, the one form
              input bistro carries (footage comes from the Satellite tab's
              drawn runs, written straight onto form.permanentBistro.bistro). */}
          {form.serviceType === 'permanent_bistro' && (
            <Section title="Permanent poles & supports">
              <input
                type="number"
                min={0}
                step="1"
                className="border border-gray-300 rounded px-2 py-1 text-sm w-24 text-right"
                value={form.permanentBistro.poles || ''}
                onChange={ev => setForm(f => ({ ...f, permanentBistro: { ...f.permanentBistro, poles: Math.max(0, Math.floor(Number(ev.target.value) || 0)) } }))}
              />
              <span className="ml-2 text-xs text-gray-400">$ each (rate in Settings)</span>
            </Section>
          )}

          {/* ── Custom / manual line items (#27 escape hatch) ── */}
          <Section title="Custom / manual line items">
            <p className="text-xs text-gray-400 mb-3">
              For anything the design can&apos;t represent — staff-named items billed at the price you set.
              They appear on the quote and the customer portal (not tied to the design).
            </p>
            {form.customLineItems.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_96px_64px_28px] gap-2 mb-1">
                  <span className={lbl}>Name</span>
                  <span className={lbl}>Unit $</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.customLineItems.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_96px_64px_28px] gap-2 mb-2 items-start">
                    <input className={inp} type="text" placeholder="e.g. Custom monogram display"
                      value={item.label}
                      onChange={e => updateCustomLineItem(i, { label: e.target.value })} />
                    <input className={inp} type="number" min="0" step="0.01"
                      value={item.amount || ''}
                      onChange={e => updateCustomLineItem(i, { amount: Number(e.target.value) })} />
                    <input className={inp} type="number" min="1" step="1"
                      value={item.quantity ?? 1}
                      onChange={e => updateCustomLineItem(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeCustomLineItem(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addCustomLineItem} className={addBtn}>
              + Add custom line item
            </button>
          </Section>

          {/* ── Options ── holiday-only (takedown / rush / early-install / the
              $1,000-minimum waiver). Permanent, event, and permanent bistro all
              force these off in pricing (permanent uses its own $2,500 gate,
              event carries no seasonal fees, bistro uses its own Settings-editable
              minimum), so the whole section is hidden for all three — event has
              its own dates in EventSection. Positive list (holiday only), not a
              negative one, so a future type defaults to hidden too. Per-quote
              discount for permanent/bistro is a fast-follow (custom $/ft + custom
              line items cover v1 price flexibility). */}
          {form.serviceType === 'holiday' && (
          <Section title="Options">

            {/* Takedown */}
            <div className="mb-5">
              <p className={lbl}>Takedown</p>
              <div className="flex gap-8 mt-1.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="takedown" value="included"
                    checked={form.takedown === 'included'} onChange={() => set('takedown', 'included')} />
                  Included — Jan 9 – Feb 3
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="takedown" value="premium"
                    checked={form.takedown === 'premium'} onChange={() => set('takedown', 'premium')} />
                  Premium (+$150) — before Jan 9
                </label>
              </div>
            </div>

            {/* Rush fee */}
            <div className="mb-5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={form.rushFee}
                  onChange={e => {
                    set('rushFee', e.target.checked);
                    // Rush + early-install are mutually exclusive (#40).
                    if (e.target.checked) set('installTiming', 'none');
                  }} />
                Rush fee — add $150
              </label>
            </div>

            {/* Discount — a manual %/flat discount OR an early-install promo (#40),
                all under one "Apply discount" toggle. Pick Percentage / Flat dollar
                (enter an amount) or a Sep/Oct early-install month (fixed 15% / 10%).
                Early-install is mutually exclusive with the rush fee, drives the
                engine discount, and seeds the customer's portal install-timing.
                Referral program (#41 adversarial-review MED fix): once a referral
                credit occupies the slot, these controls LOCK — staff can't quietly
                drift the discount away from a credit that's already been
                consumed server-side. Remove lives on the credit banner above
                (the one place that already owns the consume/unconsume calls). */}
            <div>
              {form.referralCredit ? (
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  Discount locked. A referral credit is applied. Use Remove on the referral banner above to edit it manually.
                </p>
              ) : (
                <>
                  <label className="flex items-center gap-2 text-sm cursor-pointer mb-3">
                    <input type="checkbox" checked={form.discountEnabled}
                      onChange={e => {
                        set('discountEnabled', e.target.checked);
                        // Closing the discount section clears any early-install promo too.
                        if (!e.target.checked) set('installTiming', 'none');
                      }} />
                    Apply discount
                  </label>
                  {form.discountEnabled && (
                    <div className="pl-6 space-y-3">
                      <div className="flex flex-wrap items-center gap-5">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="radio" name="discountKind"
                            checked={form.installTiming === 'none' && form.discountType === 'percentage'}
                            onChange={() => { set('installTiming', 'none'); set('discountType', 'percentage'); }} />
                          Percentage
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="radio" name="discountKind"
                            checked={form.installTiming === 'none' && form.discountType === 'flat'}
                            onChange={() => { set('installTiming', 'none'); set('discountType', 'flat'); }} />
                          Flat dollar
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="radio" name="discountKind"
                            checked={form.installTiming === 'september'}
                            onChange={() => { set('installTiming', 'september'); set('rushFee', false); }} />
                          September — 15% off
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="radio" name="discountKind"
                            checked={form.installTiming === 'october'}
                            onChange={() => { set('installTiming', 'october'); set('rushFee', false); }} />
                          October — 10% off
                        </label>
                      </div>
                      {form.installTiming === 'none' ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number" min="0"
                            max={form.discountType === 'percentage' ? '100' : undefined}
                            step="0.01"
                            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-green-500"
                            value={form.discountAmount || ''}
                            placeholder={form.discountType === 'percentage' ? '20' : '100'}
                            onChange={e => set('discountAmount', Number(e.target.value))}
                          />
                          <span className="text-xs text-gray-400">
                            {form.discountType === 'percentage' ? 'e.g. 20 = 20% off' : 'e.g. 100 = $100 off'}
                          </span>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400">
                          Pre-selects {form.installTiming === 'september' ? 'September' : 'October'} on the customer&apos;s portal; mutually exclusive with the rush fee.
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Waive the $1,000 minimum (#59) — staff override so the customer can
                approve a selection under $1,000 on the portal. Lives with the other
                quote-wide options (takedown / rush / discount). */}
            <div className="mt-5">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.waiveMinimum}
                  onChange={e => set('waiveMinimum', e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-sm font-medium text-gray-700">Waive the $1,000 minimum</span>
                  <span className="block text-xs text-gray-500">
                    Lets the customer approve a selection under $1,000 on the portal — even if this quote&apos;s items total more.
                  </span>
                </span>
              </label>
            </div>
          </Section>
          )}

          {/* Discount — event / permanent / permanent bistro (#212). The SAME
              manual %/flat "Apply discount" control + referral-credit lock as
              holiday's Options section above, MINUS the September/October
              early-install promo: that's a holiday-seasonal off-peak-install
              incentive, not a general discount, and none of these three
              verticals' engines even read installTiming (event/permanentBistro
              hardcode earlyInstallDiscountAmount 0; permanent forces
              installTiming:'none' into the shared tail) — see
              lib/event/pricing.ts, lib/permanent/pricing.ts,
              lib/permanentBistro/pricing.ts. Positive list of the three types
              (not `!== 'holiday'`), matching the Options-section gate above, so
              a future 5th vertical defaults to no discount UI until explicitly
              added. Takedown/rush/waive-minimum stay holiday-only — untouched. */}
          {(form.serviceType === 'event' ||
            form.serviceType === 'permanent' ||
            form.serviceType === 'permanent_bistro') && (
          <Section title="Discount">
            {form.referralCredit ? (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Discount locked. A referral credit is applied. Use Remove on the referral banner above to edit it manually.
              </p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm cursor-pointer mb-3">
                  <input type="checkbox" checked={form.discountEnabled}
                    onChange={e => set('discountEnabled', e.target.checked)} />
                  Apply discount
                </label>
                {form.discountEnabled && (
                  <div className="pl-6 space-y-3">
                    <div className="flex flex-wrap items-center gap-5">
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="radio" name="discountKind"
                          checked={form.discountType === 'percentage'}
                          onChange={() => set('discountType', 'percentage')} />
                        Percentage
                      </label>
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="radio" name="discountKind"
                          checked={form.discountType === 'flat'}
                          onChange={() => set('discountType', 'flat')} />
                        Flat dollar
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number" min="0"
                        max={form.discountType === 'percentage' ? '100' : undefined}
                        step="0.01"
                        className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-green-500"
                        value={form.discountAmount || ''}
                        placeholder={form.discountType === 'percentage' ? '20' : '100'}
                        onChange={e => set('discountAmount', Number(e.target.value))}
                      />
                      <span className="text-xs text-gray-400">
                        {form.discountType === 'percentage' ? 'e.g. 20 = 20% off' : 'e.g. 100 = $100 off'}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </Section>
          )}

          {/* Deposit % override (#177) — staff can set a per-quote deposit
              percent (integer 1-100); blank defaults to 50% (today's behavior).
              Rides inputs.depositPercent, like waiveMinimum above. Reachability
              fix: ALWAYS rendered (not holiday-only, unlike the rest of Options
              above) — event/permanent/permanent_bistro pricing all honor
              depositPercent too (effectiveDepositRate), so every service type
              needs a way to reach it. Locked post-approval (#177 fix 3a): the
              server 409s a changed depositPercent on an approved/booked quote,
              so the input disables here too rather than surfacing a dead-end error. */}
          <Section title="Deposit %">
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium text-gray-700">Deposit %</span>
              <input
                type="number" min="1" max="100" step="1"
                className="border border-gray-300 rounded-md px-3 py-2 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:bg-gray-100 disabled:text-gray-400"
                value={form.depositPercent || ''}
                placeholder="50"
                disabled={savedStatus === 'approved' || savedStatus === 'booked'}
                title={
                  savedStatus === 'approved' || savedStatus === 'booked'
                    ? 'Locked after approval — amend handles changes'
                    : undefined
                }
                onChange={e => {
                  // #199 (wrap-review F4): a DIRECT staff edit — to ANY value,
                  // including coincidentally 40 — is never "the NCE rule's"
                  // value again. Without this, hand-typing 40 right after
                  // turning the chip off (or independently of it entirely)
                  // would still get silently wiped by a LATER OFF-toggle that
                  // still thought it owned this field.
                  nceDepositSetByRuleRef.current = false;
                  // Row 328(a): typing here IS the deliberate act the notice
                  // asks for, so it stops standing.
                  setNceDepositHeldBack(null);
                  set('depositPercent', Number(e.target.value));
                }}
              />
            </label>
            <span className="block text-xs text-gray-500 mt-1">
              Blank defaults to 50%. Overrides the deposit due at approval for this quote only.
            </span>
            {/* Row 328(a): a deposit that silently did NOT change is as
                surprising as one that did, so the held-back case says so
                where the number is, and names the deliberate way to do it. */}
            {nceDepositHeldBack !== null && (
              <p role="status" className="mt-2 text-sm text-amber-700">
                ⚠️ This contact {nceDepositHeldBack ? 'is tagged NCE' : 'is not tagged NCE'}, so the NCE chip
                changed — but the deposit was left at {form.depositPercent || 50}% because this quote has already
                left draft. Change it here yourself if the customer agreed to a different deposit.
              </p>
            )}
          </Section>

          {/* Row 406: the unsaved-changes indicator. Sits directly above
              Calculate because Calculate IS the save — the operator needs to
              see "not saved yet" at the moment they are deciding whether they
              are done. Amber, not red: nothing is broken, there is simply work
              on screen that the database does not have.

              A premerge staff-lens HIGH noted that parked inline near the
              bottom of a ~7900-line form this is easy to never see, and that it
              is the ONLY guard on in-app navigation (next/link transitions
              never fire beforeunload). A sticky variant was tried and REVERTED:
              the delta-verify pass argued its containing block is the whole
              component, which would pin it over the Send Quote button for the
              entire rest of the scroll, and that could not be settled
              statically or confirmed in a browser (the dev server is behind the
              operator auth gate). Shipping an unverifiable overlay across a
              money surface is the worse trade, so the visibility gap is
              recorded on the follow-up row instead of papered over here. */}
          {hasUnsavedEdits && (
            <div
              className="mb-2 rounded-lg border px-3 py-2 text-sm flex items-start gap-2"
              style={{ borderColor: '#f59e0b', backgroundColor: '#fffbeb', color: '#92400e' }}
              role="status"
            >
              <span aria-hidden="true">●</span>
              <span>
                <strong>Unsaved changes.</strong> Your edits are not in the quote yet — click
                Calculate Quote to save them. Leaving or reloading this page first will lose them.
              </span>
            </div>
          )}

          {/* Calculate */}
          <button
            type="button"
            onClick={() => void runQuote()}
            disabled={loading}
            className="w-full bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors mb-6 text-base"
          >
            {loading ? 'Calculating…' : 'Calculate Quote'}
          </button>

        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* ── Result ── */}
        {result && (
          <div ref={resultRef} className="bg-white border border-gray-200 rounded-lg p-6 mb-10">
            {/* Totals — moved to the top (#107). The headline shows the "Full Yule"
                ceiling (all items + the most-expensive roofline) via result.fullYule;
                the billed figures + the recommended-subtotal gate below stay on the
                SELECTED roofline. Falls back to the selected figures on pre-#107 quotes. */}
            {(() => {
              const h = result.fullYule ?? result;
              return (
                <>
                  {/* Subtotals */}
                  <div className="space-y-1.5 text-sm text-gray-600">
                    <div className="flex justify-between">
                      <span>Subtotal</span>
                      <span className="tabular-nums">{usd(h.subtotalBeforeDiscount)}</span>
                    </div>
                    {h.discountAmount > 0 && (
                      <div className="flex justify-between text-green-600">
                        <span>Discount</span>
                        <span className="tabular-nums">−{usd(h.discountAmount)}</span>
                      </div>
                    )}
                    {h.earlyInstallDiscountAmount > 0 && (
                      <div className="flex justify-between text-green-600">
                        <span>Early-install discount</span>
                        <span className="tabular-nums">−{usd(h.earlyInstallDiscountAmount)}</span>
                      </div>
                    )}
                    {h.rushFeeAmount > 0 && (
                      <div className="flex justify-between">
                        <span>Rush fee</span>
                        <span className="tabular-nums">{usd(h.rushFeeAmount)}</span>
                      </div>
                    )}
                    {h.takedownAmount > 0 && (
                      <div className="flex justify-between">
                        <span>Premium takedown</span>
                        <span className="tabular-nums">{usd(h.takedownAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span>Tax ({(BUSINESS_RULES.taxRate * 100).toLocaleString('en-US', { maximumFractionDigits: 3 })}% on {usd(h.taxableAmount)})</span>
                      <span className="tabular-nums">{usd(h.taxAmount)}</span>
                    </div>
                  </div>

                  {/* Total + split */}
                  <div className="border-t border-gray-300 mt-3 pt-4">
                    <div className="flex justify-between items-baseline">
                      <span className="text-lg font-bold text-gray-900">Total</span>
                      <span className="text-2xl font-bold text-gray-900 tabular-nums">{usd(h.total)}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="bg-green-50 border border-green-200 rounded-md p-3">
                        {/* #177 — the percent reflects result.depositRate (the staff
                            override when set), never a hardcoded 50%. */}
                        <p className="text-xs text-green-700 font-medium uppercase tracking-wide">
                          Deposit Due Now ({Math.round((result.depositRate ?? BUSINESS_RULES.depositPercentage) * 100)}%)
                        </p>
                        <p className="text-xl font-bold text-green-800 tabular-nums mt-0.5">{usd(h.depositAmount)}</p>
                      </div>
                      <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
                        <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Balance at Install</p>
                        <p className="text-xl font-bold text-gray-700 tabular-nums mt-0.5">{usd(h.balanceDue)}</p>
                      </div>
                    </div>
                  </div>
                </>
              );
            })()}

            <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mt-6 pt-5 mb-4 pb-2 border-t border-b border-gray-200">
              Quote Breakdown
            </h2>

            {/* Roofline options — Santa's vs Gingerbread are mutually exclusive
                (#17). BOTH are presented to the customer; only the recommended
                one is billed in the total below. (Interactive staff-pick toggle
                is Phase 1b — for now the recommendation is auto-picked to land
                the quote closest to the $1,000 minimum without going under.) */}
            {(result.rooflineOptions.santas || result.rooflineOptions.gingerbread) && (
              <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  Roofline — recommend one <span className="font-normal normal-case text-gray-400">(the customer picks on the portal)</span>
                </p>
                <div className="space-y-1">
                  {result.rooflineOptions.santas && (
                    <label className="flex items-center justify-between text-sm cursor-pointer rounded px-2 py-1.5 hover:bg-gray-100">
                      <span className="flex items-center gap-2 text-gray-700">
                        <input
                          type="radio"
                          name="rooflineChoice"
                          checked={result.rooflineChoice === 'santas'}
                          onChange={() => recommendRoofline('santas')}
                          disabled={loading}
                        />
                        Santa&apos;s <span className="text-gray-400">(front roofline)</span>
                      </span>
                      <EditablePrice
                        amount={result.rooflineOptions.santas.amount}
                        baseAmount={baselineResult?.rooflineOptions?.santas?.amount ?? result.rooflineOptions.santas.amount}
                        overridden={Object.prototype.hasOwnProperty.call(form.lineItemPriceOverrides, 'roofline-santas')}
                        disabled={loading || postApprovalFrozen}
                        lockedReason={postApprovalFrozen ? POST_APPROVAL_LOCK_REASON : undefined}
                        onCommit={(n) => commitLinePrice('roofline-santas', n)}
                        onReset={() => resetLinePrice('roofline-santas')}
                      />
                    </label>
                  )}
                  {result.rooflineOptions.gingerbread && (
                    <label className="flex items-center justify-between text-sm cursor-pointer rounded px-2 py-1.5 hover:bg-gray-100">
                      <span className="flex items-center gap-2 text-gray-700">
                        <input
                          type="radio"
                          name="rooflineChoice"
                          checked={result.rooflineChoice === 'gingerbread'}
                          onChange={() => recommendRoofline('gingerbread')}
                          disabled={loading}
                        />
                        Gingerbread <span className="text-gray-400">(front + ridge + sides)</span>
                      </span>
                      <EditablePrice
                        amount={result.rooflineOptions.gingerbread.amount}
                        baseAmount={baselineResult?.rooflineOptions?.gingerbread?.amount ?? result.rooflineOptions.gingerbread.amount}
                        overridden={Object.prototype.hasOwnProperty.call(form.lineItemPriceOverrides, 'roofline-gingerbread')}
                        disabled={loading || postApprovalFrozen}
                        lockedReason={postApprovalFrozen ? POST_APPROVAL_LOCK_REASON : undefined}
                        onCommit={(n) => commitLinePrice('roofline-gingerbread', n)}
                        onReset={() => resetLinePrice('roofline-gingerbread')}
                      />
                    </label>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 mt-2">Only the recommended (selected) option is billed in the total below.</p>
              </div>
            )}

            {/* Line items (the recommended roofline is shown in the option box
                above, so it's filtered out here to avoid listing it twice).
                Each per-unit / custom row gets a "Recommended" checkbox (#12):
                checking it advises the customer (pre-selected + labeled on the
                portal). Roofline keeps its own "recommend one" radio above —
                NOT this checkbox. */}
            <div className="mb-4 space-y-1.5">
              {(() => {
                // Per-unit kinds that get a "Recommended" checkbox. Most round-trip
                // their `recommended` flag through the projection; Winter Wonderland
                // ('ridge') is measurement-driven (not projected), so its flag rides
                // on its scene strands instead — attachSceneLinks carries it to the
                // portal (Jason S12). The Santa's/Gingerbread roofline OPTIONS keep
                // their own "recommend one" radio above and are filtered out of these
                // rows, so 'ridge' here only ever matches Winter Wonderland.
                const RECOMMENDABLE_KINDS = new Set<PortalLineItem['kind']>([
                  'tree', 'bush', 'column', 'railing', 'curtain', 'spritzer', 'wreath', 'garland', 'bow', 'ridge', 'stake-lighting',
                ]);
                // Drop by stable id, not label text (#110 W3-003 — a sibling of the
                // #110 W1-005 bug fixed in adapter.ts). A label-prefix match also
                // drops staff-typed CUSTOM items that happen to share those words,
                // and desyncs this array from breakdownLinked (built by the same
                // adapter, which already filters by id), corrupting the positional
                // rows[i] ↔ breakdownLinked[i] pairing below.
                const rows = result.lineItems.filter((item) => !(item.id && BILLED_ROOFLINE_IDS.has(item.id)));
                // #104: baseline (overrides-stripped) amount per stable line id, for
                // the "custom · was $X" chip on an overridden row.
                const baseById = new Map(
                  (baselineResult?.lineItems ?? []).filter((li) => li.id).map((li) => [li.id, li.amount]),
                );
                let customCursor = 0; // consume custom matchers in order
                return rows.map((item, i) => {
                  const linked = breakdownLinked[i];
                  const sceneItemIds = linked?.sceneItemIds;
                  // item-numbering-rename: resolved once per row, up front, so
                  // the checkbox aria-labels below and the row's own display
                  // text (rowInner, further down) always agree on the name a
                  // renamed item goes by.
                  const resolvedLabel = resolveLineItemLabel(item.id, item.label, form.labelOverrides);
                  let checkbox: React.ReactNode = null;
                  if (designId && sceneItemIds && sceneItemIds.length > 0 && linked && RECOMMENDABLE_KINDS.has(linked.kind)) {
                    // Design-driven per-unit row (incl. strand-drawn WW/Stake) →
                    // toggle persists on the scene.
                    const checked = !!linked?.recommended;
                    checkbox = (
                      <input
                        type="checkbox"
                        className="cursor-pointer accent-green-600"
                        checked={checked}
                        // Row 367: this toggle persists on the SCENE, so it is
                        // frozen with the rest of the picture — parity with the
                        // EditablePrice/EditableLabel controls on this same row.
                        disabled={recommendBusy || postApprovalFrozen}
                        onChange={() => void toggleDesignItemRecommended(sceneItemIds, !checked)}
                        aria-label={`Recommend ${resolvedLabel.label}`}
                        title={postApprovalFrozen ? POST_APPROVAL_DESIGN_LOCK_REASON : 'Recommend this item to the customer'}
                      />
                    );
                  } else if (item.id === 'winter-wonderland' || item.id === 'stake-lighting') {
                    // #12: MANUAL-footage Winter Wonderland / Stake (no scene strand
                    // to hold the flag) → recommend rides the quote inputs. Saves on
                    // the next Calculate, like the custom-row checkbox.
                    const isWW = item.id === 'winter-wonderland';
                    const checked = isWW ? form.winterWonderlandRecommended : form.stakeLightingRecommended;
                    checkbox = (
                      <input
                        type="checkbox"
                        className="cursor-pointer accent-green-600"
                        checked={checked}
                        onChange={() =>
                          set(isWW ? 'winterWonderlandRecommended' : 'stakeLightingRecommended', !checked)
                        }
                        aria-label={`Recommend ${item.label}`}
                        title="Recommend this item to the customer (saves on Calculate)"
                      />
                    );
                  } else if (item.id && form.permanent && PERMANENT_RECOMMEND_FIELDS[item.id]) {
                    // #131: permanent per-side recommend rides the inputs (the
                    // WW/Stake pattern above — sides bill from footage NUMBERS,
                    // so there may be no scene strand to hold the flag). Saves on
                    // the next Calculate. The legacy combined 'permanent-sides'
                    // row has no map entry → no checkbox until a re-Calculate
                    // splits it.
                    const permKey = PERMANENT_RECOMMEND_FIELDS[item.id];
                    const checked = !!form.permanent[permKey];
                    checkbox = (
                      <input
                        type="checkbox"
                        className="cursor-pointer accent-green-600"
                        checked={checked}
                        onChange={() =>
                          setForm((f) =>
                            f.permanent ? { ...f, permanent: { ...f.permanent, [permKey]: !checked } } : f,
                          )
                        }
                        aria-label={`Recommend ${item.label}`}
                        title="Recommend this item to the customer (saves on Calculate)"
                      />
                    );
                  } else {
                    // Maybe a custom row → match by the engine label, in order.
                    const matchAt = customRowMatchers.findIndex(
                      (m, idx) => idx >= customCursor && m.label === item.label,
                    );
                    if (matchAt >= 0) {
                      const { formIndex } = customRowMatchers[matchAt];
                      customCursor = matchAt + 1;
                      const checked = !!form.customLineItems[formIndex]?.recommended;
                      checkbox = (
                        <input
                          type="checkbox"
                          className="cursor-pointer accent-green-600"
                          checked={checked}
                          onChange={() => updateCustomLineItem(formIndex, { recommended: !checked })}
                          aria-label={`Recommend ${item.label}`}
                          title="Recommend this item to the customer (saves on Calculate)"
                        />
                      );
                    }
                  }
                  // #104: rows carrying a stable id (per-unit / Winter Wonderland /
                  // Stake) get a click-to-edit total. Custom + roofline rows (no id
                  // here) keep a plain price for now.
                  const priceCell = item.id ? (
                    <EditablePrice
                      amount={item.amount}
                      baseAmount={baseById.get(item.id) ?? item.amount}
                      overridden={Object.prototype.hasOwnProperty.call(form.lineItemPriceOverrides, item.id)}
                      disabled={loading || postApprovalFrozen}
                      lockedReason={postApprovalFrozen ? POST_APPROVAL_LOCK_REASON : undefined}
                      onCommit={(n) => commitLinePrice(item.id!, n)}
                      onReset={() => resetLinePrice(item.id!)}
                    />
                  ) : (
                    <span className="font-medium tabular-nums">{usd(item.amount)}</span>
                  );
                  // #13: staff-only photo tag — which photo this line's items
                  // are drawn on (untagged = photo 1). Portal never shows this.
                  const photoTag = photoLabelForLine(
                    sceneItemIds,
                    breakdownScene?.items ?? [],
                    breakdownPhotoLabels,
                  );
                  // item-numbering-rename: only the per-unit categories the
                  // design projects one-instance-per-drawn-item (mini/spritzer/
                  // wreath/garland/bow — the SAME ids projectScene stamps, and
                  // the only ones duplicate-numbering ever applies to) get the
                  // inline rename control. Roofline/WW/Stake/permanent/custom
                  // rows keep their plain label — each already has its own
                  // dedicated editing surface (footage inputs, the custom-item
                  // form) and duplicate numbering never applies to them.
                  const renameable = !!item.id && /^(mini|spritzer|wreath|garland|bow)-/.test(item.id);
                  const rowInner = (
                    <>
                      <span className="flex items-center gap-2 text-gray-700">
                        {checkbox}
                        {renameable ? (
                          <EditableLabel
                            label={resolvedLabel.label}
                            baseLabel={item.label}
                            overridden={resolvedLabel.overridden}
                            disabled={loading || postApprovalFrozen}
                            lockedReason={postApprovalFrozen ? POST_APPROVAL_LOCK_REASON : undefined}
                            onCommit={(s) => commitLineLabel(item.id!, s)}
                            onReset={() => resetLineLabel(item.id!)}
                          />
                        ) : (
                          item.label
                        )}
                        {photoTag && (
                          <span className="rounded bg-gray-200 text-gray-600 px-1 py-0.5 text-[10px] font-medium">
                            {photoTag}
                          </span>
                        )}
                      </span>
                      {priceCell}
                    </>
                  );
                  // A recommendable row wraps its content in a <label> so clicking
                  // ANYWHERE on the row (the item name, not just the 13px box)
                  // toggles the recommendation — mirroring the roofline option rows
                  // above. Without this the bare checkbox is the only hit target, so
                  // clicking the item name does nothing. Non-recommendable rows have
                  // no checkbox to toggle, so they stay plain (non-clickable) divs.
                  return checkbox ? (
                    <label
                      key={i}
                      className="flex justify-between items-center text-sm gap-2 cursor-pointer rounded px-2 py-1.5 -mx-2 hover:bg-gray-100"
                    >
                      {rowInner}
                    </label>
                  ) : (
                    <div key={i} className="flex justify-between items-center text-sm gap-2">
                      {rowInner}
                    </div>
                  );
                });
              })()}
            </div>

            {/* #12: recommended-only subtotal — what the customer's portal opens
                with when staff recommend items (the checked items + the
                recommended roofline). Lets staff confirm it clears the $1,000
                minimum before sending. */}
            <div className="border-t border-gray-200 mt-3 pt-3 text-sm">
              {recommendedCount > 0 ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-gray-600">
                      Recommended subtotal <span className="text-gray-400">(customer&apos;s starting total)</span>
                    </span>
                    <span className="tabular-nums font-semibold text-gray-800">{usd(recommendedSubtotal)}</span>
                  </div>
                  {result.subtotalBeforeDiscount >= breakdownMinimum &&
                    recommendedSubtotal < breakdownMinimum && (
                      <p className="text-xs text-red-600 mt-1">
                        ⚠ Under the {usd(breakdownMinimum)} minimum — the customer can&apos;t approve until they add{' '}
                        {usd(breakdownMinimum - recommendedSubtotal)} more. Recommend additional items before sending.
                      </p>
                    )}
                </>
              ) : (
                <p className="text-xs text-gray-400">
                  No items recommended — the customer&apos;s portal opens with the default selection (auto-set to clear the {usd(breakdownMinimum)} minimum).
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Send Quote to Customer ────────────────────────────────────
            Surfaces once a quote has been saved (so we have an ID for the
            portal URL). Copies the customer-facing link to the clipboard
            AND moves the HighLevel opportunity to "📨Bid Sent". Manual
            share — admin pastes the URL into email/SMS/etc. */}
        {savedQuoteId && result && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-10">
            <div className="flex items-baseline justify-between mb-4 pb-2 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide">
                Send Quote to Customer
              </h2>
              <span className="text-xs text-gray-400">Copies link + updates pipeline</span>
            </div>

            {/* Portal URL preview — always visible so the admin can copy
                manually if the button didn't work (e.g., clipboard blocked). */}
            <div className="mb-3">
              <p className={lbl}>Customer Portal URL</p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={portalUrlFor(savedQuoteId)}
                  className="flex-1 border border-gray-200 bg-gray-50 rounded-md px-3 py-2 text-sm text-gray-700 font-mono"
                  onClick={e => (e.target as HTMLInputElement).select()}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(portalUrlFor(savedQuoteId));
                      setCopiedUrl(true);
                      setTimeout(() => setCopiedUrl(false), 2000);
                    } catch { /* clipboard blocked */ }
                  }}
                  className="shrink-0 border border-gray-300 hover:border-gray-400 bg-white hover:bg-gray-50 text-gray-700 font-medium text-xs px-3 py-2 rounded-md whitespace-nowrap"
                >
                  {copiedUrl ? '✓ Copied' : '📋 Copy'}
                </button>
              </div>
            </div>

            {/* HighLevel attach status — informational. The operator might
                have skipped the HL autocomplete (walk-in quote), in which
                case "Send Quote to Customer" still works but no pipeline
                stage moves. */}
            {highlevelContact && (
              <div className="mb-3 text-xs">
                {attachStatus === 'attaching' && (
                  <span className="text-gray-500">Linking to HighLevel opportunity…</span>
                )}
                {attachStatus === 'attached' && (
                  <span className="text-green-700">
                    ✓ Linked to {highlevelContact.fullName || 'HighLevel contact'}&rsquo;s pipeline card
                    {attachResurrected && (
                      <span className="text-amber-700">
                        {' '}— reopened their previous (closed) card at the pipeline&rsquo;s entry stage
                      </span>
                    )}
                  </span>
                )}
                {attachStatus === 'error' && (
                  <span className="text-red-600">HighLevel link failed: {attachError}. A real quote can&rsquo;t send unlinked — re-pick the contact or Calculate to retry, then send again.</span>
                )}
                {attachStatus === 'skipped' && (
                  <span className="text-amber-700">{attachError}</span>
                )}
              </div>
            )}

            {/* #839 fix-round MED: the #251 identity freeze used to be
                log-only when it actually refused a would-be reattach — this
                is that surfaced. Not nested in the highlevelContact-gated
                block above: it can fire even when highlevelContact is null
                (a reopened quote's DB link isn't hydrated into that state —
                #172), and it describes the save that just ran, not the
                current chip.
                Row 338 fix: the original copy told staff to "Use the amend
                flow to move it to a different customer" — traced and found
                false. The amend flow (/api/quotes/[id]/amend) only re-prices
                a booked order's totals; it has no identity fields at all and
                never writes customer_id/highlevel_contact_id/customer_name/
                etc. There is currently no in-app way to move a frozen quote
                to a different customer (the code-level remedy is a manual DB
                correction — see the "WT-55 manual merge" comments in
                quotes.ts/customers.ts), so the copy now says that honestly
                instead of pointing at a flow that can't do it. */}
            {identityFrozenNotice && (
              <p className="mb-3 text-xs text-amber-700">
                This quote is approved or booked, so its customer stayed put — the name, contact details and
                HighLevel link on this quote were left exactly as the customer approved them, and nothing on this
                save changed who the quote belongs to. There is no in-app way to move an approved quote to a
                different customer — if this needs correcting, contact support for a manual fix rather than re-saving.
              </p>
            )}

            {/* Second fix round (staff-lens HIGH): this copy used to tell staff
                to "decline, revive, and re-send" whenever portalShowsFrozenPrice
                was false, unconditionally — but both decline routes
                (decline/route.ts, staff-decline/route.ts) structurally refuse a
                BOOKED order (canTransition 409s), and a booked order is exactly
                the case bookedAmendEligible/hasAcceptedAmendment cover. Two
                independent axes now: the middle sentence diagnoses WHY the
                portal isn't frozen (missing snapshot vs an already-accepted
                amendment); the last sentence gives the remedy that actually
                works for THIS order's state (bookedAmendEligible mirrors the
                exact predicate the rest of this file already uses for the
                booked-amend carve-out — see its own comment above). */}
            {postApprovalRepriceNotice && (
              <p className="mb-3 text-xs text-amber-700">
                {`Heads up — this quote was already approved by the customer at ${usd(postApprovalRepriceNotice.previousTotalUsd)}, and this save `}
                {postApprovalRepriceNotice.deltaUsd > 0 ? 'raised' : 'lowered'}
                {` the price to ${usd(postApprovalRepriceNotice.newTotalUsd)} (${postApprovalRepriceNotice.deltaUsd > 0 ? '+' : ''}${usd(postApprovalRepriceNotice.deltaUsd)}). `}
                {postApprovalRepriceNotice.portalShowsFrozenPrice ? (
                  "The portal still shows what they approved — the customer's approval no longer reflects this quote's current price until you decline, revive, and re-send it."
                ) : (
                  <>
                    {postApprovalRepriceNotice.hasAcceptedAmendment
                      ? 'This order already has an accepted amendment, so the portal always shows the live price now — it is already showing this new figure, with no re-consent. '
                      : 'The portal has NO frozen price on file for this approval, so it is already showing the customer this NEW price — with no re-consent. '}
                    {bookedAmendEligible ? (
                      savedJobId ? (
                        <>
                          {'Record it through '}
                          <Link
                            href={`/admin/jobs/${savedJobId}`}
                            className="font-semibold underline hover:no-underline"
                          >
                            the job&apos;s Record-amendment flow
                          </Link>
                          {" so the customer consents to it — a booked order can't be declined, revived, or re-sent."}
                        </>
                      ) : (
                        "Record it through the job's amend flow so the customer consents to it — a booked order can't be declined, revived, or re-sent."
                      )
                    ) : (
                      'Call/text before they see it, or decline, revive, and re-send.'
                    )}
                  </>
                )}
              </p>
            )}

            {hasNoPricedItems && (
              <p className="mb-3 text-sm text-red-600 font-medium">
                Add at least one priced line item and click Calculate before sending.
              </p>
            )}
            {hasUnfulfillable && (
              <p className="mb-3 text-sm text-red-600 font-medium">
                {`⚠️ This design has ${unfulfillable.length} item${unfulfillable.length === 1 ? '' : 's'} we can’t supply — see the red notes in `}
                <button
                  type="button"
                  onClick={() =>
                    document.getElementById('from-your-design')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                  className="underline font-semibold hover:text-red-700 cursor-pointer"
                >
                  “From your design”
                </button>
                {` above. Recolor or remove ${unfulfillable.length === 1 ? 'it' : 'them'} before sending.`}
              </p>
            )}
            {/* Referral program redemption (#41 adversarial-review HIGH fix):
                a referral-credit change (Apply or Remove) hasn't been
                confirmed saved on this quote yet — block Send until a
                Calculate actually persists it. */}
            {referralCreditUnsaved && (
              <p className="mb-3 text-sm text-red-600 font-medium">
                Referral credit is applied but not saved yet. Click Calculate, then send.
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500 flex-1">
                Click to copy the link AND move this quote to &ldquo;Bid Sent&rdquo; in HighLevel. Then paste the URL into your email / text to the customer.
              </p>
              <button
                type="button"
                onClick={handleSendToCustomer}
                disabled={sendStatus === 'sending' || hasNoPricedItems || hasUnfulfillable || referralCreditUnsaved || (form.serviceType === 'event' && !eventDatesValid)}
                title={
                  hasNoPricedItems
                    ? 'Add at least one priced line item and click Calculate before sending.'
                    : referralCreditUnsaved
                      ? 'Click Calculate to save the referral credit change before sending.'
                    : form.serviceType === 'event' && !eventDatesValid
                      ? 'Fix the event dates above — install, event, and takedown dates must be in order before sending.'
                      : undefined
                }
                className="shrink-0 bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white font-medium text-sm px-5 py-2.5 rounded-md whitespace-nowrap"
              >
                {sendStatus === 'sending' ? 'Sending…'
                  : sendStatus === 'sent'
                    ? (ghlSyncWarning ? '✓ Sent (CRM sync pending)' : '✓ Sent — stage moved to Bid Sent')
                  : '📨 Send Quote to Customer'}
              </button>
            </div>

            {/* #241: the guard short-circuited — nothing was texted or emailed
                this click. Say so plainly instead of rendering the same
                "✓ Sent" state as a real delivery, and offer a one-click
                force-redeliver (reuses the existing ?retryDelivery=1 path —
                does not re-stamp quote_sent_at or move the CRM card again). */}
            {sendStatus === 'already-sent' && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                {retryIneligible ? (
                  // #241 defect 2 (review MEDIUM): Force Redeliver was
                  // clicked and ALSO hit the alreadySent short-circuit — the
                  // quote moved past sent/viewed (approved/booked/deposit
                  // paid) since the original send. Retrying again would hit
                  // the identical guard, so don't repeat the same doomed
                  // button — point at the manual copy field above instead.
                  <p>
                    Redeliver didn&apos;t send anything either — this quote has
                    moved past &ldquo;sent&rdquo;/&ldquo;viewed&rdquo; (approved,
                    booked, or a deposit was paid), so an automatic resend is
                    blocked to protect the CRM pipeline. Copy the Customer
                    Portal URL above and share it with the customer directly.
                  </p>
                ) : (
                  // Row 269: was a hardcoded "Nothing was delivered" — false
                  // whenever the original send DID confirm-deliver one or
                  // both channels (this click just didn't deliver anything
                  // ITSELF). Report the actual per-channel history instead.
                  <p>
                    This quote was already sent
                    {alreadySentAt ? ` on ${new Date(alreadySentAt).toLocaleString()}` : ' earlier'}.
                    Clicking Send again does not re-text or re-email the
                    customer.{' '}
                    {alreadySentChannels
                      ? `${channelDeliveryPhrase('SMS', alreadySentChannels.sms)}; ${channelDeliveryPhrase('email', alreadySentChannels.email)}.`
                      : ''}
                    {/* Row 269 fix round FIX 2 (two-lens MED): was "Both
                        channels are confirmed delivered" — outcome:'sent'
                        only means GHL's API accepted the request without
                        throwing; there's no delivery RECEIPT anywhere in
                        this codebase. Reworded to claim only what's true. */}
                    {deliveryRetryChannel === null &&
                      ' Both channels went out successfully — copy the Customer Portal URL above if the customer needs it again.'}
                  </p>
                )}
                {/* No `disabled={sendStatus === 'sending'}` here (and on its
                    two siblings below) — this button only renders while
                    sendStatus is exactly 'already-sent', a value mutually
                    exclusive with 'sending' in the union, so the comparison
                    is dead code (tsc flags it: TS2367). Unlike the always-
                    mounted main Send button, this button UNMOUNTS the
                    instant a click flips sendStatus to 'sending' — that's
                    the render-level guard; handleRetryDelivery's
                    sendInFlightRef check is what closes the real
                    same-tick double-click race. */}
                {!retryIneligible && deliveryRetryChannel && (
                  <button
                    type="button"
                    onClick={handleForceRedeliverClick}
                    className="mt-2 text-xs font-medium text-amber-900 underline hover:no-underline"
                  >
                    {/* Row 269: label now names the SCOPED channel(s) —
                        deliveryRetryChannel is no longer hardcoded 'both'
                        (see the alreadySent branch above), so "SMS + email"
                        would overclaim when only one channel is offered. */}
                    Force redeliver ({deliveryRetryChannel === 'both' ? 'SMS + email' : deliveryRetryChannel.toUpperCase()}) now
                  </button>
                )}
              </div>
            )}

            {sendStatus === 'error' && (
              <div className="mt-3 text-sm text-red-600">
                <p>Send failed: {sendError}. The portal URL is still valid — you can copy it manually and share.</p>
                {deliveryRetryChannel && (
                  <button
                    type="button"
                    onClick={handleScopedRetryClick}
                    className="mt-2 font-medium underline hover:no-underline"
                  >
                    Retry {deliveryRetryChannel === 'both' ? 'SMS and email' : deliveryRetryChannel.toUpperCase()}
                  </button>
                )}
              </div>
            )}

            {sendStatus === 'sent' && deliveryWarning && deliveryRetryChannel && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <p>{deliveryWarning}</p>
                <button
                  type="button"
                  onClick={handleScopedRetryClick}
                  className="mt-2 text-xs font-medium text-amber-900 underline hover:no-underline"
                >
                  Retry {deliveryRetryChannel === 'both' ? 'SMS and email' : deliveryRetryChannel.toUpperCase()}
                </button>
              </div>
            )}

            {sendBlockedMsg && (
              <p className="mt-3 text-sm text-red-600 font-medium">
                {sendBlockedMsg}{' '}
                <button
                  type="button"
                  onClick={() =>
                    document.getElementById('from-your-design')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                  className="underline cursor-pointer hover:text-red-700"
                >
                  Jump to it
                </button>
              </p>
            )}

            {/* Sent locally, but the HighLevel "Bid Sent" stage move failed —
                surface it (don't claim the card advanced) + offer a retry. */}
            {sendStatus === 'sent' && ghlSyncWarning && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <p>
                  Sent to the customer — but the HighLevel card didn&apos;t advance to
                  &ldquo;Bid Sent&rdquo;. {ghlSyncWarning}
                </p>
                <button
                  type="button"
                  onClick={handleRetryGhlSync}
                  className="mt-2 text-xs font-medium text-amber-900 underline hover:no-underline"
                >
                  Retry CRM sync
                </button>
              </div>
            )}

            {/* FIX A (#237 fix round, staff-lens HIGH): sent locally, the
                HighLevel card may well have advanced fine, but the event date
                itself failed to sync onto the contact's custom field. Its own
                banner (not folded into the one above) so it never claims the
                card didn't advance when it did — reuses the SAME retry
                action, since ?retryGhl re-runs this push too. */}
            {sendStatus === 'sent' && eventDateSyncWarning && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <p>{eventDateSyncWarning}</p>
                <button
                  type="button"
                  onClick={handleRetryGhlSync}
                  className="mt-2 text-xs font-medium text-amber-900 underline hover:no-underline"
                >
                  Retry CRM sync
                </button>
              </div>
            )}

            {/* ── Training capture (#8 Stage A / #141 permanent) — no analyzer
                for permanent bistro (#117), so hide the whole block: there's
                nothing to teach, and the button would otherwise silently
                write a bistro photo into the holiday library. ── */}
            {(form.serviceType === 'holiday' || form.serviceType === 'event' || form.serviceType === 'permanent') && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500 flex-1">
                  {form.serviceType === 'permanent'
                    ? 'Sending auto-saves this house as a permanent-lighting training example. You can also save one now without sending (e.g. to teach an unusual roofline mid-flow).'
                    : 'Sending auto-saves this house as an AI training example. You can also save one now without sending (e.g. to teach an unusual house mid-flow).'}
                  {trainStatus === 'saved' && (
                    <span className="ml-1 text-green-700 font-medium">✓ Saved as training example.</span>
                  )}
                  {trainStatus === 'error' && (
                    <span className="ml-1 text-amber-700">Training capture failed: {trainError}</span>
                  )}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void (form.serviceType === 'permanent' ? capturePermanentExample('manual') : captureExample('manual'))
                  }
                  disabled={trainStatus === 'saving' || !savedQuoteId}
                  className="shrink-0 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md whitespace-nowrap"
                >
                  {trainStatus === 'saving' ? 'Saving…' : '🎓 Save as training example'}
                </button>
              </div>
              {/* Optional note, typed here at correction time — rides along on
                  both the manual save above and the silent auto-capture at
                  Send. Fully optional: no required-field marker, nothing
                  blocks Send or the manual save if it's left blank. */}
              <label htmlFor="ai-mistake-note" className="block mt-2 text-xs text-gray-500">
                What did the AI get wrong here? (optional)
              </label>
              <textarea
                id="ai-mistake-note"
                value={trainNotes}
                onChange={(e) => setTrainNotes(e.target.value)}
                maxLength={TRAINING_NOTE_MAX_LEN}
                rows={2}
                placeholder={`e.g. "missed the garage wing", "put a wreath on a window with no wreath", "under-counted the bushes"`}
                className="mt-1 w-full text-xs border border-gray-300 rounded-md px-2 py-1.5 text-gray-700 placeholder:text-gray-400"
              />
            </div>
            )}
          </div>
        )}

      </div>

      {/* Call-notes drawer (2026-08-31): a sibling of the centered column
          above, not nested inside it — fixed positioning, so it can never
          affect that column's width or reflow. */}
      <QuoteBuilderCallNotesDrawer ghlContactId={form.highlevelContactId} />
    </OperatorShell>
  );
}
