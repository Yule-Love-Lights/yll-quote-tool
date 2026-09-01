'use client';

// Simple Crew replica primitives (Naldo, 2026-08-29): the reference app's
// layout language — big titles with a company subtitle, floating pill
// toolbars, card lists, bottom tab bars, sheet modals, pill toggles, and the
// confetti empty states — recolored from its purple to the YLL evergreen and
// gold. One shared kit so the worker and admin apps cannot drift.

import { type ReactNode } from 'react';

// The replica's palette, matched to the quote tool's operator surface
// (globals.css --op-* tokens, Naldo's device round 2026-08-29: follow the
// normal quote tool colors): off-cream page background, evergreen text and
// CTAs, gold accent, cream tints where Simple Crew used lavender.
export const SC = {
  primary: '#2E3D34', // --brand-evergreen-3
  primaryDeep: '#0B140F', // --brand-evergreen
  tint: '#F4ECD8', // --brand-cream
  tint2: '#E0D7C1', // --brand-cream-2
  gold: '#E8B862', // --brand-gold
  bg: '#FAF6EC', // --op-bg
  card: '#FFFFFF',
  text: '#0B140F', // --op-text
  muted: '#6E7466',
  danger: '#C8313D', // --brand-red
  ok: '#2E7D4F',
};

// How wide the advertising app is ever allowed to get. It is a PHONE app:
// the crew use it on a phone and it is right there, but on a desktop screen
// every screen stretched the full window and read as broken (Naldo,
// 2026-09-01: "the desktop version is just too wide"). One number decides
// it, and the fixed bars below cap themselves to the same width so they
// stay attached to the column instead of spanning the whole window.
export const SHELL_MAX_PX = 520;

/** The page column. Background is full bleed; content is phone width. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100svh]" style={{ background: SC.bg }}>
      <div className="mx-auto w-full" style={{ maxWidth: SHELL_MAX_PX }}>
        {children}
      </div>
    </div>
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Big screen title + the company subtitle, like "Campaigns / EBHHNHY". */
export function ScreenHeader({ title, toolbar }: { title: string; toolbar?: ReactNode }) {
  return (
    <div className="relative px-5 pt-14 pb-4">
      {toolbar && (
        <div className="absolute right-4 top-3 flex items-center gap-1 rounded-full bg-white px-2 py-1.5 shadow-md">
          {toolbar}
        </div>
      )}
      <h1 className="text-4xl font-bold tracking-tight" style={{ color: SC.text }}>
        {title}
      </h1>
      <p className="mt-1 text-sm uppercase tracking-wide" style={{ color: SC.muted }}>
        Yule Love Lights
      </p>
    </div>
  );
}

export function ToolbarButton({ onClick, children, label }: { onClick?: () => void; children: ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-full"
      style={{ color: SC.primary }}
    >
      {children}
    </button>
  );
}

/** The Photos Feed / Map View style two-way pill toggle. */
export function PillToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-full border p-0.5" style={{ borderColor: '#E3DCC6', background: SC.card }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="flex-1 rounded-full px-4 py-2.5 text-base font-medium transition-colors"
          style={
            o.value === value
              ? { background: SC.primary, color: '#fff' }
              : { color: SC.text }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type TabItem = { key: string; href: string; icon: ReactNode; active: boolean };

/** The bottom tab bar: outline icons, active tab in a soft pill. */
export function TabBar({ items }: { items: TabItem[] }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 mx-auto flex items-center justify-around border-t px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2"
      style={{ background: SC.card, borderColor: '#EDE6D2', maxWidth: SHELL_MAX_PX }}
    >
      {items.map((t) => (
        <a
          key={t.key}
          href={t.href}
          aria-label={t.key}
          className="flex h-12 min-w-[64px] items-center justify-center rounded-full px-5"
          style={t.active ? { background: '#F1EAD8', color: SC.primary } : { color: '#3A423C' }}
        >
          {t.icon}
        </a>
      ))}
    </nav>
  );
}

