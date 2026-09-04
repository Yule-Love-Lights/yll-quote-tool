'use client';

// Campaign detail (Simple Crew replica): a full-bleed map behind a draggable
// sheet with Description | Photos tabs, day-grouped photo cards (author,
// timestamp + address, big photo, note), and its own bottom nav — Map,
// Capture, My photos. Admin mode adds what Simple Crew never had: the money
// actions (Accept pays the stamped rate, Reject asks why) and duplicate
// flags on each card.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { BackIcon, DotsIcon, CameraIcon, EditIcon, MapFoldIcon, PersonIcon, PinIcon } from './icons';
import PlacementMap from './PlacementMap';
import { dollars, PrimaryButton, SC, Sheet, SHELL_MAX_PX } from './ui';
import { dollarsToCents } from '@/lib/hourlyRate';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { splitDuplicateSignals } from '@/components/admin/advertising/duplicateSignals';

export type DetailPlacement = {
  id: string;
  workerId: string;
  workerName?: string;
  kind: 'yard_sign' | 'door_hanger';
  status: 'pending' | 'accepted' | 'rejected' | 'resubmitted';
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  createdAt: string;
  suggestedAddress: string | null;
  rejectionReason: string | null;
  workerNote: string | null;
  acceptedRateCents: number | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  photoUrl: string | null;
  duplicates?: { id: string; status: string; workerName: string; reasons: string[] }[];
};

type Campaign = {
  id: string;
  name: string;
  kind: string;
  notes?: string | null;
  rateCents?: number;
  active?: boolean;
  /** admin only: EVERY row pointing at this campaign, counted by the same
   * function the server's delete guard uses, so the button and the guard can
   * never disagree (staff lens HIGH: they did, and the button became a
   * permanent dead end on any campaign with a voided photo).
   *
   * null means the count could not be read. Deleting is not offered then:
   * the destructive control fails CLOSED when we do not know. */
  placementTotal?: number | null;
};

const STATUS_CHIP: Record<DetailPlacement['status'], { text: string; bg: string; fg: string }> = {
  pending: { text: 'Pending', bg: '#F1EAD8', fg: '#3A423C' },
  resubmitted: { text: 'Resubmitted', bg: '#FDF3DF', fg: '#8a6d1f' },
  accepted: { text: 'Accepted', bg: '#E4F2E8', fg: '#2E7D4F' },
  rejected: { text: 'Rejected', bg: '#FBE7E7', fg: '#B3383F' },
};

