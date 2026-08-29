// Inline icon set for the Simple Crew replica (Naldo, 2026-08-29): the same
// glyph language as the reference screenshots — thin-stroke outline icons —
// drawn as plain SVGs so no icon dependency ships.

type IconProps = { size?: number; className?: string; strokeWidth?: number };

function base(props: IconProps) {
  return {
    width: props.size ?? 24,
    height: props.size ?? 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: props.strokeWidth ?? 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: props.className,
  };
}

export const FeedIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M7 10h6M7 14h10" />
  </svg>
);

export const CrewIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="9" cy="9" r="3" />
    <circle cx="16.5" cy="10" r="2.4" />
    <path d="M3.5 19c.7-3 3-4.5 5.5-4.5S13.8 16 14.5 19M14.5 15.6c2.3.2 4.2 1.4 4.9 3.4" />
  </svg>
);

export const CameraIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
    <circle cx="12" cy="13" r="3.2" />
  </svg>
);

export const PersonIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c1-3.6 3.9-5.5 7-5.5s6 1.9 7 5.5" />
  </svg>
);

export const GearIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5 13.6 5h2.2l.8 2 2 .8v2.2l1.5 1.6-1.5 1.6v2.2l-2 .8-.8 2h-2.2L12 20.5 10.4 19H8.2l-.8-2-2-.8v-2.2L3.9 12l1.5-1.6V8.2l2-.8.8-2h2.2L12 3.5Z" />
  </svg>
);

export const SortIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 5v14M8 19l-3-3M8 19l3-3M15 5h5M15 9h4M15 13h3" />
  </svg>
);

export const SearchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4-4" />
  </svg>
);

export const PlusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const PersonAddIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="10" cy="8.5" r="3.2" />
    <path d="M4 19.5c.9-3.2 3.3-5 6-5s5.1 1.8 6 5M18 8v5M15.5 10.5h5" />
  </svg>
);

export const BackIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m14 6-6 6 6 6" />
  </svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const DotsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const PinIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 21s-6.5-5.7-6.5-10.2A6.5 6.5 0 0 1 12 4.3a6.5 6.5 0 0 1 6.5 6.5C18.5 15.3 12 21 12 21Z" />
    <circle cx="12" cy="10.7" r="2.2" />
  </svg>
);

export const FlashOffIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 3 6.5 13H11l-1 8 7.5-10.5H13L14.5 3Z" />
    <path d="m4 4 16 16" />
  </svg>
);

export const FlipCameraIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 9h2.5L8 7h8l1.5 2H20v9H4V9Z" />
    <path d="M9.5 13.5a2.8 2.8 0 0 1 5-1.6M14.5 13.5a2.8 2.8 0 0 1-5 1.6" />
    <path d="m14.8 10.6.3 1.6-1.6.3M9.2 16.4l-.3-1.6 1.6-.3" />
  </svg>
);

export const CloseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const EditIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
);

export const PhotoBadgeIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="m6 16 4-4 3 3 2-2 3 3" />
    <circle cx="9.5" cy="9.5" r="1.1" />
  </svg>
);

export const MapFoldIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2ZM9 4v14M15 6v14" />
  </svg>
);

export const LocateIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M20 4 4 11.5l7 1.5 1.5 7L20 4Z" />
  </svg>
);
