'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { applyAppSettings } from '@/lib/clientSettings';
import { downscaleForUpload } from '@/lib/clientImage';
import { DEFAULT_KEYMAP, resolveAction, normalizeKeymap, type KeyMap } from './editor-core/keymap';
import { extraPhotoLabels } from '@/lib/design/photoLabels';
import './design-editor.css';

type Props = {
  designId: string;
  onClose?: () => void;
  /** Embedded (collapsed) editor height in px. Full screen ignores this. */
  height?: number;
  /** #88: lock the design to permanent pucks only (a permanent-service quote) —
   *  hides holiday bulb types (c9/mini/bistro) + all decor/text/pole tools. */
  permanentOnly?: boolean;
  /** #117: lock the design to bistro strands only (a permanent-bistro-service
   *  quote) — hides holiday bulb types (c9/permanent/mini) + all decor/text/pole
   *  tools. Independent of permanentOnly; if both are set permanentOnly wins
   *  (defensive — the two service types never coexist on one form). */
  bistroOnly?: boolean;
  /**
   * Row 367 — the design's post-approval freeze. True when the linked quote
   * already carries a customer approval and is not a booked order (the SAME
   * predicate as QuoteBuilder's `postApprovalFrozen` and /api/quote's own
   * approval gate). The editor blocks saving and says so; the server enforces
   * it independently in `PUT /api/designs/[id]`, so a stale tab that mounted
   * before the approval still finds out on its next save. Presentation only —
   * never the sole guard.
   */
  locked?: boolean;
  /**
   * Row 367 — fired when the SERVER refuses a scene save because the linked
   * quote is customer-approved, i.e. this editor mounted unlocked and found
   * out afterwards. Lets the host page self-correct the rest of its controls.
   */
  onDesignLocked?: () => void;
  /**
   * Handed a flush() that synchronously persists a pending debounced scene save
   * (#8 Stage A) — the parent awaits it before training capture / pricing so
   * neither reads a stale scene. Called with null on unmount. Re-fires on each
   * (re)mount since the editor remounts on re-seed.
   *
   * #741 defect 1: also handed a discard() that cancels a pending debounced
   * save WITHOUT persisting it — the parent calls this (instead of flush)
   * right after a server-side scene change (a re-analyze reseed) lands and
   * BEFORE forcing this component to remount (e.g. bumping a `key`), so the
   * outgoing mount's teardown flush can't PUT its now-stale resident scene
   * back over what the server just wrote.
   *
   * #741 defect 6: discard() returns whether it actually discarded a real
   * pending edit (vs. the common no-op case) — the parent surfaces a short
   * notice to the operator only when it did, so a genuine in-progress edit
   * isn't lost with zero indication.
   */
  onReady?: (flush: (() => Promise<void>) | null, discard: (() => boolean) | null) => void;
  /**
   * #741 defect 3: handed the mini group(s) (railing/curtain/etc.) a photo
   * delete's server-side prune just orphaned — deleting the last photo
   * holding a group's only surviving member strands removes a real billed
   * line with nothing else telling staff. The parent surfaces this the same
   * way it already surfaces a re-analyze's pruned groups (#255).
   */
  onPrunedMiniGroups?: (groups: { surface: string | null; stringCount: number }[]) => void;
};

const BAR_HEIGHT = 40; // px — the React control bar above the editor.
const STRIP_HEIGHT = 36; // px — the #13 photo tab strip (rendered only when a base photo exists).

// One tab in the photo strip: the base photo (id null) or an extra.
type PhotoTab = { id: string | null; title: string };

