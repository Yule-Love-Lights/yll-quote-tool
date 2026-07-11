'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { applyAppSettings } from '@/lib/clientSettings';
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
   * Handed a flush() that synchronously persists a pending debounced scene save
   * (#8 Stage A) — the parent awaits it before training capture / pricing so
   * neither reads a stale scene. Called with null on unmount. Re-fires on each
   * (re)mount since the editor remounts on re-seed.
   */
  onReady?: (flush: (() => Promise<void>) | null) => void;
};

const BAR_HEIGHT = 40; // px — the React control bar above the editor.
const STRIP_HEIGHT = 36; // px — the #13 photo tab strip (rendered only when a base photo exists).

// One tab in the photo strip: the base photo (id null) or an extra.
type PhotoTab = { id: string | null; title: string };

// Read a File as a data: URL — addDesignExtraPhoto strips the prefix server-side.
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

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
export default function DesignEditor({ designId, onClose, height = 600, onReady, permanentOnly, bistroOnly }: Props) {
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
  // Keep the latest onReady in a ref so the mount effect doesn't depend on it
  // (a new callback identity each render would needlessly remount the editor).
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

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
      });
      if (cancelled) {
        handle?.();
        handle = null;
        return;
      }
      flushRef.current = handle.flushSave ? () => handle!.flushSave!() : null;
      onReadyRef.current?.(flushRef.current);
    })();

    return () => {
      cancelled = true;
      flushRef.current = null;
      onReadyRef.current?.(null);
      handle?.();
    };
  }, [designId, activePhotoId, permanentOnly, bistroOnly]);

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
      const dataUrl = await fileToDataUrl(file);
      const res = await fetch(`/api/designs/${designId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoBase64: dataUrl, photoMediaType: file.type || 'image/jpeg' }),
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
      const res = await fetch(`/api/designs/${designId}/photos/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        alert("Couldn't delete the photo.");
        return;
      }
      if (activePhotoId === id) setActivePhotoId(null);
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
                    className="ml-0.5 text-[#6b7484] hover:text-red-400"
                    title="Delete this photo"
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
            disabled={photoBusy}
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
