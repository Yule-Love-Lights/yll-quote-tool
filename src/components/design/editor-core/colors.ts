import type { BulbColor } from "@/lib/design/sceneTypes";

// Factory defaults — used as the seed when the app has no stored palette,
// and as the target of the Settings → "Reset to defaults" button.
export const DEFAULT_COLORS: BulbColor[] = [
  { id: "warm-white", label: "Warm White", hex: "#ffdca8", glow: "#fff2d4", builtin: true },
  { id: "cool-white", label: "Cool White", hex: "#e0eaff", glow: "#ffffff", builtin: true },
  { id: "black",      label: "Black",      hex: "#000000", glow: "#666666", builtin: true },
  { id: "red",        label: "Red",        hex: "#ff2a2a", glow: "#ff6a6a", builtin: true },
  { id: "green",      label: "Green",      hex: "#1aff6f", glow: "#6affac", builtin: true },
  { id: "blue",       label: "Blue",       hex: "#3a7bff", glow: "#7faaff", builtin: true },
  { id: "orange",     label: "Orange",     hex: "#ff8a1f", glow: "#ffb766", builtin: true },
  { id: "yellow",     label: "Yellow",     hex: "#ffe61f", glow: "#fff080", builtin: true },
  { id: "pink",       label: "Pink",       hex: "#ff44b1", glow: "#ff85cf", builtin: true },
  { id: "purple",     label: "Purple",     hex: "#a042ff", glow: "#c585ff", builtin: true },
  { id: "teal",       label: "Teal",       hex: "#26e6c8", glow: "#6cf2dd", builtin: true },
];

// Live palette state. Mutated in place via `setPalette` so existing imports of
// `COLORS` continue to see the latest list (arrays are reference types).
export const COLORS: BulbColor[] = [...DEFAULT_COLORS];
export const COLOR_MAP = new Map<string, BulbColor>(COLORS.map((c) => [c.id, c]));

export function setPalette(list: BulbColor[]): void {
  COLORS.length = 0;
  COLORS.push(...list);
  COLOR_MAP.clear();
  for (const c of COLORS) COLOR_MAP.set(c.id, c);
}

export function colorOf(id: string): BulbColor {
  return COLOR_MAP.get(id) ?? COLORS[0] ?? DEFAULT_COLORS[0];
}

// Auto-compute a "glow" color from a base hex (used when the user picks a hex
// in the Settings page and we want a sensible bright variant for the glow halo).
export function suggestGlow(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Push each channel ~60% of the way to white.
  const mix = (c: number) => Math.round(c + (255 - c) * 0.6);
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}
