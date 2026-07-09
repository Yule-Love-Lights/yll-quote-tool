'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type {
  QuoteResult,
  QuoteInputs,
  CustomLineItem,
  RooflineChoice,
} from '@/lib/pricing/pricingEngine';
import { BUSINESS_RULES } from '@/lib/pricing/pricingEngine';
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
  initialFormData,
  buildQuoteInputs,
  inputsToFormData,
} from '@/lib/quoteForm';
import type { CrmContact } from '@/lib/integrations/types';
import { type ServiceType, SERVICE_TYPES, SERVICE_TYPE_LABELS } from '@/lib/serviceType';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { EventSection } from './EventSection';
import { OperatorShell } from '@/components/OperatorShell';
import HighLevelContactAutocomplete from '@/components/admin/HighLevelContactAutocomplete';
import dynamic from 'next/dynamic';

import DesignSummary from '@/components/quote/DesignSummary';
import PermanentSection from '@/components/quote/PermanentSection';
import type { AnalysisSeed } from '@/lib/design/seedFromAnalysis';
import { deriveSideMeasure } from '@/lib/permanent/satelliteMeasure';
import { deriveTrackAccessories, hasAccessorySignal } from '@/lib/permanent/trackAccessories';
import { isStrand, isLinkedTwin } from '@/lib/design/sceneTypes';
import { useImageZoomPan } from '@/lib/useImageZoomPan';
import { offeredFromLists, offeredIsKnown, type OfferedColorLists } from '@/lib/inventory/resolveInstalls';
import { detectUnfulfillable } from '@/lib/inventory/detectUnfulfillable';

// The Konva design editor touches the DOM/canvas, so load it client-only.
const DesignEditor = dynamic(() => import('@/components/design/DesignEditor'), { ssr: false });

// ─── Shared CSS constants ────────────────────────────────────────────────────

const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500';
const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';
const addBtn = 'mt-1 text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5 transition-colors';
const rmBtn = 'text-red-400 hover:text-red-600 font-bold text-xl leading-none mt-0.5';

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
  'roofline-santas': { diffKey: 'santasDifficulty', rateKey: 'santasCustomRate', fallback: 'medium' },
  'roofline-gingerbread': { diffKey: 'gingerbreadDifficulty', rateKey: 'gingerbreadCustomRate', fallback: 'medium' },
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
  onCommit,
  onReset,
}: {
  amount: number;
  baseAmount: number;
  overridden: boolean;
  disabled: boolean;
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
            showBase
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
        title="Click to set a custom price for this quote"
        className={`font-medium tabular-nums rounded px-1 -mx-1 hover:bg-green-50 disabled:cursor-not-allowed cursor-text ${
          overridden ? 'text-amber-700' : 'text-gray-900'
        }`}
      >
        {usd(amount)}
      </button>
    </span>
  );
}

// A measurement polyline on the satellite image (normalized 0–1 coords).
// #82 2c: `feature` is the AI's per-segment physical roof feature (mirrors
// photoAnalysis RoofFeatureClass), carried into the seed so roofline strands
// get a roofFeature for the inventory clip engine.
type LineSegment = { points: [number, number][]; label: string; feature?: 'gutter' | 'peak' | 'side' | 'ridge' | 'metal' };

// Satellite image is always 640x640 at zoom=20 from Static Maps.
const SAT_PX = 640;

// Compute polyline length in "aspect-corrected" normalized units.
// dx stays as-is (image width = 1), dy is scaled by (height/width) so
// diagonal distances reflect real pixel distances on the image.
function polylineLength(lines: LineSegment[], aspect: number): number {
  const yScale = 1 / aspect; // height in width-units
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i++) {
      const [x1, y1] = line.points[i - 1];
      const [x2, y2] = line.points[i];
      const dx = x2 - x1;
      const dy = (y2 - y1) * yScale;
      total += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return total;
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
  quoteNumber?: number | null;
  // Test Quote (ledger #93): a reopened test quote stays in TEST MODE — derived
  // from the saved row, never re-read from the URL on edit (is_test is immutable).
  isTest?: boolean;
};

// Header status pill (BUG-1, S22): the saved quote's canonical lifecycle status
// so a declined/cancelled quote badges correctly instead of the old
// approvedAt/sentAt-only 'Approved'/'Sent'. Mirrors the admin quotes list palette.
const STATUS_BADGE: Record<QuoteStatus, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-amber-100 text-amber-700' },
  sent: { label: 'Sent', cls: 'bg-blue-100 text-blue-700' },
  viewed: { label: 'Viewed', cls: 'bg-purple-100 text-purple-700' },
  approved: { label: 'Approved', cls: 'bg-green-100 text-green-700' },
  booked: { label: 'Booked', cls: 'bg-emerald-100 text-emerald-700' },
  changes_requested: { label: 'Changes', cls: 'bg-orange-100 text-orange-700' },
  declined: { label: 'Declined', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-200 text-gray-600' },
  lost: { label: 'Lost', cls: 'bg-gray-200 text-gray-600' },
};

// ─── Builder component ───────────────────────────────────────────────────────
// The full quote builder, shared by /quote/new (blank) and /quote/[id] (edit —
// hydrated from a saved quote, task #31).