/** Bottom sheet, the replica's modal language (campaign picker, guards). */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        className="absolute inset-x-0 bottom-0 mx-auto max-h-[85svh] w-full overflow-y-auto rounded-t-3xl p-4 pb-[max(env(safe-area-inset-bottom),16px)]"
        style={{ background: SC.card, maxWidth: SHELL_MAX_PX }}
      >
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full" style={{ background: '#D9D1BC' }} />
        {children}
      </div>
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
  tone = 'primary',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  tone?: 'primary' | 'danger' | 'quiet';
}) {
  const bg = tone === 'danger' ? SC.danger : tone === 'quiet' ? '#EDE6D4' : SC.primaryDeep;
  const fg = tone === 'quiet' ? SC.text : '#F4EFE6';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="min-h-[52px] w-full rounded-full px-6 text-lg font-semibold shadow-sm disabled:opacity-40"
      style={{ background: bg, color: fg }}
    >
      {children}
    </button>
  );
}

/** The confetti empty state: tinted illustration + title + hint + CTA. */
export function EmptyState({
  kind,
  title,
  hint,
  cta,
}: {
  kind: 'photos' | 'campaigns' | 'crew';
  title: string;
  hint: string;
  cta?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 py-10 text-center">
      <ConfettiIllustration kind={kind} />
      <h2 className="mt-8 text-2xl font-bold" style={{ color: SC.text }}>
        {title}
      </h2>
      <p className="mt-2 max-w-sm text-base" style={{ color: SC.muted }}>
        {hint}
      </p>
      {cta && <div className="mt-6 w-full max-w-xs">{cta}</div>}
    </div>
  );
}

function ConfettiIllustration({ kind }: { kind: 'photos' | 'campaigns' | 'crew' }) {
  const deep = SC.primary;
  const mid = SC.tint2;
  const light = SC.tint;
  return (
    <svg width="230" height="180" viewBox="0 0 230 180" fill="none" aria-hidden>
      {/* confetti */}
      <circle cx="18" cy="60" r="7" stroke={mid} strokeWidth="5" />
      <circle cx="205" cy="30" r="8" stroke={mid} strokeWidth="5" />
      <circle cx="212" cy="120" r="5" stroke={mid} strokeWidth="4" />
      <circle cx="100" cy="168" r="5" stroke={mid} strokeWidth="4" />
      <path d="M60 18l12 7-12 7z" fill={mid} />
      <path d="M22 150l10 6-10 6z" fill={mid} />
      <rect x="150" y="10" width="10" height="10" rx="2" transform="rotate(45 155 15)" stroke={mid} strokeWidth="4" />
      <rect x="28" y="108" width="9" height="9" rx="2" transform="rotate(45 32 112)" stroke={mid} strokeWidth="4" />
      {kind === 'campaigns' ? (
        // megaphone
        <g>
          <path d="M60 80c0-18 14-32 32-32h18v64H92c-18 0-32-14-32-32Z" fill={light} />
          <path d="M110 42l34-14v104l-34-14" fill={light} />
          <path d="M70 78c0-16 12-28 28-28h16v56H98c-16 0-28-12-28-28ZM114 46l30-12v88l-30-12" stroke={deep} strokeWidth="7" strokeLinejoin="round" />
          <path d="M84 108c0 10 4 16 10 20" stroke={deep} strokeWidth="7" strokeLinecap="round" />
        </g>
      ) : kind === 'crew' ? (
        // photo frames (their crew screen reuses the photos art)
        <FramesArt deep={deep} light={light} />
      ) : (
        <FramesArt deep={deep} light={light} />
      )}
      {/* magnifier */}
      <circle cx="152" cy="92" r="30" fill="#fff" stroke={deep} strokeWidth="8" />
      <path d="M150 104c-5 0-9-2-12-5M174 114l20 20" stroke={deep} strokeWidth="8" strokeLinecap="round" />
    </svg>
  );
}

function FramesArt({ deep, light }: { deep: string; light: string }) {
  return (
    <g>
      <rect x="52" y="38" width="86" height="104" rx="12" fill={light} transform="rotate(-8 95 90)" />
      <rect x="64" y="34" width="80" height="98" rx="12" fill="#fff" stroke={deep} strokeWidth="7" />
      <path d="M72 96l20-24 16 18 10-12 18 22" stroke={deep} strokeWidth="6" strokeLinejoin="round" />
      <circle cx="118" cy="56" r="7" stroke={deep} strokeWidth="6" />
      <path d="M68 112h72" stroke={deep} strokeWidth="6" />
    </g>
  );
}
