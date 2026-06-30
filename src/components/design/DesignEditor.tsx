'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { applyAppSettings } from '@/lib/clientSettings';
import { DEFAULT_KEYMAP, resolveAction, normalizeKeymap, type KeyMap } from './editor-core/keymap';
import './design-editor.css';

type Props = {
  designId: string;
  onClose?: () => void;
  /** Embedded (collapsed) editor height in px. Full screen ignores this. */
  height?: number;
  /**
   * Handed a flush() that synchronously persists a pending debounced scene save
   * (#8 Stage A) — the parent awaits it before training capture / pricing so
   * neither reads a stale scene. Called with null on unmount. Re-fires on each
   * (re)mount since the editor remounts on re-seed.
   */
  onReady?: (flush: (() => Promise<void>) | null) => void;
};

const BAR_HEIGHT = 40; // px — the React control bar above the editor.

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
export default function DesignEditor({ designId, onClose, height = 600, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // This operator's editor hotkeys (#98), loaded on mount; defaults until then.
  const [keymap, setKeymap] = useState<KeyMap>(DEFAULT_KEYMAP);
  // Keep the latest onReady in a ref so the mount effect doesn't depend on it
  // (a new callback identity each render would needlessly remount the editor).
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

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
      handle = await renderEditor(host, designId, { embedded: true, showQuoteBinding: true, keymap: km });
      if (cancelled) {
        handle?.();
        handle = null;
        return;
      }
      onReadyRef.current?.(handle.flushSave ? () => handle!.flushSave!() : null);
    })();

    return () => {
      cancelled = true;
      onReadyRef.current?.(null);
      handle?.();
    };
  }, [designId]);

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

  const hostHeight: CSSProperties['height'] = expanded ? `calc(100vh - ${BAR_HEIGHT}px)` : height;

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
      <div ref={hostRef} className="yll-design-host" style={{ height: hostHeight, width: '100%' }} />
    </div>
  );
}