export default function QuoteBuilder({
  initialQuote,
  isTest: isTestProp,
}: {
  initialQuote?: QuoteBuilderInitial;
  isTest?: boolean;
}) {
  const editMode = initialQuote != null;
  // Test Quote (ledger #93). New: from /quote/new?test=1 (isTestProp). Edit: from
  // the saved row (initialQuote.isTest). When true, the builder shows a TEST MODE
  // banner and Calculate persists the quote as is_test=true (saveQuote).
  const isTest = isTestProp ?? initialQuote?.isTest ?? false;
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
  const quoteNumber = initialQuote?.quoteNumber ?? null;
  const [form, setForm] = useState<QuoteFormData>(() =>
    initialQuote
      ? inputsToFormData(initialQuote.customer, initialQuote.inputs, initialQuote.serviceType)
      : initialFormData,
  );
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
  // `savedQuoteId`: UUID returned from /api/quote. Needed for the attach
  // call and for the "Send Quote to Customer" button (which targets
  // /api/quotes/[id]/send).
  // `attachStatus` / `sendStatus`: informational — surfaced as a small
  // status line so the operator knows whether the GHL side is in sync.
  const [highlevelContact, setHighLevelContact] = useState<CrmContact | null>(null);
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(initialQuote?.quoteId ?? null);
  const [attachStatus, setAttachStatus] = useState<'idle' | 'attaching' | 'attached' | 'skipped' | 'error'>('idle');
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  // #92 — a fulfillability BLOCK (design has items we can't supply), kept distinct
  // from a send FAILURE so we never tell the operator to share the link manually.
  const [sendBlockedMsg, setSendBlockedMsg] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  // GHL stage-sync result of the last send: a non-null message means the quote
  // WAS sent locally but the HighLevel card did NOT advance to "Bid Sent" (the
  // send route reports ghlSynced:false + stageError, and persists ghl_sync_error
  // for the ?retryGhl reconcile bucket). Surfaced so the operator knows + can
  // retry, instead of the old falsely-confident "stage moved to Bid Sent".
  const [ghlSyncWarning, setGhlSyncWarning] = useState<string | null>(null);
  // Guards against re-attaching the same quote+contact on every recalculation,
  // now that Calculate updates the saved row in place instead of inserting.
  const lastAttachKey = useRef<string | null>(null);

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
  // Bumped when the design's scene/photo changes outside the editor (roofline
  // seed, photo replacement) so a remount reloads it.
  const [designEditorKey, setDesignEditorKey] = useState(0);
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
  type AnalysisContext = {
    analysis?: Record<string, unknown>;
    satelliteBase64?: string;
    satelliteMediaType?: string;
    satelliteFeetPerPixel?: number | null;
  };
  const pendingContextRef = useRef<AnalysisContext | null>(null);
  // designId mirrored in a ref so async callbacks (e.g. the FileReader in the
  // manual satellite upload) read the CURRENT id at fire time, not the stale
  // one captured in their closure when a design was created mid-flight.
  const designIdRef = useRef<string | null>(initialQuote?.designId ?? null);
  const pushAnalysisContext = async (id: string, ctx: AnalysisContext) => {
    if (!ctx.analysis && !ctx.satelliteBase64) return;
    try {
      await fetch(`/api/designs/${id}/analysis-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx),
      });
    } catch {
      // Non-fatal: quoting works without provenance; only training capture
      // loses the "original analysis" half for this design.
    }
  };
  // "Save as training example" feedback (#8 Stage A) — covers both the
  // manual button and the silent auto-capture at Send.
  const [trainStatus, setTrainStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [trainError, setTrainError] = useState<string | null>(null);
  // The editor's flushSave (#8 Stage A M6), re-registered on each (re)mount.
  // Capture awaits it so it never snapshots a scene the 600ms autosave debounce
  // hasn't persisted yet.
  const editorFlushRef = useRef<(() => Promise<void>) | null>(null);
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
        body: JSON.stringify({ quoteId: savedQuoteId, source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Capture failed (${res.status})`);
      setTrainStatus('saved');
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
        body: JSON.stringify({ quoteId: savedQuoteId, source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Capture failed (${res.status})`);
      setTrainStatus('saved');
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
        setDesignEditorKey((k) => k + 1);
      }
    } catch {
      // Non-fatal: the design still works, it just isn't pre-designed.
    }
  };

  // Eager design lifecycle: photo arrives → create the design with it (plus any
  // pending roofline seed); photo changes later (camera recapture / re-lookup)
  // → replace the existing design's base photo in place.
  useEffect(() => {
    if (!photoBase64 || !photoMediaType) return;
    if (designPhotoRef.current === photoBase64) return;
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
    void push();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoBase64, photoMediaType, designId]);

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
  type LineType = 'santas' | 'gingerbread' | 'c9' | 'stake' | PermanentSideKey;
  const [dragging, setDragging] = useState<{ type: LineType; lineIdx: number; ptIdx: number } | null>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [addMode, setAddMode] = useState<LineType | null>(null);
  const [pendingPoints, setPendingPoints] = useState<[number, number][]>([]);
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
    const c9Target = hasC9Lines ? c9Ft : hadC9LinesRef.current ? 0 : null;
    hadC9LinesRef.current = hasC9Lines;
    const hasStakeLines = satelliteStakeLines.length > 0;
    const stakeTarget = hasStakeLines ? stakeFt : hadStakeLinesRef.current ? 0 : null;
    hadStakeLinesRef.current = hasStakeLines;
    const hasSantasLines = satelliteSantasLines.length > 0;
    const santasTarget = hasSantasLines ? sFt : hadSantasLinesRef.current ? 0 : null;
    hadSantasLinesRef.current = hasSantasLines;
    const hasGingerbreadLines = satelliteGingerbreadLines.length > 0;
    const gingerbreadTarget = hasGingerbreadLines ? gFt : hadGingerbreadLinesRef.current ? 0 : null;
    hadGingerbreadLinesRef.current = hasGingerbreadLines;
    // defer so the form update isn't synchronous within the effect (flushes before paint)
    queueMicrotask(() => setForm(f => {
      // C9 Custom-Runs + Stake are HOLIDAY-only (the event/permanent engines don't
      // price winterWonderland/stakeLighting — event allow-list is santas/gingerbread
      // rooflines only). Never derive those two fields from a satellite draw on a
      // non-holiday quote, or footage would silently persist unbilled (finding #1).
      const isHoliday = f.serviceType === 'holiday';
      const sameSantas = santasTarget == null || f.santasFootage === santasTarget;
      const sameGingerbread = gingerbreadTarget == null || f.gingerbreadFootage === gingerbreadTarget;
      const sameC9 = c9Target == null || f.winterWonderlandFootage === c9Target || !isHoliday;
      const sameStake = stakeTarget == null || f.stakeLightingFootage === stakeTarget || !isHoliday;
      if (sameSantas && sameGingerbread && sameC9 && sameStake) return f;
      return {
        ...f,
        ...(santasTarget != null ? { santasFootage: santasTarget } : {}),
        ...(gingerbreadTarget != null ? { gingerbreadFootage: gingerbreadTarget } : {}),
        ...(c9Target != null && isHoliday ? { winterWonderlandFootage: c9Target } : {}),
        ...(stakeTarget != null && isHoliday ? { stakeLightingFootage: stakeTarget } : {}),
      };
    }));
  }, [satelliteSantasLines, satelliteGingerbreadLines, satelliteC9Lines, satelliteStakeLines, satelliteFeetPerPixel, satelliteAspect]);

  // Footage readout for the satellite tab.
  const satFootage = {
    santas: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteSantasLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
    ginger: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteGingerbreadLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
  };

  // Line setters — satellite-only now (#35): street lines are gone, the design
  // owns the street-side visuals.
  const getSetter = (type: LineType): ((updater: (lines: LineSegment[]) => LineSegment[]) => void) => {
    if (type === 'santas') return setSatelliteSantasLines;
    if (type === 'gingerbread') return setSatelliteGingerbreadLines;
    if (type === 'stake') return setSatelliteStakeLines;
    if (isPermanentSide(type)) {
      return (updater) => {
        // #142: the operator touched the lines — thaw the rehydrate freeze so
        // footage/counts follow the visible geometry again (live-session rules).
        permDeriveFrozenRef.current = false;
        setPermanentSatLines((pl) => ({ ...pl, [type]: updater(pl[type]) }));
      };
    }
    return setSatelliteC9Lines;
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
  useEffect(() => {
    if (form.serviceType !== 'permanent') return;
    if (permDeriveFrozenRef.current) return; // #142: rehydrated, untouched — saved values win
    const t = {} as Record<PermanentSideKey, { footage: number | null; corners: number | null }>;
    for (const side of PERMANENT_SIDES) {
      const lines = permanentSatLines[side];
      const has = lines.length > 0;
      const m = deriveSideMeasure(lines, satelliteFeetPerPixel, satelliteAspect);
      t[side] = {
        footage: has ? m.footage : hadPermLinesRef.current[side] ? 0 : null,
        corners: has ? m.corners : hadPermLinesRef.current[side] ? 0 : null,
      };
      hadPermLinesRef.current[side] = has;
    }
    queueMicrotask(() =>
      setForm((f) => {
        if (f.serviceType !== 'permanent') return f;
        const p = f.permanent;
        let n = p;
        if (t.front.footage != null && n.frontFootage !== t.front.footage) n = { ...n, frontFootage: t.front.footage };
        if (t.front.corners != null && n.frontCorners !== t.front.corners) n = { ...n, frontCorners: t.front.corners };
        if (t.left.footage != null && n.leftFootage !== t.left.footage) n = { ...n, leftFootage: t.left.footage };
        if (t.left.corners != null && n.leftCorners !== t.left.corners) n = { ...n, leftCorners: t.left.corners };
        if (t.right.footage != null && n.rightFootage !== t.right.footage) n = { ...n, rightFootage: t.right.footage };
        if (t.right.corners != null && n.rightCorners !== t.right.corners) n = { ...n, rightCorners: t.right.corners };
        if (t.back.footage != null && n.backFootage !== t.back.footage) n = { ...n, backFootage: t.back.footage };
        if (t.back.corners != null && n.backCorners !== t.back.corners) n = { ...n, backCorners: t.back.corners };
        return n === p ? f : { ...f, permanent: n };
      }),
    );
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

  // #142: REHYDRATE the satellite tab on a reopened permanent quote. The design
  // row persists everything the tab needs (image path → signed URL, the four
  // side traces, the pull scale), so a saved quote's lines come back EDITABLE
  // instead of a blank tab that needed a fresh (billable) address re-pull.
  // Derives stay FROZEN until the operator actually edits (see
  // permDeriveFrozenRef above) — loading a quote must never move its numbers.
  useEffect(() => {
    if (!editMode || form.serviceType !== 'permanent') return;
    if (!designId || satellitePreview != null) return; // live session already
    let stale = false;
    (async () => {
      try {
        const res = await fetch(`/api/designs/${designId}`);
        if (!res.ok) return;
        const data = await res.json();
        const d = data?.design;
        if (stale || !d?.satelliteUrl) return;
        const sl = d.satelliteLines ?? {};
        const lines: Record<PermanentSideKey, LineSegment[]> = {
          front: sl.front ?? [],
          left: sl.left ?? [],
          right: sl.right ?? [],
          back: sl.back ?? [],
        };
        if (!PERMANENT_SIDES.some((s) => lines[s].length > 0)) return; // nothing traced — keep the old blank-tab behavior
        permDeriveFrozenRef.current = true;
        for (const side of PERMANENT_SIDES) hadPermLinesRef.current[side] = lines[side].length > 0;
        setPermanentSatLines(lines);
        setSatelliteFeetPerPixel(d.satelliteFeetPerPixel ?? null);
        setSatellitePreview(d.satelliteUrl);
      } catch (err) {
        // Best-effort: a failed rehydrate just leaves the pre-#142 blank tab.
        console.error('[QuoteBuilder] satellite rehydrate failed:', err);
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

  const updateLineLabel = (type: LineType, lineIdx: number, label: string) => {
    const setter = getSetter(type);
    setter(lines => lines.map((line, i) => i === lineIdx ? { ...line, label } : line));
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
        : addMode === 'santas' ? 'new gutterline' : addMode === 'gingerbread' ? 'new ridgeline' : 'new c9 run',
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
    // A parked analysis context belongs to the PREVIOUS house — drop it.
    pendingContextRef.current = null;
  };

  // Manual satellite upload (#9): a second photo slot so manually-photographed
  // houses also carry a satellite into the design + training capture. No known
  // scale (unlike the Google pull) — staff trace the layout for training value
  // and type the footage manually; the existing img onLoad sets the aspect.
  const handleSatelliteSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    // Replacing an auto-measured Google satellite (known scale) discards its
    // measurement — confirm before clobbering it. Manual-over-manual is silent.
    if (satellitePreview != null && satelliteFeetPerPixel != null) {
      const ok = window.confirm(
        'Replace the Google satellite (with its measured scale) with this uploaded image? The traced roofline + footage will reset.',
      );
      if (!ok) { input.value = ''; return; }
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : null;
      input.value = ''; // allow re-picking the same file
      if (!dataUrl) return;
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const mediaType = file.type.startsWith('image/') ? file.type : 'image/jpeg';
      setSatellitePreview(dataUrl);
      setSatelliteSantasLines([]);
      setSatelliteGingerbreadLines([]);
      setSatelliteC9Lines([]);
      setSatelliteStakeLines([]);
      setSatelliteFeetPerPixel(null); // manual = no known scale
      const satCtx = { satelliteBase64: base64, satelliteMediaType: mediaType, satelliteFeetPerPixel: null };
      // Read the CURRENT design id (L6) — a design may have been created while
      // this FileReader was decoding. uploadDesignSatellite also clears the
      // design's stale satellite_lines so a captured example can't overlay old
      // Google lines on the new image (M4).
      const id = designIdRef.current;
      if (id) {
        void pushAnalysisContext(id, satCtx);
      } else {
        pendingContextRef.current = { ...(pendingContextRef.current ?? {}), ...satCtx };
      }
    };
    reader.readAsDataURL(file);
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      if (data.result) {
        applyAnalysisResult(data);
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
    fewShotBreakdown?: { ranking?: 'similarity' | 'recency' };
  };
  const applyAnalysisResult = (data: AnalysisResponse) => {
    if (!data.result) return; // fail-safe: analyzer was unavailable, nothing to seed
    const r = data.result;
    // The AI's footage estimates pre-fill the inputs; satellite lines (when
    // present) take over via the measurement effect, and staff can always type.
    setForm(f => ({
      ...f,
      santasFootage: r.santasFootage,
      santasDifficulty: r.santasDifficulty,
      // #102: a fresh AI analysis sets a PRESET difficulty, so clear any stale
      // custom $/ft on these two types — keeps the difficulty + rate consistent.
      santasCustomRate: 0,
      gingerbreadFootage: r.gingerbreadFootage,
      gingerbreadDifficulty: r.gingerbreadDifficulty,
      gingerbreadCustomRate: 0,
    }));
    // Satellite polylines — seed them so the satellite tab is ready for
    // complex / commercial rooflines without re-analyzing. #97: only (re)set the
    // satellite tab when THIS analysis actually carried satellite data (an address
    // pull). A manual street-photo analyze (analyze-photo) carries none, so leave
    // the existing satellite image, lines, and scale intact.
    const hasSatelliteData =
      data.satelliteBase64 != null ||
      data.satelliteFeetPerPixel != null ||
      (r.satelliteSantasLines?.length ?? 0) > 0 ||
      (r.satelliteGingerbreadLines?.length ?? 0) > 0;
    if (hasSatelliteData) {
      setSatelliteSantasLines(r.satelliteSantasLines ?? []);
      setSatelliteGingerbreadLines(r.satelliteGingerbreadLines ?? []);
      setSatelliteFeetPerPixel(data.satelliteFeetPerPixel ?? null);
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
    const ctx: AnalysisContext = {
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
    setAnalysisNotes(`${r.notes} (confidence: ${r.confidence})`);
    setPhotoBase64(data.photoBase64 ?? null);
    setPhotoMediaType(data.photoMediaType ?? null);
    setFewShotCount(data.fewShotCount ?? 0);
    setFewShotRanking(data.fewShotBreakdown?.ranking ?? 'recency');
  };

  const handleLookupAddress = async () => {
    const addr = form.customer.address.trim();
    if (!addr) {
      setAnalysisError('Enter the property address above first.');
      return;
    }
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
      if (data.result) {
        applyAnalysisResult(data);
      } else {
        // Imagery loaded WITHOUT a holiday seed: either permanent (which skips the
        // holiday analyzer by design) or the fail-safe (analyzer down). The street
        // photo creates the design; the satellite + its scale stay for measuring.
        setPhotoBase64(data.photoBase64 ?? null);
        setPhotoMediaType(data.photoMediaType ?? null);
        setSatelliteFeetPerPixel(data.satelliteFeetPerPixel ?? null);
        setFewShotCount(0);
        setViewMode('design');
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
            permDeriveFrozenRef.current = false;
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
      setLookingUp(false);
    }
  };

  const handleAnalyzePhoto = async () => {
    if (!photoFile) return;
    // #88: permanent lighting designs MANUALLY — no holiday auto-measure/seed.
    // Load the uploaded photo into a bare design (no Anthropic call, no
    // santas/gingerbread roofline drawn) so the operator draws the permanent
    // roofline runs themselves. Mirrors the analyzer-outage fail-safe below.
    if (form.serviceType === 'permanent') {
      // Read the base64 from the File itself — photoPreview is a blob: object URL
      // (URL.createObjectURL), NOT a data URL, so it can't be split for base64.
      const base64 = await new Promise<string | null>((resolve) => {
        const r = new FileReader();
        r.onload = () => {
          const s = typeof r.result === 'string' ? r.result : '';
          const comma = s.indexOf(',');
          resolve(comma >= 0 ? s.slice(comma + 1) : null);
        };
        r.onerror = () => resolve(null);
        r.readAsDataURL(photoFile);
      });
      if (!base64) {
        setAnalysisError("Couldn't read that photo. Try selecting it again.");
        return;
      }
      pendingSeedRef.current = null;
      setAnalysisError(null);
      setAnalysisWarning(null);
      setPhotoBase64(base64);
      setPhotoMediaType(photoFile.type || 'image/jpeg');
      setFewShotCount(0);
      setViewMode('design');
      setAnalysisNotes(
        'Photo loaded. Billing footage comes from the Satellite tab draw (front/left/right/back) — an uploaded photo has no satellite, so use "Look up on Google Maps" for the auto-trace, or type the footage manually.',
      );
      return;
    }
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisWarning(null);
    setAnalysisNotes(null);

    const fd = new FormData();
    fd.append('photo', photoFile);

    try {
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
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
        setPhotoBase64(data.photoBase64 ?? null);
        setPhotoMediaType(data.photoMediaType ?? null);
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
    setHighLevelContact(c);
    const hlName = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ');
    const hlAddress = [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(', ');
    setForm(f => ({
      ...f,
      customer: {
        name: hlName || f.customer.name,
        phone: c.phone || f.customer.phone,
        email: c.email || f.customer.email,
        address: hlAddress || f.customer.address,
      },
    }));
    // Reset attach status — the previous attach (if any) was against a
    // different contact and doesn't apply anymore.
    setAttachStatus('idle');
    setAttachError(null);
  };

  const clearHighLevelContact = () => {
    setHighLevelContact(null);
    setAttachStatus('idle');
    setAttachError(null);
  };

  // Attach this quote's existing HL opportunity. Called async after save;
  // failures don't block the quote from displaying.
  const attachQuoteToHighLevel = async (quoteId: string, contactId: string) => {
    setAttachStatus('attaching');
    setAttachError(null);
    try {
      const res = await fetch('/api/integrations/highlevel/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId,
          contactId,
          opportunityName: form.customer.address.trim()
            ? `Holiday Lights — ${form.customer.address.trim()}`
            : undefined,
          // #107: the GHL card carries the "Full Yule" ceiling pre-approval (the
          // deposit webhook later resets it to the customer's actual selection).
          monetaryValue: result?.fullYule?.total ?? result?.total,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Attach failed (${res.status})`);
      setAttachStatus('attached');
    } catch (err) {
      setAttachStatus('error');
      setAttachError(err instanceof Error ? err.message : 'Attach failed');
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
    if (!savedQuoteId) return;
    setSendStatus('sending');
    setSendError(null);
    setSendBlockedMsg(null);
    setGhlSyncWarning(null);
    setCopiedUrl(false);

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
      const res = await fetch(`/api/quotes/${savedQuoteId}/send`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Send failed (${res.status})`);
      setSendStatus('sent');
      // The quote is sent locally regardless; surface a non-blocking warning if
      // the HighLevel "Bid Sent" stage move didn't go through, so the operator
      // doesn't wrongly believe the CRM card advanced.
      setGhlSyncWarning(
        data.ghlSynced === false
          ? (data.stageError ?? 'The HighLevel card may not have advanced to Bid Sent.')
          : null,
      );
      // Auto-capture (#8 Stage A / #141): sending = staff vouching the design
      // is right, so the staff-final state becomes a training example
      // (replaces this quote's previous auto snapshot on a re-send).
      // Best-effort. Positive gate: permanent quotes teach the SEPARATE
      // permanent-analyzer library, never the holiday one.
      if (form.serviceType === 'permanent') {
        void capturePermanentExample('auto-send');
      } else {
        void captureExample('auto-send');
      }
    } catch (err) {
      setSendStatus('error');
      setSendError(err instanceof Error ? err.message : 'Send failed');
    }
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
    } catch (err) {
      // It was already sent; only the sync retry failed.
      setSendStatus('sent');
      setGhlSyncWarning(err instanceof Error ? err.message : 'CRM sync retry failed.');
    }
  };

  // Run the quote calculation. `rooflineChoiceOverride` lets the breakdown's
  // staff-pick radios re-quote with a specific Santa's/Gingerbread choice
  // (#17 Phase 1b) without waiting on the async form-state update.
  const runQuote = async (
    rooflineChoiceOverride?: RooflineChoice,
    // #104: an explicit form snapshot to price with (bypasses async form state,
    // like rooflineChoiceOverride) when a click-to-edit commit re-prices in place
    // and may also clear the #102 $/ft on that line.
    formOverride?: QuoteFormData,
  ) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setAttachStatus('idle');
    setAttachError(null);
    setSendStatus('idle');
    setSendError(null);
    setCopiedUrl(false);
    setTrainStatus('idle');
    setTrainError(null);

    // Once a quote exists (edit mode, or any Calculate after the first on a
    // new quote), recalculating UPDATES that row in place — no more duplicate
    // rows piling up in /admin/quotes (#31).
    const existingQuoteId = savedQuoteId;
    const inputs = buildQuoteInputs(formOverride ?? form, rooflineChoiceOverride);

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
          return;
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
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data.result);
      setBaselineResult(data.baseline ?? data.result); // #104 "was $X" source
      const newQuoteId = typeof data.quoteId === 'string' ? data.quoteId : null;
      // Only overwrite savedQuoteId on a real id (#110 W3-004 / #80-105). A 200
      // response with quoteId:null means the server-side save/update failed
      // (e.g. a transient Supabase error on an in-place re-price) — nulling a
      // previously-valid id here would orphan that row and make the next
      // Calculate INSERT a duplicate instead of updating it. Mirrors the same
      // guard already used by recommendRoofline below.
      if (newQuoteId) setSavedQuoteId(newQuoteId);
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
      if (designId && (holidaySatelliteActive || permanentSatelliteActive)) {
        const satelliteLines = permanentSatelliteActive
          ? {
              front: permanentSatLines.front,
              left: permanentSatLines.left,
              right: permanentSatLines.right,
              back: permanentSatLines.back,
            }
          : {
              santas: satelliteSantasLines,
              gingerbread: satelliteGingerbreadLines,
              c9: satelliteC9Lines,
              stake: satelliteStakeLines,
              ...(satFootage.santas != null ? { santasFootage: satFootage.santas } : {}),
              ...(satFootage.ginger != null ? { gingerbreadFootage: satFootage.ginger } : {}),
            };
        void fetch(`/api/designs/${designId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ satelliteLines }),
        }).catch(() => {});
      }
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
      // Attach to HL opportunity in parallel, if an HL contact was picked
      // (skipped when this quote+contact pair is already attached).
      const attachKey = newQuoteId && highlevelContact?.id ? `${newQuoteId}:${highlevelContact.id}` : null;
      if (attachKey && newQuoteId && highlevelContact?.id && lastAttachKey.current !== attachKey) {
        lastAttachKey.current = attachKey;
        void attachQuoteToHighLevel(newQuoteId, highlevelContact.id);
      } else if (highlevelContact?.id && !newQuoteId) {
        // Quote wasn't persisted (Supabase not configured). Tell the
        // operator the HL link won't be made either.
        setAttachStatus('skipped');
        setAttachError('Quote not persisted — HighLevel link skipped. Check Supabase config.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
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
        body: JSON.stringify({ customer: form.customer, serviceType: form.serviceType, inputs, quoteId: savedQuoteId ?? undefined, designId: designId ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data.result);
      setBaselineResult(data.baseline ?? data.result); // #104
      if (typeof data.quoteId === 'string') setSavedQuoteId(data.quoteId);
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
  // gates at its frozen snapshot minimumJobAmount, not the holiday $1,000.
  const breakdownMinimum =
    form.serviceType === 'permanent'
      ? result?.permanentRatesSnapshot?.minimumJobAmount ?? 2500
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
        body: JSON.stringify({ scene: patched }),
      });
      if (!putRes.ok) {
        const putData = await putRes.json().catch(() => ({}));
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
      <div className="max-w-3xl mx-auto">

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
          {editMode && (
            <p className="text-xs text-gray-500 mt-1">
              Editing saved quote <span className="font-mono">{quoteNumber != null ? `#${quoteNumber}` : initialQuote?.quoteId.slice(0, 8)}</span> —
              Calculate updates this quote in place{initialQuote?.approvedAt
                ? '. ⚠️ The customer already APPROVED this quote; edits change what their portal shows.'
                : initialQuote?.sentAt
                  ? '. ⚠️ This quote was already sent; edits change what the customer sees on their portal.'
                  : '.'}
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
            <p className="text-xs text-amber-600 mb-3">
              Testing mode — name / phone / email are optional. Address is optional too, but helps if you want to tie the quote to a real property.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={lbl}>Name</label>
                <input className={inp} placeholder="Jane Smith (optional)"
                  value={form.customer.name} onChange={e => setCustomer('name', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Phone</label>
                <input className={inp} placeholder="(516) 555-0123"
                  value={form.customer.phone} onChange={e => setCustomer('phone', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Email</label>
                <input className={inp} type="email" placeholder="jane@example.com"
                  value={form.customer.email} onChange={e => setCustomer('email', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Property Address</label>
                <input className={inp} placeholder="123 Main St, Smithtown, NY 11787"
                  value={form.customer.address} onChange={e => setCustomer('address', e.target.value)} />
              </div>
            </div>

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
                      onClick={() => setForm(f => ({ ...f, serviceType: st }))}
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
                Holiday = seasonal install + takedown · Permanent = year-round · Event = date-driven (weddings, parties).
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
            <p className="text-xs text-gray-400 mb-3">
              {form.serviceType === 'permanent'
                ? 'Look up the address on Google Maps — the satellite auto-trace draws the four side rooflines (editable), and footage/corners/extensions follow the lines. Or upload a photo and draw/type manually.'
                : 'Look up the address on Google Maps (Street View + satellite) or upload a photo. Claude will estimate front gutterline, ridge + sides, bushes, trees, and columns.'}
            </p>

            {/* Google lookup — pulls Street View + satellite. Permanent skips the
                holiday analyzer (imagery only) so it never designs as Christmas. */}
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm font-medium text-blue-900">Look up on Google Maps</span>
                <button
                  type="button"
                  onClick={handleLookupAddress}
                  disabled={lookingUp || !form.customer.address.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-medium text-sm px-4 py-2 rounded-md whitespace-nowrap"
                >
                  {lookingUp ? 'Looking up…' : '🏠 Analyze from Address'}
                </button>
              </div>
              <p className="text-xs text-blue-700">
                {form.serviceType === 'permanent'
                  ? 'Uses the Property Address above. Fetches Street View + satellite (with scale) so you draw the permanent roofline on a real photo.'
                  : 'Uses the Property Address above. Fetches Street View + satellite view, sends both to Claude.'}
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
                className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
              />
              {photoPreview && photoFile && (
                <div className="space-y-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoPreview} alt="House preview" className="w-48 h-auto rounded-md border border-gray-200" />
                  <button
                    type="button"
                    onClick={handleAnalyzePhoto}
                    disabled={analyzing}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-medium py-2 px-4 rounded-md text-sm"
                  >
                    {analyzing ? 'Analyzing…' : form.serviceType === 'permanent' ? 'Load photo to design' : 'Analyze with Claude'}
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
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleSatelliteSelect}
                  className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
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
                    {form.serviceType === 'permanent'
                      ? 'Photo loaded for the design canvas.'
                      : 'Analysis complete — measurements auto-filled, roofline drawn on the design.'}
                    {fewShotCount > 0 && (
                      <span className="ml-1 font-normal">
                        • Using {fewShotCount} {fewShotRanking === 'similarity' ? 'similar' : 'recent'} past example{fewShotCount === 1 ? '' : 's'} as reference
                      </span>
                    )}
                  </strong>
                  {analysisNotes}
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
                {form.serviceType !== 'permanent' && satelliteFeetPerPixel != null && (
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
                      <button type="button" disabled={recapturing}
                        onClick={() => moveStreetView('left')}
                        title="Move the camera to the next panorama along the street (re-aims at the house)"
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ Along street
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => moveStreetView('right')}
                        title="Move the camera to the next panorama along the street (re-aims at the house)"
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Along street ▶
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) - 30 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ Rotate −30°
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) - 10 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ −10°
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) + 10 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        +10° ▶
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) + 30 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Rotate +30° ▶
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ pitch: Math.min(90, svPitch + 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ▲ Tilt Up
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ pitch: Math.max(-90, svPitch - 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ▼ Tilt Down
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ fov: Math.min(120, svFov + 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        − Zoom Out
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ fov: Math.max(30, svFov - 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        + Zoom In
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: null, pitch: 0, fov: 80 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Reset
                      </button>
                      <button type="button" disabled={analyzing || recapturing}
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
                        <button type="button" disabled={savingVantage || recapturing}
                          onClick={() => void saveVantageAsExtra('left')}
                          title="Fetch the next panorama to the left (aimed at the house) and add it as an extra photo of the design — the current photo stays put"
                          className="text-xs font-medium border border-green-300 hover:border-green-500 text-green-800 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                          📌 ◀ Save prev angle as extra photo
                        </button>
                        <button type="button" disabled={savingVantage || recapturing}
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
                {designId ? (
                  <>
                    <DesignEditor
                      key={designEditorKey}
                      designId={designId}
                      height={640}
                      permanentOnly={form.serviceType === 'permanent'}
                      onReady={(flush) => { editorFlushRef.current = flush; }}
                    />
                    {form.serviceType === 'permanent' ? (
                      <p className="text-xs text-gray-400 mt-2">
                        Drawing here is VISUAL (the portal shows these runs lit). Billing footage, corners
                        &amp; extensions come from the Satellite tab&apos;s side lines — auto-traced on address
                        lookup, hand-editable. Saves automatically and attaches to this quote on Calculate.
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-2">
                        Draw the install on the photo — roofline, minis, wreaths, garland, bows. The design IS the
                        quote&apos;s item list (Custom line items below are the escape hatch for anything it can&apos;t
                        represent). Saves automatically and attaches to this quote on Calculate.
                      </p>
                    )}
                    {/* #88: the "From your design" billable-items summary (minis/
                        spritzers/wreaths/garland/bows) is holiday/event only — a
                        permanent quote bills from the Permanent section, not drawn items. */}
                    {form.serviceType !== 'permanent' && (
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
                    {form.serviceType !== 'permanent' && (
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
                        {pendingPoints.length > 0 && (
                          <polyline
                            points={pendingPoints.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke={isPermanentSide(addMode ?? '') ? PERMANENT_SIDE_META[addMode as PermanentSideKey].color : addMode === 'santas' ? '#ef4444' : addMode === 'gingerbread' ? '#3b82f6' : addMode === 'stake' ? '#a855f7' : '#10b981'}
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
                      {pendingPoints.map(([x, y], i) => (
                        <div
                          key={`pp-${i}`}
                          className="absolute w-3 h-3 rounded-full border-2 border-white shadow"
                          style={{ left: `calc(${x * 100}% - 6px)`, top: `calc(${y * 100}% - 6px)`, backgroundColor: isPermanentSide(addMode ?? '') ? PERMANENT_SIDE_META[addMode as PermanentSideKey].color : addMode === 'santas' ? '#ef4444' : addMode === 'gingerbread' ? '#3b82f6' : addMode === 'stake' ? '#a855f7' : '#10b981' }}
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
                permDeriveFrozenRef.current = false; // #142: Recount = explicit re-derive
              }}
            />
          )}

          {form.serviceType !== 'permanent' && (
          <>
          {/* ── Santa's — Front Gutterline ── */}
          <div className={`transition-opacity ${form.santasFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Santa's — Front Gutterline (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">Auto-measured from photo. Adjust if needed.</p>
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
              <p className="text-xs text-gray-400 mb-3">Auto-measured from photo. Adjust if needed.</p>
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

          {/* ── Options ── holiday-only (takedown / rush / early-install). BOTH
              permanent AND event force these off in pricing (permanent uses the
              $2,500 gate, event carries no seasonal fees), so the whole section is
              hidden for either — event has its own dates in EventSection. Per-quote
              discount for permanent is a fast-follow (custom $/ft + custom line
              items cover v1 price flexibility). */}
          {form.serviceType !== 'permanent' && form.serviceType !== 'event' && (
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
                engine discount, and seeds the customer's portal install-timing. */}
            <div>
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
                        <p className="text-xs text-green-700 font-medium uppercase tracking-wide">Deposit Due Now</p>
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
                        disabled={loading}
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
                        disabled={loading}
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
                        disabled={recommendBusy}
                        onChange={() => void toggleDesignItemRecommended(sceneItemIds, !checked)}
                        aria-label={`Recommend ${item.label}`}
                        title="Recommend this item to the customer"
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
                      disabled={loading}
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
                  const rowInner = (
                    <>
                      <span className="flex items-center gap-2 text-gray-700">
                        {checkbox}
                        {item.label}
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
                  <span className="text-green-700">✓ Linked to {highlevelContact.fullName || 'HighLevel contact'}&rsquo;s pipeline card</span>
                )}
                {attachStatus === 'error' && (
                  <span className="text-red-600">HighLevel link failed: {attachError}. Sending will still copy the URL but won&rsquo;t move the pipeline stage.</span>
                )}
                {attachStatus === 'skipped' && (
                  <span className="text-amber-700">{attachError}</span>
                )}
              </div>
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
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500 flex-1">
                Click to copy the link AND move this quote to &ldquo;Bid Sent&rdquo; in HighLevel. Then paste the URL into your email / text to the customer.
              </p>
              <button
                type="button"
                onClick={handleSendToCustomer}
                disabled={sendStatus === 'sending' || hasUnfulfillable || (form.serviceType === 'event' && !eventDatesValid)}
                title={
                  form.serviceType === 'event' && !eventDatesValid
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

            {sendStatus === 'error' && (
              <p className="mt-3 text-sm text-red-600">
                Send failed: {sendError}. The portal URL is still valid — you can copy it manually and share.
              </p>
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

            {/* ── Training capture (#8 Stage A / #141 permanent) ── */}
            <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between gap-3">
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
          </div>
        )}

      </div>
    </OperatorShell>
  );
}