export default function CampaignDetailScreen({
  mode,
  campaign,
  placementsUrl,
  backHref,
  captureHref,
  reviewUrl,
  editUrl,
}: {
  mode: 'worker' | 'admin';
  campaign: Campaign;
  placementsUrl: string;
  backHref: string;
  captureHref: string;
  /** admin only: the review POST endpoint. */
  reviewUrl?: string;
  /** admin only: the campaign PATCH endpoint. Its presence is what puts
   * the Edit control on screen, so a worker can never see one. */
  editUrl?: string;
}) {
  // The name and description are editable in place (Naldo, 2026-09-01:
  // there was no way to rename a campaign at all). The server prop is the
  // seed; a successful save updates these so the screen is right without a
  // reload. Deliberately NOT the rate: that is money config, it is stamped
  // onto every future acceptance, and it gets its own decision.
  const [name, setName] = useState(campaign.name);
  const [notes, setNotes] = useState(campaign.notes ?? '');
  const [editOpen, setEditOpen] = useState(false);
  const [draftName, setDraftName] = useState(campaign.name);
  const [draftNotes, setDraftNotes] = useState(campaign.notes ?? '');
  const [kind, setKind] = useState(campaign.kind);
  const [draftKind, setDraftKind] = useState(campaign.kind);
  const [rateCents, setRateCents] = useState(campaign.rateCents ?? 0);
  const [draftRate, setDraftRate] = useState(((campaign.rateCents ?? 0) / 100).toFixed(2));
  const [active, setActive] = useState(campaign.active ?? true);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);

  const [tab, setTab] = useState<'description' | 'photos'>('photos');
  const [view, setView] = useState<'map' | 'photos'>('map');
  const [placements, setPlacements] = useState<DetailPlacement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(placementsUrl);
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load photos.');
          return;
        }
        const body = (await res.json()) as { placements: DetailPlacement[] };
        if (cancelled) return;
        setPlacements(body.placements);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load photos.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [placementsUrl, tick]);

  // The photos still waiting to be reviewed, read from the feed this screen
  // already refreshes after every accept and reject. It was a number seeded
  // once at page load, which could silently suppress the re-pricing warning
  // this sheet exists for while the crew were submitting live (staff lens
  // HIGH).
  const pendingNow = placements.filter(
    (p) => (p.status === 'pending' || p.status === 'resubmitted') && !p.voidedAt,
  ).length;

  // The rate is compared as a NUMBER, the same way saveEdit decides what to
  // send. Comparing the typed string instead made "0.3" look like a change
  // from "0.30", which blocked Close and Delete while Save said there was
  // nothing to save: a dead end you could only leave by reopening the sheet
  // (delta-verify on the previous fix round). A rate that does not parse
  // counts as a change, because it is something the admin has to resolve
  // before anything else here makes sense.
  const draftRateCents = dollarsToCents(draftRate);
  const rateDiffers =
    draftRateCents === null ? draftRate.trim() !== (rateCents / 100).toFixed(2) : draftRateCents !== rateCents;
  const draftsDiffer =
    draftName.trim() !== name || draftNotes.trim() !== notes.trim() || draftKind !== kind || rateDiffers;

  const openEdit = () => {
    setDraftName(name);
    setDraftNotes(notes);
    setDraftKind(kind);
    setDraftRate((rateCents / 100).toFixed(2));
    setEditError(null);
    setEditNote(null);
    setEditOpen(true);
  };

  /** Every write to this campaign goes through here, so one place owns the
   * error handling and one place takes the server's answer as the truth. */
  const patchCampaign = async (body: Record<string, unknown>): Promise<boolean> => {
    if (!editUrl) return false;
    setSaving(true);
    setEditError(null);
    try {
      const res = await fetch(editUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: campaign.id, ...body }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        campaign?: { name: string; notes: string | null; kind: string; rateCents: number; active: boolean };
      };
      if (!res.ok) {
        setEditError(payload.error ?? 'Could not save the campaign.');
        return false;
      }
      // Take what the SERVER stored, not what was typed: it trims, and it
      // turns an empty description into null.
      if (payload.campaign) {
        setName(payload.campaign.name);
        setNotes(payload.campaign.notes ?? '');
        setKind(payload.campaign.kind);
        setRateCents(payload.campaign.rateCents);
        setActive(payload.campaign.active);
      }
      return true;
    } catch {
      setEditError('Could not save the campaign. Try again.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    setEditError(null);
    setEditNote(null);
    const nextRate = draftRateCents;
    if (nextRate === null) {
      setEditError('Enter the pay per accepted photo in dollars, like 0.30 or 2.50.');
      return;
    }

    // Only what actually CHANGED is sent. Sending everything every time made
    // a pure rename carry whatever rate this screen loaded with, which could
    // silently overwrite somebody else's newer rate, and made an unrelated
    // rename fail with a confusing message about the rate (technical and
    // admin lenses, PR #1185).
    const body: Record<string, unknown> = {};
    if (draftName.trim() !== name) body.name = draftName;
    if (draftNotes.trim() !== notes.trim()) body.notes = draftNotes;
    if (draftKind !== kind) body.kind = draftKind;

    if (nextRate !== rateCents) {
      // A rate is stamped at the MOMENT a photo is accepted, so this
      // re-prices everything still waiting. Naldo walked into exactly this:
      // 39 photos moving from $97.50 to $11.70 with nothing saying so.
      const lines = [`Change the pay from ${dollars(rateCents)} to ${dollars(nextRate)} per accepted photo?`];
      if (pendingNow > 0) {
        lines.push(
          '',
          `${pendingNow} photo${pendingNow === 1 ? ' is' : 's are'} still waiting to be reviewed on this campaign.`,
          `Accepting them after this pays ${dollars(nextRate * pendingNow)} in total instead of ${dollars(rateCents * pendingNow)}.`,
          '',
          'Photos already accepted keep what they were paid. This cannot be undone once they are accepted.',
        );
      }
      if (!window.confirm(lines.join('\n'))) return;
      body.rateCents = nextRate;
      // The rate this screen was showing. The server refuses if the stored
      // rate is not that one, instead of obeying a screen that has been open
      // while somebody else moved it.
      body.expectedRateCents = rateCents;
    }

    if (Object.keys(body).length === 0) {
      setEditNote('Nothing to save.');
      return;
    }

    const ok = await patchCampaign(body);
    if (ok) setEditOpen(false);
  };

  const toggleActive = async () => {
    // Close and Delete act immediately while the fields above are saved by
    // Save. Acting on one while the other holds typed edits threw those
    // edits away with no warning (staff lens HIGH).
    if (draftsDiffer) {
      setEditError('Save or undo your changes above first, then close the campaign.');
      return;
    }
    const closing = active;
    const waiting = pendingNow;
    const message = closing
      ? `Close "${name}"? The crew stop seeing it and cannot add photos.${
          waiting > 0
            ? ` Its ${waiting} photo${waiting === 1 ? ' waiting for review stays' : 's waiting for review stay'}, and can still be accepted and paid.`
            : ''
        } You can reopen it any time.`
      : `Reopen "${name}"? The crew will see it again and can add photos.`;
    if (!window.confirm(message)) return;
    const ok = await patchCampaign({ active: !active });
    if (ok) setEditNote(closing ? 'Campaign closed.' : 'Campaign reopened.');
  };

  const removeCampaign = async () => {
    if (!editUrl) return;
    if (draftsDiffer) {
      setEditError('Save or undo your changes above first, then delete the campaign.');
      return;
    }
    if (
      !window.confirm(
        `Delete "${name}" for good? This is only possible because no photos point at it. It cannot be undone.`,
      )
    ) {
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const res = await fetch(editUrl, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: campaign.id }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setEditError(payload.error ?? 'Could not delete the campaign.');
        return;
      }
      window.location.href = backHref;
    } catch {
      setEditError('Could not delete the campaign. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const act = async (payload: Record<string, unknown>, id: string) => {
    if (!reviewUrl) return;
    setBusy(id);
    try {
      const res = await fetch(reviewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Action failed.');
      } else {
        setError(null);
        // Clear the draft only when the action LANDED — a transient failure
        // must not force the admin to retype the reason (staff lens MED).
        setRejecting((r) => (r === id ? null : r));
        setReasons((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      reload();
    } catch {
      setError('Action failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const groups = useMemo(() => {
    const byDay = new Map<string, DetailPlacement[]>();
    for (const p of placements) {
      const day = etDayKey(new Date(p.capturedAt ?? p.createdAt));
      byDay.set(day, [...(byDay.get(day) ?? []), p]);
    }
    const todayKey = etDayKey(new Date());
    return [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, items]) => ({
        day,
        label: day === todayKey ? 'Today' : new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        items,
      }));
  }, [placements]);

  const markers = placements
    .filter((p) => p.lat !== null && p.lng !== null)
    .map((p) => ({
      id: p.id,
      lat: p.lat!,
      lng: p.lng!,
      status: p.voidedAt ? 'voided' : p.status,
      label: p.suggestedAddress ?? undefined,
    }));

  const fmtStamp = (p: DetailPlacement) => {
    const when = new Date(p.capturedAt ?? p.createdAt);
    const stamp = when.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    });
    return p.suggestedAddress ? `${stamp}, ${p.suggestedAddress}` : stamp;
  };

  return (
    <div className="flex min-h-[100svh] flex-col" style={{ background: SC.bg }}>
      {/* map layer (map view) or spacer (photos view) */}
      {view === 'map' ? (
        <div className="relative h-[42svh]">
          <PlacementMap markers={markers} height="100%" />
          <a
            href={backHref}
            aria-label="Back"
            className="absolute left-4 top-[max(env(safe-area-inset-top),14px)] z-[500] flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-md"
            style={{ color: SC.text }}
          >
            <BackIcon size={22} />
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),14px)]">
          <a
            href={backHref}
            aria-label="Back"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-md"
            style={{ color: SC.text }}
          >
            <BackIcon size={22} />
          </a>
        </div>
      )}

      {/* sheet */}
      <div className="relative z-10 -mt-4 flex-1 rounded-t-3xl bg-white pb-28">
        <div className="mx-auto mt-2 h-1.5 w-12 rounded-full" style={{ background: '#D9D1BC' }} />
        <div className="px-5 pt-3">
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 flex-1 text-2xl font-bold" style={{ color: SC.text }}>
              {name}
            </h1>
            {editUrl && (
              <button
                type="button"
                onClick={openEdit}
                aria-label="Edit campaign"
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                style={{ background: '#F1EAD8', color: SC.primary }}
              >
                <EditIcon size={18} />
              </button>
            )}
          </div>
          <div className="mt-2 flex gap-6 border-b" style={{ borderColor: '#EFE9D8' }}>
            {(['description', 'photos'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="flex items-center gap-2 pb-2 text-lg capitalize"
                style={
                  tab === t
                    ? { color: SC.text, boxShadow: `inset 0 -2.5px 0 ${SC.primary}`, fontWeight: 600 }
                    : { color: SC.muted }
                }
              >
                {t}
                {t === 'photos' && (
                  <span className="rounded-full px-2 py-0.5 text-sm" style={{ background: '#F1EBDB', color: SC.muted }}>
                    {placements.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="mx-5 mt-3 rounded-xl bg-red-50 px-4 py-2 text-sm" style={{ color: SC.danger }}>
            {error}
          </p>
        )}

        {tab === 'description' ? (
          <div className="px-5 py-4 text-base" style={{ color: SC.text }}>
            <p className="whitespace-pre-wrap">{notes.trim() || 'No description yet.'}</p>
            {mode === 'admin' && campaign.rateCents !== undefined && (
              <p className="mt-3" style={{ color: SC.muted }}>
                Pays {dollars(campaign.rateCents)} per accepted photo, stamped at acceptance.
              </p>
            )}
          </div>
        ) : (
          <div className="px-4 py-3">
            {groups.length === 0 && !error && (
              <p className="px-2 py-6 text-center" style={{ color: SC.muted }}>
                No photos yet.
              </p>
            )}
            {groups.map((g) => (
              <div key={g.day} className="mb-2">
                <div className="flex items-center gap-3 px-1 py-2">
                  <span className="text-xl font-bold" style={{ color: SC.text }}>
                    {g.label}
                  </span>
                  <span className="rounded-full px-3 py-1 text-sm" style={{ background: '#F1EBDB', color: SC.muted }}>
                    {g.items.length} photos
                  </span>
                </div>
                {g.items.map((p) => (
                  <div key={p.id} className="mb-4 overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: '#EFE9D8' }}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span
                        className="flex h-11 w-11 items-center justify-center rounded-full text-lg font-semibold"
                        style={{ background: '#F1EAD8', color: SC.muted }}
                      >
                        {(p.workerName ?? 'W').slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-lg font-semibold" style={{ color: SC.text }}>
                          {p.workerName ?? 'You'}
                        </span>
                        <span className="block truncate text-sm" style={{ color: SC.muted }}>
                          {fmtStamp(p)}
                        </span>
                      </span>
                      <span
                        className="rounded-full px-2.5 py-1 text-xs font-medium"
                        style={
                          p.voidedAt
                            ? { background: '#ECEAE4', color: SC.muted }
                            : { background: STATUS_CHIP[p.status].bg, color: STATUS_CHIP[p.status].fg }
                        }
                      >
                        {/* The money suffix is gated on voidedAt too, not just
                            the label above it: a voided-accepted row rendered
                            "Voided · $2.50" because this second conditional
                            was left untouched when the label was fixed. */}
                        {p.voidedAt ? 'Voided' : STATUS_CHIP[p.status].text}
                        {!p.voidedAt &&
                          p.status === 'accepted' &&
                          p.acceptedRateCents !== null &&
                          ` · ${dollars(p.acceptedRateCents)}`}
                      </span>
                      <DotsIcon size={20} className="shrink-0" />
                    </div>
                    {p.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                      <img src={p.photoUrl} alt="Placement proof" className="max-h-[420px] w-full object-cover" />
                    ) : (
                      <div className="flex h-40 items-center justify-center" style={{ background: '#F1EBDB', color: SC.muted }}>
                        photo unavailable
                      </div>
                    )}
                    <div className="px-4 py-3">
                      {p.workerNote && (
                        <p className="mb-2 text-base" style={{ color: SC.text }}>
                          {p.workerNote}
                        </p>
                      )}
                      {p.status === 'rejected' && p.rejectionReason && (
                        <p className="mb-2 text-sm" style={{ color: SC.danger }}>
                          {p.rejectionReason}
                        </p>
                      )}
                      {mode === 'admin' && (p.duplicates?.length ?? 0) > 0 && (() => {
                        // Split by signal strength (ops suggestions round): a
                        // busy worker's every sign matches its same-day
                        // siblings, so worker-day-only matches collapse to a
                        // count instead of drowning the real location and
                        // address hits.
                        const { strong, weakCount } = splitDuplicateSignals(p.duplicates!);
                        const parts = strong.map((d) => `${d.workerName} (${d.reasons.join(', ')})`);
                        if (weakCount > 0) parts.push(`${weakCount} more from the same worker that day`);
                        return (
                          <div className="mb-2 rounded-xl px-3 py-2 text-sm" style={{ background: '#FDF3DF', color: '#8a6d1f' }}>
                            Possible duplicates, your call: {parts.join(' · ')}
                          </div>
                        );
                      })()}
                      {/* Undo for a wrong accept (bulk-upload mistakes most
                          of all) is master's VOID, not a second mechanism:
                          it keeps the row and its stamped rate as history,
                          records why, and makes the row count for nothing. */}
                      {mode === 'admin' && !p.voidedAt && p.status === 'accepted' && (
                        <div className="mt-1">
                          <button
                            type="button"
                            disabled={busy === p.id}
                            onClick={() => {
                              const reason = window.prompt(
                                'Void this photo? It stops counting for pay and keeps this reason as the permanent record of why:',
                                'uploaded by mistake',
                              );
                              if (reason === null || !reason.trim()) return;
                              void act({ action: 'void', placementId: p.id, reason: reason.trim() }, p.id);
                            }}
                            className="rounded-full border px-4 py-2 text-sm disabled:opacity-50"
                            style={{ borderColor: '#DCD4BE', color: SC.muted }}
                          >
                            Void (stops the pay)
                          </button>
                        </div>
                      )}
                      {mode === 'admin' && !p.voidedAt && (p.status === 'pending' || p.status === 'resubmitted') && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy === p.id}
                            onClick={() => void act({ action: 'accept', placementId: p.id }, p.id)}
                            className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                            style={{ background: SC.ok }}
                          >
                            Accept (pays the rate)
                          </button>
                          {rejecting === p.id ? (
                            <>
                              <input
                                autoFocus
                                value={reasons[p.id] ?? ''}
                                onChange={(e) => setReasons((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                placeholder="Why? The worker sees this."
                                className="min-w-0 flex-1 rounded-full border px-3 py-2 text-sm"
                                style={{ borderColor: '#DCD4BE' }}
                              />
                              <button
                                type="button"
                                disabled={busy === p.id || !(reasons[p.id] ?? '').trim()}
                                onClick={() =>
                                  void act({ action: 'reject', placementId: p.id, reason: (reasons[p.id] ?? '').trim() }, p.id)
                                }
                                className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                                style={{ background: SC.danger }}
                              >
                                Reject
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setRejecting(p.id)}
                              className="rounded-full border px-4 py-2 text-sm"
                              style={{ borderColor: '#DCD4BE', color: SC.text }}
                            >
                              Reject…
                            </button>
                          )}
                        </div>
                      )}
                      {mode === 'worker' && p.status === 'rejected' && !p.voidedAt && (
                        <ResubmitButton placementId={p.id} onDone={reload} />
                      )}
                      {/* Void is available on EVERY live row, not just the
                          unreviewed ones: the case it exists for is a
                          mis-tapped Accept or a duplicate caught after
                          acceptance (delta-verify caught this button nested
                          inside the pending-only block). */}
                      {mode === 'admin' && !p.voidedAt && (
                        <div className="mt-1">
                          <button
                            type="button"
                            disabled={busy === p.id}
                            onClick={() => {
                              const reason = window.prompt(
                                p.status === 'accepted'
                                  ? 'Void this ACCEPTED placement? It stops counting for pay and stock. The sign still counts against the allotment, because it is in the ground. If the photo has been PAID, undo that payment first. Why? (required, permanent record)'
                                  : 'Void this placement? It stops counting for pay and stock. The sign still counts against the allotment. Why? (required, permanent record)',
                              );
                              if (reason && reason.trim()) {
                                void act({ action: 'void', placementId: p.id, reason: reason.trim() }, p.id);
                              }
                            }}
                            className="rounded-full border px-4 py-2 text-sm disabled:opacity-50"
                            style={{ borderColor: '#DCD4BE', color: SC.muted }}
                          >
                            Void…
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* the detail screen's own bottom nav: Map | Capture | My photos */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 mx-auto flex items-start justify-around border-t px-2 pb-[max(env(safe-area-inset-bottom),10px)] pt-2"
        style={{ background: '#fff', borderColor: '#EDE6D2', maxWidth: SHELL_MAX_PX }}
      >
        <DetailNavButton
          label="Map"
          active={view === 'map'}
          onClick={() => {
            setView('map');
            setTab('photos');
          }}
          icon={<MapFoldIcon size={24} />}
        />
        <a href={captureHref} className="flex flex-col items-center gap-1 px-4 py-1" style={{ color: '#3A423C' }}>
          <CameraIcon size={24} />
          <span className="text-sm">Capture</span>
        </a>
        <DetailNavButton
          label={mode === 'worker' ? 'My photos' : 'Photos'}
          active={view === 'photos'}
          onClick={() => {
            setView('photos');
            setTab('photos');
          }}
          icon={<PersonIcon size={24} />}
        />
      </nav>

      <Sheet open={editOpen} onClose={() => setEditOpen(false)}>
        <div style={{ color: SC.text }}>
          <h2 className="text-xl font-bold">Edit campaign</h2>
          <label className="mt-4 block text-sm" style={{ color: SC.muted }}>
            Name
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="mt-1 w-full rounded-xl border px-4 py-3 text-lg"
              style={{ borderColor: '#DCD4BE' }}
              placeholder="Fall yard signs"
            />
          </label>
          <label className="mt-3 block text-sm" style={{ color: SC.muted }}>
            Description
            <textarea
              value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              rows={4}
              className="mt-1 w-full rounded-xl border px-4 py-3 text-base"
              style={{ borderColor: '#DCD4BE' }}
              placeholder="What this campaign is for, and anything the crew should know."
            />
          </label>
          <div className="mt-3">
            <span className="block text-sm" style={{ color: SC.muted }}>
              Type
            </span>
            <div className="mt-1 flex gap-2">
              {(['yard_sign', 'door_hanger'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setDraftKind(k)}
                  className="flex-1 rounded-full border px-3 py-2.5 text-base font-medium"
                  style={
                    draftKind === k
                      ? { background: SC.primary, borderColor: SC.primary, color: '#fff' }
                      : { borderColor: '#DCD4BE', color: SC.text }
                  }
                >
                  {k === 'yard_sign' ? 'Yard signs' : 'Door hangers'}
                </button>
              ))}
            </div>
            <p className="mt-1 text-sm" style={{ color: SC.muted }}>
              Photos already taken keep the type they were taken under.
            </p>
          </div>

          <label className="mt-3 block text-sm" style={{ color: SC.muted }}>
            Pay per accepted photo ($)
            <input
              value={draftRate}
              onChange={(e) => setDraftRate(e.target.value)}
              inputMode="decimal"
              placeholder="0.30"
              className="mt-1 w-32 rounded-xl border px-4 py-3 text-lg"
              style={{ borderColor: '#DCD4BE' }}
            />
          </label>
          {pendingNow > 0 && (
            <p className="mt-1 text-sm" style={{ color: '#8a6d1f' }}>
              {pendingNow} photo{pendingNow === 1 ? ' is' : 's are'} still waiting to be reviewed. A photo is paid at
              whatever the rate is when you accept it, so changing this changes what they are worth.
            </p>
          )}
          {editError && (
            <p className="mt-3 text-sm" style={{ color: SC.danger }}>
              {editError}
            </p>
          )}
          {editNote && !editError && (
            <p className="mt-3 text-sm" style={{ color: SC.ok }}>
              {editNote}
            </p>
          )}
          <div className="mt-5">
            <PrimaryButton disabled={saving || !draftName.trim()} onClick={() => void saveEdit()}>
              {saving ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>

          <div className="mt-5 border-t pt-4" style={{ borderColor: '#EFE9D8' }}>
            <PrimaryButton tone="quiet" disabled={saving} onClick={() => void toggleActive()}>
              {active ? 'Close this campaign' : 'Reopen this campaign'}
            </PrimaryButton>
            <p className="mt-1 text-sm" style={{ color: SC.muted }}>
              {active
                ? 'Takes effect straight away, without Save. Closing hides it from the crew and stops new photos. Every photo and every payment stays, and you can reopen it.'
                : 'This campaign is closed. The crew cannot see it or add photos. Reopening takes effect straight away, without Save.'}
            </p>

            {campaign.placementTotal === null || campaign.placementTotal === undefined ? (
              <p className="mt-4 text-sm" style={{ color: SC.muted }}>
                Could not check whether anything points at this campaign, so deleting is not offered. Reload the
                page to try again.
              </p>
            ) : campaign.placementTotal === 0 ? (
              <div className="mt-4">
                <PrimaryButton tone="danger" disabled={saving} onClick={() => void removeCampaign()}>
                  Delete this campaign
                </PrimaryButton>
                <p className="mt-1 text-sm" style={{ color: SC.muted }}>
                  Nothing points at this campaign, so nothing is lost. This cannot be undone.
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm" style={{ color: SC.muted }}>
                This campaign cannot be deleted: {campaign.placementTotal} photo
                {(campaign.placementTotal ?? 0) === 1 ? '' : 's'} point at it, and that is somebody&apos;s work.
                Close it instead.
              </p>
            )}
          </div>
        </div>
      </Sheet>

      {/* map pin hint */}
      {view === 'map' && markers.length === 0 && (
        <p className="pointer-events-none fixed left-1/2 top-[20svh] z-20 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm text-white">
          <PinIcon size={14} className="mr-1 inline" /> No GPS points yet
        </p>
      )}
    </div>
  );
}

function DetailNavButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-2xl px-4 py-1"
      style={active ? { color: SC.primary, background: '#F1EAD8' } : { color: '#3A423C' }}
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  );
}

function ResubmitButton({ placementId, onDone }: { placementId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/advertising/placements/${placementId}/resubmit`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not resubmit.');
        return;
      }
      onDone();
    } catch {
      setError('Could not resubmit. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void resubmit()}
        className="rounded-full border px-4 py-2 text-sm disabled:opacity-50"
        style={{ borderColor: '#DCD4BE', color: SC.text }}
      >
        {busy ? 'Sending…' : 'Ask for another look'}
      </button>
      {error && (
        <p className="mt-1 text-xs" style={{ color: SC.danger }}>
          {error}
        </p>
      )}
    </div>
  );
}