// React shell around the vendored vanilla Konva editor (Option B). On mount it
// dynamically imports the editor controller — so Konva (which touches the DOM)
// never runs during SSR — calls renderEditor() against our host element, and
// tears it down via the returned destroy() on unmount.
//
// A thin control bar adds a Full screen toggle (a narrow embedded box squishes
// the editor's sidebar + canvas; full screen gives it the whole tab) and a
// Close button. The host is given an EXPLICIT height (px when embedded, a
// calc() when full screen) — not a flex/percentage height — so the editor's
// `height:100%` grid always resolves to a real box and its ResizeObserver can
// refit the canvas. The editor stays mounted across the toggle, so nothing is
// lost; it simply refits to the new size.
export default function DesignEditor({ designId, onClose, height = 600, onReady, onPrunedMiniGroups, permanentOnly, bistroOnly, locked, onDesignLocked }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // This operator's editor hotkeys (#98), loaded on mount; defaults until then.
  const [keymap, setKeymap] = useState<KeyMap>(DEFAULT_KEYMAP);
  // #13 multi-image: the photo tabs (base + extras) and which one the editor is
  // mounted on (null = base). Switching remounts the editor on that photo —
  // same teardown/remount pattern the standalone design tool uses between
  // designs — after flushing any pending debounced save.
  const [photoTabs, setPhotoTabs] = useState<PhotoTab[] | null>(null);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const addFileRef = useRef<HTMLInputElement>(null);
  // The current mount's flushSave, for our own pre-switch flush (onReady hands
  // the same thing to the parent).
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  // #741 defect 1: the current mount's discardPending — see deletePhoto.
  const discardRef = useRef<(() => boolean) | null>(null);
  // #741 defect 2: the current mount's removePhotoItems — see deletePhoto.
  const removePhotoItemsRef = useRef<((photoId: string, serverVersion?: number | null) => void) | null>(null);
  // Keep the latest onReady in a ref so the mount effect doesn't depend on it
  // (a new callback identity each render would needlessly remount the editor).
  // Kept in a ref for the same reason as onReady: a new identity each render
  // must not remount the editor.
  const onDesignLockedRef = useRef(onDesignLocked);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);
  useEffect(() => {
    onDesignLockedRef.current = onDesignLocked;
  }, [onDesignLocked]);

  // Load the photo tab list (base + extras). Re-runs after add/rename/delete.
  const refreshPhotoTabs = async (id: string): Promise<PhotoTab[] | null> => {
    try {
      const res = await fetch(`/api/designs/${id}`);
      if (!res.ok) return null;
      const { design } = await res.json();
      if (!design?.photoUrl) return null; // no base photo yet → no strip
      const extras = Array.isArray(design.extraPhotos) ? design.extraPhotos : [];
      const labels = extraPhotoLabels(extras);
      const tabs: PhotoTab[] = [
        { id: null, title: (design.photoTitle as string | null)?.trim() || 'Photo 1' },
        ...extras.map((p: { id: string }) => ({ id: p.id, title: labels.get(p.id) ?? 'Photo' })),
      ];
      setPhotoTabs(tabs);
      return tabs;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    // Defer out of the synchronous effect body (repo lint rule:
    // react-hooks/set-state-in-effect) — reset, then the async refresh
    // repopulates the strip.
    queueMicrotask(() => {
      setPhotoTabs(null);
      setActivePhotoId(null);
      void refreshPhotoTabs(designId);
    });
  }, [designId]);

  useEffect(() => {
    let handle: import('./editor-core/editor').EditorHandle | null = null;
    let cancelled = false;

    void (async () => {
      const host = hostRef.current;
      if (!host) return;
      const { renderEditor } = await import('./editor-core/editor');
      if (cancelled) return;
      // Apply the global palette + render settings (#32) before the editor draws
      // so it renders with the configured palette/spritzer density. The editor
      // also re-reads the palette via the storage seam (same cached fetch).
      await applyAppSettings();
      if (cancelled) return;
      // #98: load this operator's per-account hotkeys before the editor mounts so
      // its key handler uses their bindings. Best-effort — default keymap on any
      // failure. (Remaps in Settings apply on the editor's next mount.)
      let km = DEFAULT_KEYMAP;
      try {
        const res = await fetch('/api/account/hotkeys');
        if (res.ok) km = normalizeKeymap((await res.json()).hotkeys);
      } catch {
        // keep defaults
      }
      if (cancelled) return;
      setKeymap(km);
      // showQuoteBinding: true → the quote embed shows the per-item "Quote
      // binding" panels (surface/included + billed quote spec). The design
      // tool's standalone/dashboard embeds leave it off (#27 A1).
      handle = await renderEditor(host, designId, {
        embedded: true,
        showQuoteBinding: true,
        keymap: km,
        activePhotoId,
        permanentOnly,
        bistroOnly,
        locked,
        onLocked: () => onDesignLockedRef.current?.(),
      });
      if (cancelled) {
        handle?.();
        handle = null;
        return;
      }
      flushRef.current = handle.flushSave ? () => handle!.flushSave!() : null;
      discardRef.current = handle.discardPending ? () => handle!.discardPending!() : null;
      // Row 371 (delta-verify HIGH): forward serverVersion. This wrapper
      // silently dropped it, which made the whole post-delete version adoption
      // inert — tsc cannot catch it, because a narrower function is assignable
      // to a wider one. The ref's own type carries the parameter, so name it
      // here rather than relying on the arity matching by accident.
      removePhotoItemsRef.current = handle.removePhotoItems
        ? (photoId: string, serverVersion?: number | null) =>
            handle!.removePhotoItems!(photoId, serverVersion)
        : null;
      onReadyRef.current?.(flushRef.current, discardRef.current);
    })();

    return () => {
      cancelled = true;
      flushRef.current = null;
      discardRef.current = null;
      removePhotoItemsRef.current = null;
      onReadyRef.current?.(null, null);
      handle?.();
    };
  }, [designId, activePhotoId, permanentOnly, bistroOnly, locked]);

  // ─── #13 photo strip actions ───
  const switchPhoto = async (id: string | null) => {
    if (id === activePhotoId || photoBusy) return;
    // Persist any pending debounced edits on the current photo before the
    // remount tears the editor down.
    try {
      await flushRef.current?.();
    } catch {
      // destroy() also flushes best-effort; proceed.
    }
    setActivePhotoId(id);
  };

  const addPhoto = async (file: File) => {
    setPhotoBusy(true);
    try {
      // #186: downscale before base64-encoding — a full-res phone photo
      // inflates ~33% as base64 and 413s Vercel's 4.5MB request-body cap.
      const { dataUrl, mediaType } = await downscaleForUpload(file);
      const res = await fetch(`/api/designs/${designId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoBase64: dataUrl, photoMediaType: mediaType }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Couldn't add the photo: ${data.error ?? res.status}`);
        return;
      }
      const { photo } = await res.json();
      await refreshPhotoTabs(designId);
      await switchPhoto(photo.id as string);
    } catch {
      alert("Couldn't add the photo.");
    } finally {
      setPhotoBusy(false);
    }
  };

  // Rename a tab — id null = the base photo (PATCHes the literal "base").
  const renamePhoto = async (id: string | null, currentTitle: string) => {
    // Row 367 delta-verify round 2 MED: rename is reached by double-clicking a
    // tab, so there is no control to disable — refuse here instead. The route
    // enforces the same freeze; this just avoids prompting for a title the
    // server will throw away.
    if (locked) {
      alert('This design is locked — the customer already approved it, so photo names cannot be changed.');
      return;
    }
    const title = window.prompt('Photo name (empty for the default):', currentTitle);
    if (title === null) return;
    await fetch(`/api/designs/${designId}/photos/${id ?? 'base'}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).catch(() => null);
    await refreshPhotoTabs(designId);
  };

  const deletePhoto = async (id: string, title: string) => {
    if (!window.confirm(`Delete "${title}" and everything drawn on it? The main photo and its items are unaffected.`)) return;
    setPhotoBusy(true);
    try {
      // #254: flush any pending debounced edit on the CURRENTLY MOUNTED photo
      // before the delete goes out — same pre-teardown flush switchPhoto
      // already does, so a real in-flight edit lands before the server-side
      // prune runs.
      try {
        await flushRef.current?.();
      } catch {
        // #741 defect 6: this is NOT protected by "destroy() also flushes" —
        // deleting the ACTIVE photo discards this edit outright below (it's
        // on the doomed photo); deleting an INACTIVE tab doesn't tear the
        // editor down at all (see removePhotoItemsRef below). Either way a
        // failed flush here just leaves the edit queued — the editor's own
        // autosave retry (doSave's 4s backoff) picks it up on its own.
      }
      const res = await fetch(`/api/designs/${designId}/photos/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        // Row 367 delta-verify round 2 MED: this route enforces the SAME freeze
        // and answers with the SAME `design-locked` code as the scene write, so
        // a generic "Couldn't delete the photo." here was both unhelpful and a
        // missed self-correction — the rest of the page kept its editable money
        // controls after the server had already said the quote is approved.
        const err = await res.json().catch(() => ({}));
        if (err?.code === 'design-locked') {
          alert(typeof err.error === 'string' ? err.error : 'This design is locked — the customer already approved it.');
          onDesignLockedRef.current?.();
        } else {
          alert("Couldn't delete the photo.");
        }
        return;
      }
      // #741 defect 3: report any mini group the server's prune just orphaned
      // (a "Curtain — 6 strings" line can vanish with this deleted photo) so
      // the parent can warn staff the same way it already does for #255.
      const data = await res.json().catch(() => ({}));
      // Row 367: the photo is gone but its drawn items are NOT. Say so plainly;
      // the alternative (a silent success) leaves invisible items still
      // billing. Two causes, two remedies — 'locked' is permanent, 'unverified'
      // was a read that failed and may work on a fresh delete of another photo.
      if (data.sceneNotPruned === 'locked' || data.sceneNotPruned === 'unverified') {
        alert(
          data.sceneNotPruned === 'locked'
            ? 'The photo was deleted, but the items drawn on it could NOT be removed — the customer ' +
              'approved this quote while the delete was running, so the design is now locked. Those ' +
              'items are still on the quote. Tell the office before sending anything else.'
            : 'The photo was deleted, but the items drawn on it could NOT be removed — the server ' +
              "could not check this quote's approval state. Those items are still on the quote. " +
              'Reload and check the design before sending anything.',
        );
        onDesignLockedRef.current?.();
      }
      onPrunedMiniGroups?.(Array.isArray(data.prunedMiniGroups) ? data.prunedMiniGroups : []);
      if (activePhotoId === id) {
        // #741 defects 1/2: the editor is mounted ON the deleted photo — its
        // resident scene predates the server's delete+prune, so discard
        // (never flush) whatever it has pending before the activePhotoId
        // reset below triggers the mount effect's normal remount onto the
        // base photo. Flushing here would PUT the stale scene straight back
        // over the row the server just pruned.
        // #741 defect 6: tell the operator only when there was actually
        // something to throw away (an edit made during the DELETE round
        // trip, after the pre-delete flush above already ran) — the common
        // case discards nothing and stays silent.
        if (discardRef.current?.()) {
          alert("An unsaved edit made while deleting was discarded (it hadn't saved yet).");
        }
        setActivePhotoId(null);
      } else {
        // #741 defect 2: the editor is mounted on a DIFFERENT, surviving
        // photo — do NOT remount it (that would blow away live zoom,
        // selection, undo history, and any in-progress trace/drag that lives
        // only in editor-local closures, never in scene.items, for a routine
        // "clean up a stray tab" action). Splice the deleted photo's items
        // out of the resident scene in place instead, mirroring the server's
        // own prune — the resident scene then already matches server truth,
        // so no remount and no discard are needed here.
        // Row 371: pass the server's post-prune version along with the id —
        // see removePhotoItems' own comment for why the still-mounted editor
        // needs it even when the deleted tab held nothing drawn.
        removePhotoItemsRef.current?.(id, typeof data.version === 'number' ? data.version : null);
      }
      await refreshPhotoTabs(designId);
    } finally {
      setPhotoBusy(false);
    }
  };

  // Stop the page behind from scrolling while full screen.
  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  // Escape exits full screen (in addition to the button). Ignored while typing
  // in an input/textarea so it doesn't fight text entry (e.g. editing a text
  // item or a field), and only active while expanded.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // Full-screen toggle (#44, default "F") — pull/upload → analyze → toggle →
  // full-screen editor with the house ready. The binding is configurable (#98,
  // the shell-scoped "fullscreen" action); F (not Space) because the editor core
  // owns Space for hold-to-pan. resolveAction is strict on modifiers, so
  // Ctrl/Cmd+F browser-find still works. Guards: ignore typing in a field +
  // auto-repeat from a held key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (resolveAction(e, keymap, 'shell') !== 'fullscreen') return;
      e.preventDefault();
      setExpanded((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keymap]);

  // The host just changed size (full-screen toggle) — nudge the editor to refit
  // its canvas to the new box. The editor also has a ResizeObserver, but a
  // window resize is a reliable, explicit trigger across environments. Fire
  // after the layout settles: a double rAF (next-frame after reflow) plus a
  // timeout fallback, since a single rAF can run before the reflow completes.
  useEffect(() => {
    const fire = () => window.dispatchEvent(new Event('resize'));
    const raf = requestAnimationFrame(() => requestAnimationFrame(fire));
    const timer = setTimeout(fire, 150);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [expanded]);

  const wrapStyle: CSSProperties = expanded
    ? { position: 'fixed', inset: 0, zIndex: 9999 }
    : { position: 'relative' };

  const wrapClass = expanded
    ? 'overflow-hidden bg-[#0f1115]'
    : 'overflow-hidden rounded-lg border border-[#2e3340] bg-[#0f1115]';

  const showStrip = photoTabs !== null;
  const hostHeight: CSSProperties['height'] = expanded
    ? `calc(100vh - ${BAR_HEIGHT + (showStrip ? STRIP_HEIGHT : 0)}px)`
    : height;

  const barBtn =
    'rounded border border-[#2e3340] bg-[#242833] hover:bg-[#2e3340] text-[#e8ebf0] px-2.5 py-1 text-xs cursor-pointer';

  return (
    <div style={wrapStyle} className={wrapClass}>
      <div
        style={{ height: BAR_HEIGHT }}
        className="flex items-center justify-between gap-2 px-3 border-b border-[#2e3340] bg-[#1a1d24]"
      >
        <span className="text-xs font-medium text-[#9aa3b2]">Design editor</span>
        {/* Row 367: staff see the freeze BEFORE they draw, not after a refused
            save. The editor-core banner still fires if a save is refused (a
            stale tab), but this is the one that prevents wasted work. */}
        {locked && (
          <span
            className="text-xs font-medium rounded px-2 py-0.5 border border-amber-700 bg-[#2a2117] text-amber-300 whitespace-nowrap"
            title="The customer already approved this quote, so the design they signed off on is locked. To change it: decline this quote, revive it, edit, and re-send. (A booked order is changed through the amend flow.)"
          >
            🔒 Approved — locked
          </span>
        )}
        <div className="flex items-center gap-2">
          <Link href="/settings" target="_blank" className={barBtn}>
            ⚙ Settings
          </Link>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className={barBtn}
            title={expanded ? 'Exit full screen (F or Esc)' : 'Full screen (F)'}
          >
            {expanded ? '✕ Exit full screen' : '⛶ Full screen'}
            <span className="ml-1 opacity-60">(F)</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                onClose();
              }}
              className={barBtn}
            >
              Close
            </button>
          )}
        </div>
      </div>
      {showStrip && (
        <div
          style={{ height: STRIP_HEIGHT }}
          className="flex items-center gap-1 px-2 border-b border-[#2e3340] bg-[#161920] overflow-x-auto"
        >
          {(photoTabs ?? []).map((tab) => {
            const active = tab.id === activePhotoId;
            return (
              <span
                key={tab.id ?? 'base'}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs whitespace-nowrap cursor-pointer border ${
                  active
                    ? 'border-green-600 bg-[#1d2b22] text-[#d8e4dc]'
                    : 'border-[#2e3340] bg-[#1a1d24] text-[#9aa3b2] hover:border-[#3a4150]'
                }`}
                onClick={() => void switchPhoto(tab.id)}
                title={tab.id ? 'Click to switch · double-click to rename' : 'The main photo (measurement + satellite live here) · double-click to rename'}
                onDoubleClick={() => void renamePhoto(tab.id, tab.title)}
              >
                {tab.title}
                {tab.id && (
                  <button
                    type="button"
                    className="ml-0.5 text-[#6b7484] hover:text-red-400 disabled:opacity-40"
                    title="Delete this photo"
                    // #741: parity with the "+ Add photo" button below — without
                    // this, two overlapping deletes on two different tabs each
                    // force their own corrective save (removePhotoItems), racing
                    // two full-scene PUTs the server resolves by arrival order.
                    disabled={photoBusy || locked}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deletePhoto(tab.id!, tab.title);
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
          <button
            type="button"
            className={`${barBtn} whitespace-nowrap`}
            disabled={photoBusy || locked}
            onClick={() => addFileRef.current?.click()}
            title="Add another photo of this house (side, backyard, garage…) — drawn items on it are quoted too; no AI analyze"
          >
            {photoBusy ? 'Adding…' : '+ Add photo'}
          </button>
          <input
            ref={addFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void addPhoto(f);
            }}
          />
        </div>
      )}
      <div ref={hostRef} className="yll-design-host" style={{ height: hostHeight, width: '100%' }} />
    </div>
  );
}
