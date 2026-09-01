'use client';

// The Simple Crew capture flow, replicated: full-screen live camera, the
// campaign name as a dropdown in the top bar, a shutter you can tap
// repeatedly, and a queue sheet over the viewfinder where each shot shows
// its upload state, resolves "Looking up address..." into the real street,
// and takes a per-photo note. Uploads run in the background so the worker
// keeps shooting; a failed shot stays in the queue with a retry.

import { useCallback, useEffect, useRef, useState } from 'react';

import { downscaleForUploadAsBlob, MULTIPART_SIZE_LIMIT_BYTES } from '@/lib/clientImage';
import {
  chipStateFor,
  COLD_FIX_OPTIONS,
  decideSend,
  GPS_TICK_MS,
  isFixFresh,
  MAX_SEND_ATTEMPTS,
  retryDelayMs,
  stampIsUsable,
  type GpsPermission,
  type SendOutcome,
} from './cameraGps';
import { decideCampaign, readRememberedCampaign, rememberCampaign, shouldAnnounceCarryOver } from './campaignMemory';
import { CloseIcon, FlashOffIcon, FlipCameraIcon, SearchIcon } from './icons';
import { describeRestoredBanner } from './photoQueueRestore';
import {
  deletePhoto,
  generatePhotoId,
  loadPendingPhotosForRestore,
  writePhoto,
  type StoredPhoto,
} from './photoQueueStorage';
import { PrimaryButton, SC, Sheet, timeAgo } from './ui';

type Campaign = { id: string; name: string; kind: 'yard_sign' | 'door_hanger'; lastPhotoAt: string | null };

type QueueItem = {
  key: string;
  previewUrl: string;
  /** The photo itself. Held so a failure can be RETRIED rather than
   * discarded: a worker in the field must never have to walk back to a
   * house and shoot a sign twice (Naldo, live incident 2026-08-31). */
  blob: Blob;
  /** waiting: the shot is held because there was no GPS fix yet or the
   * upload failed, and it retries itself. */
  status: 'uploading' | 'uploaded' | 'waiting' | 'failed';
  /** How many times this shot has been sent. */
  attempts: number;
  address: string | null;
  placementId: string | null;
  note: string;
  noteSaved: string;
  error?: string;
  /** The campaign this shot belongs to, fixed the moment it was taken.
   * Read from the ITEM, never from whichever campaign happens to be
   * selected right now: a retry, or a resume after reopening the app,
   * must always go to the right campaign even if the worker has since
   * switched campaigns in the top bar (Naldo, 2026-08-31, offline
   * durability). */
  campaignId: string;
  campaignName: string;
  /** When the shutter fired. Carried through to storage so a restore can
   * list photos in the order they were taken. */
  capturedAt: number;
};

/** The fields that never change for a given shot once it exists, needed
 * both to talk to the server and to write to durable storage. */
type ShotIdentity = { campaignId: string; campaignName: string; capturedAt: number };

