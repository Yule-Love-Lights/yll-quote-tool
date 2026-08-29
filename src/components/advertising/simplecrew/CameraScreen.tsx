'use client';

// The Simple Crew capture flow, replicated: full-screen live camera, the
// campaign name as a dropdown in the top bar, a shutter you can tap
// repeatedly, and a queue sheet over the viewfinder where each shot shows
// its upload state, resolves "Looking up address..." into the real street,
// and takes a per-photo note. Uploads run in the background so the worker
// keeps shooting; a failed shot stays in the queue with a retry.

import { useCallback, useEffect, useRef, useState } from 'react';

import { downscaleForUploadAsBlob, MULTIPART_SIZE_LIMIT_BYTES } from '@/lib/clientImage';
import { CloseIcon, FlashOffIcon, FlipCameraIcon, SearchIcon } from './icons';
import { PrimaryButton, SC, Sheet, timeAgo } from './ui';

type Campaign = { id: string; name: string; kind: 'yard_sign' | 'door_hanger'; lastPhotoAt: string | null };

type QueueItem = {
  key: string;
  previewUrl: string;
  status: 'uploading' | 'uploaded' | 'failed';
  address: string | null;
  placementId: string | null;
  note: string;
  noteSaved: string;
  error?: string;
};

export default function CameraScreen({
  campaignsUrl,
  submitUrl,
  noteBase,
  backHref,
}: {
  campaignsUrl: string;
  submitUrl: string;
  /** `${noteBase}/${placementId}/note` is the note PATCH endpoint. */
  noteBase: string;
  backHref: string;
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
        if (!cancelled) setCampaigns(body.campaigns);
      } catch {
        /* picker shows empty; capture still guards */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignsUrl]);

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
  const [gpsStatus, setGpsStatus] = useState<'starting' | 'ready' | 'denied' | 'no_signal' | 'unsupported'>('starting');
  const lastFixRef = useRef<{ lat: number; lng: number; accuracyM: number | null; at: number } | null>(null);

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

  const GPS_FRESH_MS = 25_000;

  const getGps = (): Promise<{ lat: number; lng: number; accuracyM: number | null } | null> => {
    const warm = lastFixRef.current;
    if (warm && Date.now() - warm.at < GPS_FRESH_MS) {
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
        { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
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

  const shoot = useCallback(async () => {
    if (!campaign) {
      setGuardOpen(true);
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

    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const previewUrl = URL.createObjectURL(blob);
    urlsRef.current.push(previewUrl);
    setQueue((q) => [{ key, previewUrl, status: 'uploading', address: null, placementId: null, note: '', noteSaved: '' }, ...q]);

    // Background upload — the shutter stays live.
    void (async () => {
      const fail = (message: string) =>
        setQueue((q) => q.map((it) => (it.key === key ? { ...it, status: 'failed', error: message } : it)));
      try {
        const gps = await getGps();
        if (!gps) return fail(gpsFailMessage());
        const file = new File([blob], 'shot.jpg', { type: 'image/jpeg' });
        const { blob: sized } = await downscaleForUploadAsBlob(file);
        if (sized.size > MULTIPART_SIZE_LIMIT_BYTES) return fail('Photo too large even after compression.');
        const fd = new FormData();
        fd.set('campaignId', campaign.id);
        fd.set('lat', String(gps.lat));
        fd.set('lng', String(gps.lng));
        if (gps.accuracyM !== null) fd.set('accuracyM', String(gps.accuracyM));
        fd.set('capturedAt', new Date().toISOString());
        fd.set('photo', sized, 'proof.jpg');
        const res = await fetch(submitUrl, { method: 'POST', body: fd });
        const body = (await res.json().catch(() => ({}))) as {
          placement?: { id: string; suggestedAddress: string | null };
          error?: string;
        };
        if (!res.ok || !body.placement) return fail(body.error ?? 'Upload failed. Retry.');
        setQueue((q) =>
          q.map((it) =>
            it.key === key
              ? { ...it, status: 'uploaded', placementId: body.placement!.id, address: body.placement!.suggestedAddress }
              : it,
          ),
        );
      } catch {
        fail('Upload failed. Check your connection and retry.');
      }
    })();
  }, [campaign, submitUrl, gpsFailMessage]);

  const retry = (item: QueueItem) => {
    // A failed shot never made a placement; drop it and let the worker
    // reshoot (the sign is right in front of them).
    URL.revokeObjectURL(item.previewUrl);
    urlsRef.current = urlsRef.current.filter((u) => u !== item.previewUrl);
    setQueue((q) => q.filter((it) => it.key !== item.key));
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
                  {item.status === 'failed' && (
                    <span className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full" style={{ background: SC.danger }}>
                      !
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-lg font-medium">
                      {item.status === 'failed'
                        ? (item.error ?? 'Upload failed')
                        : (item.address ?? 'Looking up address…')}
                    </p>
                    {item.status === 'failed' && (
                      <button type="button" onClick={() => retry(item)} className="text-sm underline">
                        dismiss
                      </button>
                    )}
                  </div>
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

      {/* GPS status — the worker sees the location state BEFORE shooting */}
      <div className="flex justify-center px-6 pt-2">
        {gpsStatus === 'ready' && (
          <span className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">
            <span className="h-2 w-2 rounded-full" style={{ background: '#4ADE80' }} /> GPS ready
          </span>
        )}
        {(gpsStatus === 'starting' || gpsStatus === 'no_signal') && (
          <span className="flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white/70" /> Getting your location…
          </span>
        )}
        {(gpsStatus === 'denied' || gpsStatus === 'unsupported') && (
          <span className="rounded-full px-3 py-1 text-xs text-white" style={{ background: SC.danger }}>
            {gpsStatus === 'denied'
              ? 'Location blocked — allow it for this site in your browser settings, then reload'
              : 'This browser has no location support'}
          </span>
        )}
      </div>

      {/* bottom controls */}
      <div className="flex items-center justify-between px-8 pb-[max(env(safe-area-inset-bottom),18px)] pt-4">
        <span className="h-14 w-14" aria-hidden />
        <button
          type="button"
          aria-label="Take photo"
          onClick={() => void shoot()}
          className="h-[74px] w-[74px] rounded-full border-4 border-white/70 bg-white active:scale-95"
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