export default function CameraScreen({
  campaignsUrl,
  submitUrl,
  noteBase,
  backHref,
  memoryScope,
  fromPageCampaignId = null,
}: {
  campaignsUrl: string;
  submitUrl: string;
  /** `${noteBase}/${placementId}/note` is the note PATCH endpoint. */
  noteBase: string;
  backHref: string;
  /** Keys the per-device campaign memory, so two accounts on one phone
   * cannot inherit each other's campaign. */
  memoryScope: string;
  /** Set when the worker opened the camera from a campaign's own page:
   * that campaign is used outright, with nothing to confirm. */
  fromPageCampaignId?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerChoice, setPickerChoice] = useState<string | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);
  // Set when a campaign was preselected from a memory older than the
  // freshness window: the name is shown and the shutter stays blocked
  // until the worker confirms it (Naldo's ruling, 2026-08-29).
  const [needsConfirm, setNeedsConfirm] = useState(false);
  // Set when the shutter is tapped while the campaign is unconfirmed: the
  // bar turns urgent instead of the tap doing nothing (staff lens HIGH).
  const [confirmNudge, setConfirmNudge] = useState(false);
  // A campaign carried over silently from the last hour still gets NAMED
  // for a few seconds, because the camera tab does not say which campaign
  // it resumed and a worker switching campaigns could otherwise shoot into
  // the wrong one without a signal (staff lens HIGH).
  const [carriedOver, setCarriedOver] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const uploading = queue.some((it) => it.status === 'uploading');

  // A navigation aborts in-flight uploads and the photo cannot ride
  // keepalive (multipart bodies blow its 64KB cap), so the guard is to not
  // leave silently: warn on tab-close while uploading, and make the X ask.
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  // Object URLs accumulate over a long shooting session; revoke on unmount
  // (and on dismiss below) so a 50-shot canvass cannot bloat the tab.
  const urlsRef = useRef<string[]>([]);
  // Photos the worker threw away, and the in-flight request for each live
  // shot. Without these, a discard removed the photo from the screen while
  // its retry loop kept running and uploaded it anyway: binned work still
  // became a paid placement, and the durable "a discarded photo cannot
  // come back" promise was false (technical lens HIGH).
  const discardedRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  // The position decided for each photo at its shutter, reused by every
  // retry so a held photo keeps the house it was shot at.
  const stampRef = useRef<Map<string, { lat: number; lng: number; accuracyM: number | null }>>(new Map());
  // Photos with a send loop already running. Without this, tapping try
  // now while the automatic retry was mid-backoff started a SECOND loop
  // for the same photo, and the capture route has no idempotency, so
  // both could land and the worker would be paid twice (integration
  // lens HIGH, S81 close).
  const sendingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return () => {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(campaignsUrl);
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { campaigns: Campaign[] };
        if (cancelled) return;
        setCampaigns(body.campaigns);
        // Open on the campaign the worker most likely means, and say so
        // rather than guessing silently when the memory has gone cold.
        const decision = decideCampaign({
          fromPageCampaignId,
          remembered: readRememberedCampaign(memoryScope),
          campaigns: body.campaigns,
          now: Date.now(),
        });
        if (decision.campaignId) {
          const chosen = body.campaigns.find((c) => c.id === decision.campaignId) ?? null;
          setCampaign(chosen);
          setNeedsConfirm(decision.needsConfirm);
          // shouldAnnounceCarryOver owns this rule so a test can pin it.
          if (chosen && shouldAnnounceCarryOver(decision, fromPageCampaignId)) setCarriedOver(chosen.name);
        }
      } catch {
        /* picker shows empty; capture still guards */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignsUrl, memoryScope, fromPageCampaignId]);

  // Live camera. Re-acquired when the facing mode flips.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCameraError(null);
      } catch {
        if (!cancelled) setCameraError('Camera access is blocked. Allow the camera for this site and reload.');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing]);

  // GPS. The browser only shows its location permission prompt when the
  // geolocation API is actually CALLED — a message telling the worker to
  // "allow location" with no call behind it prompts nothing (Naldo's device
  // round: shots failed and no prompt ever appeared). So a watchPosition
  // starts the moment the camera opens: the prompt fires before the first
  // shot, and the warm watch means the fix is already in hand at the
  // shutter. The status chip above the shutter shows which state we're in.
  const [gpsStatus, setGpsStatus] = useState<GpsPermission>('starting');
  const lastFixRef = useRef<{ lat: number; lng: number; accuracyM: number | null; at: number } | null>(null);
  // The chip must not claim "ready" on a fix the shutter would refuse
  // (staff lens + delta-verify on PR #1090): the tick re-checks the last
  // fix's age with the SAME isFixFresh rule getGps() uses, so a green
  // chip always means the warm fix will actually be reused.
  const [fixFresh, setFixFresh] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      setFixFresh(isFixFresh(lastFixRef.current?.at ?? null, Date.now()));
    }, GPS_TICK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let id: number | null = null;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      if (!navigator.geolocation) {
        setGpsStatus('unsupported');
        return;
      }
      id = navigator.geolocation.watchPosition(
        (pos) => {
          lastFixRef.current = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
            at: Date.now(),
          };
          setGpsStatus('ready');
          setFixFresh(true);
        },
        (err) => {
          // PERMISSION_DENIED (1) is sticky until the worker changes the site
          // setting; 2/3 are transient and the watch keeps trying, so only
          // downgrade to no_signal when we have no fix at all yet.
          if (err.code === 1) setGpsStatus('denied');
          else setGpsStatus((s) => (s === 'ready' ? s : 'no_signal'));
        },
        { enableHighAccuracy: true, maximumAge: 0 },
      );
    })();
    return () => {
      cancelled = true;
      if (id !== null) navigator.geolocation?.clearWatch(id);
    };
  }, []);

  // Both lenses converged here: at 25s a canvassing worker walks to the
  // NEXT house before the warm fix expires, so the shot inherits the
  // previous house's GPS. GPS_FRESH_MS (5s, in cameraGps.ts, shared with
  // the chip) keeps the drift inside ordinary GPS noise at walking pace
  // while still skipping the one-shot wait when the watch is streaming.
  const getGps = (): Promise<{ lat: number; lng: number; accuracyM: number | null } | null> => {
    const warm = lastFixRef.current;
    if (warm && isFixFresh(warm.at, Date.now())) {
      return Promise.resolve({ lat: warm.lat, lng: warm.lng, accuracyM: warm.accuracyM });
    }
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          }),
        () => resolve(null),
        COLD_FIX_OPTIONS,
      );
    });
  };

  // Read the status through a ref so the message inside shoot()'s stale
  // closure still reflects the CURRENT permission state.
  const gpsStatusRef = useRef(gpsStatus);
  useEffect(() => {
    gpsStatusRef.current = gpsStatus;
  }, [gpsStatus]);

  const gpsFailMessage = useCallback(
    () =>
      gpsStatusRef.current === 'denied'
        ? 'Location is blocked for this site. In your phone: browser settings, site settings, Location, Allow. Then reload this page.'
        : 'No GPS fix yet. Step outside or wait a few seconds for the signal, then retry.',
    [],
  );

  // Sending a shot, with the photo kept so a failure is recoverable. The
  // rule this exists for (Naldo, live incident 2026-08-31: a worker mid-run
  // losing roughly one shot in five): a photo that has been TAKEN is never
  // thrown away by the app. No GPS yet, no signal, a server hiccup, all of
  // it becomes "waiting" and retries itself, and the only way a photo
  // leaves the queue unsent is the worker deliberately discarding it.
  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

  /** One attempt at sending a shot. Returns what happened; decideSend
   * (cameraGps.ts, tested) decides what that means. */
  const attemptSend = useCallback(
    async (
      blob: Blob,
      campaignId: string,
      key: string,
      shutterAt: number,
    ): Promise<{ outcome: SendOutcome; placement?: { id: string; suggestedAddress: string | null } }> => {
      try {
        // The position is decided ONCE per photo, as close to the shutter
        // as the phone allows, and reused by every retry. Reading it again
        // at send time tagged a held photo wherever the worker had walked
        // to, which is the wrong house on a paid record (staff lens HIGH,
        // S81 close, against my own retry change).
        let gps = stampRef.current.get(key) ?? null;
        if (!gps) {
          const fresh = await getGps();
          if (fresh && stampIsUsable(shutterAt, Date.now())) {
            gps = fresh;
            stampRef.current.set(key, fresh);
          } else if (fresh) {
            // A fix arrived, but too long after the shutter to describe
            // that house. Refusing it is the honest answer: the photo is
            // held for the worker rather than tagged with a guess.
            return { outcome: { kind: 'stale_location' } };
          }
        }
        if (!gps) return { outcome: { kind: 'no_gps', denied: gpsStatusRef.current === 'denied' } };
        const file = new File([blob], 'shot.jpg', { type: 'image/jpeg' });
        const { blob: sized } = await downscaleForUploadAsBlob(file);
        if (sized.size > MULTIPART_SIZE_LIMIT_BYTES) return { outcome: { kind: 'too_large' } };
        const fd = new FormData();
        fd.set('campaignId', campaignId);
        fd.set('lat', String(gps.lat));
        fd.set('lng', String(gps.lng));
        if (gps.accuracyM !== null) fd.set('accuracyM', String(gps.accuracyM));
        // The time the SHUTTER fired, not the time this attempt runs.
        fd.set('capturedAt', new Date(shutterAt).toISOString());
        fd.set('photo', sized, 'proof.jpg');
        const controller = new AbortController();
        abortRef.current.set(key, controller);
        let res: Response;
        try {
          res = await fetch(submitUrl, { method: 'POST', body: fd, signal: controller.signal });
        } finally {
          abortRef.current.delete(key);
        }
        const body = (await res.json().catch(() => ({}))) as {
          placement?: { id: string; suggestedAddress: string | null };
          error?: string;
        };
        if (res.ok && body.placement) return { outcome: { kind: 'ok' }, placement: body.placement };
        return { outcome: { kind: 'refused', status: res.status, message: body.error } };
      } catch {
        return { outcome: { kind: 'network' } };
      }
    },
    [submitUrl],
  );

  // Sending a shot, with the photo KEPT so a failure is recoverable. The
  // rule this exists for (Naldo, live incident 2026-08-31: a worker mid-run
  // losing roughly one shot in five, every lost photo thrown away and
  // re-shot): a photo that has been taken is never discarded by the app.
  const runSend = useCallback(
    async (key: string, blob: Blob, stable: ShotIdentity): Promise<void> => {
      const set = (patch: Partial<QueueItem>) =>
        setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...patch } : it)));

      const persistStatus = (status: StoredPhoto['status'], attempts: number, error?: string) =>
        writePhoto({
          id: key,
          blob,
          campaignId: stable.campaignId,
          campaignName: stable.campaignName,
          note: '',
          capturedAt: stable.capturedAt,
          status,
          attempts,
          error,
        });

      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        // Checked before every attempt and after every await below, so a
        // discard landing mid-flight stops the next one.
        if (discardedRef.current.has(key)) return;
        set({ status: 'uploading', attempts: attempt, error: undefined });
        // Written BEFORE the network call starts, and waited on: if the app
        // dies mid-request, storage must already say "this might be
        // sending" so a restore treats it as ambiguous rather than as a
        // plain, safe-to-resend failure (photoQueueRestore.ts owns that
        // call; a photo that has really landed must never be sent twice).
        await persistStatus('uploading', attempt);
        const { outcome, placement } = await attemptSend(blob, stable.campaignId, key, stable.capturedAt);
        if (discardedRef.current.has(key)) return;
        const decision = decideSend(outcome, attempt);

        if (decision.action === 'done' && !placement) {
          // The send succeeded but we never saw the placement back. It may
          // have landed, so do NOT retry it silently: a second copy of a
          // photo is a second pay claim. Hand it to the worker to check.
          const message = 'Sent, but no confirmation came back. Check the campaign before sending again.';
          set({ status: 'failed', attempts: attempt, error: message });
          await persistStatus('failed', attempt, message);
          return;
        }
        if (decision.action === 'done' && placement) {
          set({
            status: 'uploaded',
            attempts: attempt,
            error: undefined,
            placementId: placement.id,
            address: placement.suggestedAddress,
          });
          // The durable fact of success is written BEFORE we try to
          // reclaim the space. If the delete below fails (a full quota, the
          // page dying mid-cleanup), the leftover record is left marked
          // 'uploaded' rather than looking like pending work: a landed
          // photo must never come back as something still to send.
          await persistStatus('uploaded', attempt);
          void deletePhoto(key);
          // Remember only what actually LANDED: a failed upload should not
          // teach the camera anything.
          rememberCampaign(memoryScope, stable.campaignId, Date.now());
          return;
        }
        if (decision.action === 'retry') {
          set({ status: 'waiting', attempts: attempt, error: decision.reason });
          await persistStatus('waiting', attempt, decision.reason);
          await sleep(retryDelayMs(attempt));
          if (discardedRef.current.has(key)) return;
          continue;
        }
        if (decision.action === 'hold') {
          // Kept, not dropped: the worker taps to send it again.
          set({ status: 'failed', attempts: attempt, error: decision.reason });
          await persistStatus('failed', attempt, decision.reason);
        }
        return;
      }
    },
    [attemptSend, memoryScope],
  );

  // One send loop per photo, ever. A second loop for the same shot (try
  // now tapped while the automatic retry sat in its backoff, or a
  // restore racing a live send) can land twice, and the capture route
  // has no idempotency, so the worker would be paid twice for one sign
  // (integration lens HIGH, S81 close).
  const sendShot = useCallback(
    async (key: string, blob: Blob, stable: ShotIdentity): Promise<void> => {
      if (sendingRef.current.has(key)) return;
      sendingRef.current.add(key);
      try {
        await runSend(key, blob, stable);
      } finally {
        sendingRef.current.delete(key);
      }
    },
    [runSend],
  );

  // Bring back anything still unsent from a previous session (Naldo,
  // 2026-08-31, offline durability): a force-quit, a phone reclaiming the
  // tab, or a plain reload must not lose a photo that was already taken.
  // Runs once per mount and does not wait on the campaign list or the
  // camera stream, since every restored photo already carries its own
  // campaign.
  const [restoredBanner, setRestoredBanner] = useState<string | null>(null);
  const restoredOnceRef = useRef(false);
  useEffect(() => {
    if (restoredOnceRef.current) return;
    restoredOnceRef.current = true;
    let cancelled = false;
    (async () => {
      const restored = await loadPendingPhotosForRestore();
      if (cancelled || restored.length === 0) return;
      setQueue((q) => [
        ...restored.map((r): QueueItem => {
          const previewUrl = URL.createObjectURL(r.blob);
          urlsRef.current.push(previewUrl);
          return {
            key: r.id,
            previewUrl,
            blob: r.blob,
            status: r.status,
            attempts: r.attempts,
            address: null,
            placementId: null,
            note: r.note,
            noteSaved: r.note,
            error: r.error,
            campaignId: r.campaignId,
            campaignName: r.campaignName,
            capturedAt: r.capturedAt,
          };
        }),
        ...q,
      ]);
      setRestoredBanner(describeRestoredBanner(restored));
      for (const r of restored) {
        // Only a photo whose last known state was a plain, already-seen
        // failure resumes on its own. One whose last state was mid-upload
        // is ambiguous and stays put until the worker checks and taps it.
        if (r.autoResume) {
          void sendShot(r.id, r.blob, {
            campaignId: r.campaignId,
            campaignName: r.campaignName,
            capturedAt: r.capturedAt,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sendShot]);

  const shoot = useCallback(async () => {
    if (!campaign) {
      setGuardOpen(true);
      return;
    }
    // A campaign carried over from more than an hour ago has to be
    // confirmed first: it decides what the photo is worth. The tap is never
    // swallowed silently, it points at the bar (staff lens HIGH).
    if (needsConfirm) {
      setConfirmNudge(true);
      return;
    }
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) return;

    const key = generatePhotoId();
    const capturedAt = Date.now();
    const previewUrl = URL.createObjectURL(blob);
    urlsRef.current.push(previewUrl);
    setQueue((q) => [
      {
        key,
        previewUrl,
        blob,
        status: 'uploading',
        attempts: 0,
        address: null,
        placementId: null,
        note: '',
        noteSaved: '',
        campaignId: campaign.id,
        campaignName: campaign.name,
        capturedAt,
      },
      ...q,
    ]);
    // Written the moment the shutter fires, before any upload is
    // attempted: losing power a second later must not lose the photo
    // (Naldo, 2026-08-31, offline durability). writePhoto never throws or
    // hangs (photoQueueStorage.ts), so a phone in private mode or a full
    // quota still shoots and uploads normally; it just is not durable.
    await writePhoto({
      id: key,
      blob,
      campaignId: campaign.id,
      campaignName: campaign.name,
      note: '',
      capturedAt,
      status: 'uploading',
      attempts: 0,
    });
    void sendShot(key, blob, { campaignId: campaign.id, campaignName: campaign.name, capturedAt });
  }, [campaign, needsConfirm, submitUrl, gpsFailMessage, memoryScope, sendShot]);

  const retryShot = useCallback(
    (item: QueueItem) => {
      setQueue((q) => q.map((it) => (it.key === item.key ? { ...it, status: 'uploading', error: undefined } : it)));
      void sendShot(item.key, item.blob, {
        campaignId: item.campaignId,
        campaignName: item.campaignName,
        capturedAt: item.capturedAt,
      });
    },
    [sendShot],
  );

  const discard = (item: QueueItem) => {
    // The question is different for a photo that may already have reached
    // the office: throwing that one away does NOT mean a walk back, and
    // this is the one place the copy must not be wrong (staff lens MED).
    const mayHaveLanded = (item.error ?? '').includes('may have already');
    const question = mayHaveLanded
      ? 'Throw this photo away? If it already reached the office it stays there. If it did not, this sign goes unrecorded.'
      : 'Throw this photo away? You would have to go back and shoot the sign again.';
    if (!window.confirm(question)) return;
    // Registered BEFORE anything else, and the request aborted, so an
    // in-flight retry stops now instead of landing after the bin.
    discardedRef.current.add(item.key);
    abortRef.current.get(item.key)?.abort();
    abortRef.current.delete(item.key);
    URL.revokeObjectURL(item.previewUrl);
    urlsRef.current = urlsRef.current.filter((u) => u !== item.previewUrl);
    setQueue((q) => q.filter((it) => it.key !== item.key));
    // The durable 'discarded' fact is written before the delete. If the
    // delete then fails (a full quota), the leftover record is left marked
    // discarded rather than looking like pending work, so a photo the
    // worker deliberately threw away cannot come back on the next restore.
    void writePhoto({
      id: item.key,
      blob: item.blob,
      campaignId: item.campaignId,
      campaignName: item.campaignName,
      note: item.note,
      capturedAt: item.capturedAt,
      status: 'discarded',
      attempts: item.attempts,
    }).then(() => deletePhoto(item.key));
  };

  const saveNote = async (item: QueueItem) => {
    if (!item.placementId || item.note === item.noteSaved) return;
    try {
      // keepalive: a worker often types the note and immediately switches
      // tabs; the browser must not cancel the save with the navigation.
      const res = await fetch(`${noteBase}/${item.placementId}/note`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: item.note || null }),
        keepalive: true,
      });
      if (res.ok) {
        setQueue((q) => q.map((it) => (it.key === item.key ? { ...it, noteSaved: it.note } : it)));
      }
    } catch {
      /* note retry on next blur */
    }
  };

  const filtered = campaigns.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white">
      {/* top bar */}
      <div className="flex items-center justify-between px-4 pb-3 pt-[max(env(safe-area-inset-top),14px)]">
        <button
          type="button"
          aria-label="Close camera"
          className="p-2"
          onClick={() => {
            if (uploading && !window.confirm('A photo is still uploading. Leaving now loses it. Leave anyway?')) {
              return;
            }
            window.location.href = backHref;
          }}
        >
          <CloseIcon size={26} />
        </button>
        <button
          type="button"
          onClick={() => {
            setPickerChoice(campaign?.id ?? null);
            setPickerOpen(true);
          }}
          className="flex items-center gap-2 text-xl font-semibold"
        >
          {campaign ? campaign.name : 'No Campaign Selected'}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <span className="p-2 opacity-90" aria-hidden>
          <FlashOffIcon size={26} />
        </span>
      </div>

      {/* viewfinder */}
      <div className="relative mx-2 flex-1 overflow-hidden rounded-3xl bg-[#111]">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {cameraError && (
          <p className="absolute inset-x-6 top-1/3 rounded-xl bg-black/70 p-4 text-center text-sm">{cameraError}</p>
        )}

        {/* queue sheet over the viewfinder */}
        {queue.length > 0 && (
          <div className="absolute inset-x-0 bottom-0 max-h-[55%] overflow-y-auto rounded-t-3xl bg-black/55 px-3 pb-3 pt-2 backdrop-blur-sm">
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/50" />
            {queue.map((item) => (
              <div key={item.key} className="mb-3 flex items-start gap-3">
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                  <img src={item.previewUrl} alt="Shot" className="h-full w-full object-cover" />
                  {item.status === 'uploading' && (
                    <span className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
                        <path d="M12 19V6M12 6l-5 5M12 6l5 5" />
                      </svg>
                    </span>
                  )}
                  {item.status === 'waiting' && (
                    <span
                      className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full text-xs"
                      style={{ background: SC.gold, color: '#0B140F' }}
                    >
                      ⏳
                    </span>
                  )}
                  {item.status === 'failed' && (
                    <span className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full" style={{ background: SC.danger }}>
                      !
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    {item.status === 'waiting' || item.status === 'failed' ? (
                      // Deliberately NOT truncated: the instruction sits at
                      // the end of this sentence, and a phone row cut it off
                      // after a dozen characters (staff lens MED).
                      <p className="text-base font-medium">Photo saved. {item.error ?? 'Waiting.'}</p>
                    ) : (
                      <p className="truncate text-lg font-medium">{item.address ?? 'Looking up address…'}</p>
                    )}
                    {item.status === 'failed' && (
                      <button type="button" onClick={() => retryShot(item)} className="text-sm underline">
                        try now
                      </button>
                    )}
                    {(item.status === 'waiting' || item.status === 'failed') && (
                      <button type="button" onClick={() => discard(item)} className="text-sm underline opacity-70">
                        discard
                      </button>
                    )}
                  </div>
                  {(item.status === 'waiting' || item.status === 'failed') && (
                    <p className="mt-0.5 text-sm text-white/70">For {item.campaignName}</p>
                  )}
                  <input
                    value={item.note}
                    onChange={(e) =>
                      setQueue((q) => q.map((it) => (it.key === item.key ? { ...it, note: e.target.value } : it)))
                    }
                    onBlur={() => void saveNote(item)}
                    placeholder={item.placementId ? "Take a note..." : "Note unlocks when the upload finishes"}
                    disabled={!item.placementId}
                    className="mt-1 w-full rounded-full border border-white/60 bg-transparent px-4 py-2.5 text-base placeholder-white/70 outline-none disabled:opacity-60"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Carried-over campaign, older than an hour: name it and block the
          shutter until the worker says yes. */}
      {campaign && needsConfirm && (
        <div
          className="mx-4 mb-1 flex flex-wrap items-center gap-2 rounded-2xl bg-white/95 px-4 py-3"
          style={confirmNudge ? { outline: `2px solid ${SC.danger}` } : undefined}
        >
          <span className="min-w-0 flex-1 text-sm" style={{ color: SC.text }}>
            {confirmNudge ? 'Answer this before you shoot: still ' : 'Still shooting '}
            <span className="font-semibold">{campaign.name}</span>?
          </span>
          <button
            type="button"
            onClick={() => {
              setNeedsConfirm(false);
              setConfirmNudge(false);
            }}
            className="rounded-full px-4 py-2 text-sm font-semibold text-white"
            style={{ background: SC.primaryDeep }}
          >
            Yes, continue
          </button>
          <button
            type="button"
            onClick={() => {
              setPickerChoice(campaign.id);
              setPickerOpen(true);
            }}
            className="rounded-full border px-4 py-2 text-sm"
            style={{ borderColor: '#DCD4BE', color: SC.text }}
          >
            Change
          </button>
        </div>
      )}

      {/* A campaign resumed from the last hour: say so, briefly, so the
          camera tab never shoots into yesterday's campaign unannounced. */}
      {carriedOver && !needsConfirm && (
        <div className="mx-4 mb-1 flex items-center gap-2 rounded-2xl bg-white/95 px-4 py-2">
          <span className="min-w-0 flex-1 text-sm" style={{ color: SC.text }}>
            Continuing <span className="font-semibold">{carriedOver}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setCarriedOver(null);
              setPickerChoice(campaign?.id ?? null);
              setPickerOpen(true);
            }}
            className="rounded-full border px-3 py-1.5 text-sm"
            style={{ borderColor: '#DCD4BE', color: SC.text }}
          >
            Change
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setCarriedOver(null)}
            className="rounded-full px-2 py-1.5 text-sm"
            style={{ color: SC.muted }}
          >
            OK
          </button>
        </div>
      )}

      {/* Photos that were still here from before the app closed (Naldo,
          2026-08-31, offline durability): said in plain words, so the
          worker knows nothing was lost, not just that the queue looks
          different than they expect. */}
      {restoredBanner && (
        <div className="mx-4 mb-1 flex items-center gap-2 rounded-2xl bg-white/95 px-4 py-3">
          <span className="min-w-0 flex-1 text-sm" style={{ color: SC.text }}>
            {restoredBanner}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setRestoredBanner(null)}
            className="rounded-full px-2 py-1.5 text-sm"
            style={{ color: SC.muted }}
          >
            OK
          </button>
        </div>
      )}

      {/* GPS status — the worker sees the location state BEFORE shooting */}
      <div className="flex justify-center px-6 pt-2">
        {(() => {
          const chip = chipStateFor(gpsStatus, fixFresh);
          if (chip === 'ready') {
            return (
              <span className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">
                <span className="h-2 w-2 rounded-full" style={{ background: '#4ADE80' }} /> GPS ready
              </span>
            );
          }
          if (chip === 'locating') {
            return (
              <span className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white/70" /> Getting your location…
              </span>
            );
          }
          return (
            <span className="rounded-full px-3 py-1 text-xs text-white" style={{ background: SC.danger }}>
              {chip === 'blocked'
                ? 'Location blocked. Allow it for this site in your browser settings, then reload'
                : 'This browser has no location support'}
            </span>
          );
        })()}
      </div>

      {/* bottom controls */}
      <div className="flex items-center justify-between px-8 pb-[max(env(safe-area-inset-bottom),18px)] pt-4">
        <span className="h-14 w-14" aria-hidden />
        <button
          type="button"
          aria-label="Take photo"
          aria-disabled={needsConfirm}
          onClick={() => void shoot()}
          className={`h-[74px] w-[74px] rounded-full border-4 bg-white ${
            needsConfirm ? 'border-white/30 opacity-40' : 'border-white/70 active:scale-95'
          }`}
        />
        <button
          type="button"
          aria-label="Flip camera"
          onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-black/50"
        >
          <FlipCameraIcon size={28} />
        </button>
      </div>

      {/* choose-campaign guard */}
      <Sheet open={guardOpen} onClose={() => setGuardOpen(false)}>
        <div className="px-2 pb-2 text-center" style={{ color: SC.text }}>
          <h2 className="text-xl font-bold">Choose at least 1 campaign to continue</h2>
          <p className="mt-2 text-base" style={{ color: SC.muted }}>
            You need to choose a campaign to upload photos to.
          </p>
          <div className="mt-5 flex gap-3">
            <a
              href={backHref}
              className="flex min-h-[52px] flex-1 items-center justify-center rounded-full border text-lg font-semibold"
              style={{ borderColor: SC.primary, color: SC.primary }}
            >
              Exit Camera
            </a>
            <div className="flex-1">
              <PrimaryButton
                onClick={() => {
                  setGuardOpen(false);
                  setPickerChoice(null);
                  setPickerOpen(true);
                }}
              >
                Select Campaign
              </PrimaryButton>
            </div>
          </div>
        </div>
      </Sheet>

      {/* campaign picker */}
      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)}>
        <div style={{ color: SC.text }}>
          <div className="flex items-center gap-2 rounded-full border px-4 py-3" style={{ borderColor: '#DCD4BE' }}>
            <SearchIcon size={20} className="opacity-50" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search.."
              className="w-full bg-transparent text-lg outline-none"
            />
          </div>
          <div className="mt-3 max-h-[45svh] overflow-y-auto">
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setPickerChoice(c.id)}
                className="flex w-full items-center justify-between py-3 text-left"
              >
                <span>
                  <span className="block text-xl font-semibold">{c.name}</span>
                  <span className="block text-base" style={{ color: SC.muted }}>
                    {c.lastPhotoAt ? `Last activity ${timeAgo(c.lastPhotoAt)}` : 'No activity yet'}
                  </span>
                </span>
                <span
                  className="h-7 w-7 rounded-full border-2"
                  style={
                    pickerChoice === c.id
                      ? { borderColor: SC.primary, background: SC.primary, boxShadow: 'inset 0 0 0 4px #fff' }
                      : { borderColor: '#C9C0A6' }
                  }
                />
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="py-6 text-center" style={{ color: SC.muted }}>
                No open campaigns.
              </p>
            )}
          </div>
          <div className="mt-4">
            <PrimaryButton
              disabled={!pickerChoice}
              onClick={() => {
                const chosen = campaigns.find((c) => c.id === pickerChoice) ?? null;
                setCampaign(chosen);
                setNeedsConfirm(false);
                setConfirmNudge(false);
                setCarriedOver(null);
                setPickerOpen(false);
              }}
            >
              Select Campaign
            </PrimaryButton>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
