// Scene data model for the design-tool integration (Path B, task #27).
//
// VENDORED from the design tool's canonical wire format (`client/src/api.ts`)
// — the single source of truth for the scene shape. Types + type-guards only;
// the design tool's Fastify `fetch` client and its Clients/Projects app-shell
// types are intentionally dropped (Path B replaces them with our Supabase
// routes + the quote as the customer record).
//
// ADDED here (and only here, for now): the quote-side BINDING fields from the
// integration data contract §4 — `surface`, `included`, and the per-item
// pricing attributes — marked clearly below. They are additive + optional, so
// the core geometry stays byte-identical with the design tool and the editor
// reads/writes the base fields unchanged. The design tool will mirror these
// when it splits its editor into the shared `editor-core`.

export type Yardstick = {
  id: string;
  realFeet: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BulbType = 'c9' | 'mini' | 'permanent' | 'bistro';
export type DrawingStyle = 'strand' | 'trace' | 'single';

// ---------------------------------------------------------------------------
// Quote-tool BINDING additions (data contract §4) — NOT in the design tool yet.
// `surface` tags a scene item to a quote category; `included` is portal
// selection state; the rest are pricing attributes the projection reads.
//
// KEY PRINCIPLE (Jason, S5): a drawn item's on-canvas SIZE is VISUAL ONLY —
// staff pick whatever diameter/length looks best on the photo, which is
// unrelated to the real product that gets billed (a 60" wreath on the design
// might really be a 30" Noble on the quote). So the BILLED spec is carried in
// separate, staff-set "quote*" fields, generalizing the mini-light model
// (visual density vs staff-typed strand count) to every item.
// ---------------------------------------------------------------------------
export type Surface =
  | 'santas-roofline' // front roof edges (Santa's)
  | 'gingerbread' // the sides + ridge increment Gingerbread adds
  | 'winter-wonderland' // extra/custom C9 runs
  | 'bush'
  | 'tree'
  | 'column';
export type Tier = 'labor' | 'bow' | 'fullDecor'; // wreath + garland price tier
export type WrapStyle = 'canopy' | 'trunk'; // mini-light wrap style

// Quote-spec sizes — the REAL billed product, set by staff in the editor's
// Quote-binding panel, INDEPENDENT of the item's on-canvas visual size. These
// mirror the price-book keys in pricingEngine (BUSINESS_RULES) member-for-member.
export type QuoteSpritzerSize = '16' | '24' | '32';
export type QuoteWreathSize = '24noble' | '30noble' | '36noble' | '48noble' | '36oregon';
export type QuoteGarlandLength = '4.5ft' | '9ft';

export type ItemBase = {
  id: string;
  yardstickId: string | null;
  // --- binding additions (§4) ---
  surface?: Surface | null; // absent/null = unmapped (renders, no line item)
  included?: boolean; // default true; portal selection state
};

export type StrandItem = ItemBase & {
  kind: 'strand';
  bulbType: BulbType;
  spacingIn: number;
  drawingStyle: DrawingStyle;
  colorPattern: string[];
  points: number[]; // flat [x0,y0,x1,y1,…] in photo-pixel space
  // Permanent-light-only props (ignored for c9 / mini / bistro).
  beamLengthFt?: number;
  beamWidthFt?: number;
  distanceToSurfaceFt?: number;
  opacity?: number;
  showCoverage?: boolean;
  // Bistro-only catenary sag (fraction of span). Ignored otherwise.
  sagFactor?: number;
  // --- binding additions (§4): mini-light wraps (bush/tree/column) ---
  stringCount?: number; // default 1; priced quantity for mini wraps
  wrapStyle?: WrapStyle;
};

export type WreathItem = ItemBase & {
  kind: 'wreath';
  x: number;
  y: number;
  sizeIn: number; // 24 / 36 / 48 / 60 — VISUAL ONLY (not the billed size)
  withLights: boolean;
  withBow?: boolean; // missing ⇒ treat as true (back-compat); visual seed only
  colorId?: string; // legacy — unused; kept for back-compat
  rotation?: number;
  // --- binding additions (§4) — design size is VISUAL ONLY; staff set the
  // real billed product here ---
  quoteSize?: QuoteWreathSize; // the actual billed product size + variety
  tier?: Tier; // drives price; booleans only seed the visual
};

export type BowItem = ItemBase & {
  kind: 'bow';
  x: number;
  y: number;
  sizeIn: number; // 12 / 18 / 24 / 36 / 48
  rotation?: number;
};

export type GarlandItem = ItemBase & {
  kind: 'garland';
  points: number[];
  drawingStyle: DrawingStyle;
  withLights: boolean;
  sizeIn?: number; // 6 / 9 / 12 / 18 / 24 rope thickness — VISUAL ONLY
  // --- binding additions (§4) — garland is priced by length × sections × tier,
  // all staff-set; the drawn run length is VISUAL ONLY ---
  quoteLength?: QuoteGarlandLength; // 4.5ft / 9ft sections
  quoteSections?: number; // number of sections billed (default 1)
  withBow?: boolean; // visual seed only; `tier` drives price
  tier?: Tier;
};

export type SpritzerItem = ItemBase & {
  kind: 'spritzer';
  x: number;
  y: number;
  sizeIn: number; // 16 / 24 / 36 / 48 — VISUAL ONLY (not the billed size)
  colorPattern: string[];
  // --- binding addition: the real billed spritzer size (staff-set) ---
  quoteSize?: QuoteSpritzerSize;
};

export type TextItem = ItemBase & {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  fontFamily: string; // one of the editor's FONT_OPTIONS
  sizeIn: number; // real-world cap height in inches
  rotation?: number;
  colorId: string;
  outline?: boolean;
};

export type CustomItem = ItemBase & {
  kind: 'custom';
  x: number;
  y: number;
  imagePath: string; // a Supabase Storage reference under Path B
  widthIn: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  autoHalo?: boolean;
};

export type PoleItem = ItemBase & {
  kind: 'pole';
  x: number;
  y: number;
  heightIn: number; // 96 / 120 / 144 / 180 (8 / 10 / 12 / 15 ft)
  baseType: 'none' | 'cube' | 'barrel';
};

export type SceneItem =
  | StrandItem
  | WreathItem
  | BowItem
  | GarlandItem
  | SpritzerItem
  | TextItem
  | CustomItem
  | PoleItem;

// Convenience alias kept so editor imports keep working.
export type Strand = StrandItem;

export type Scene = {
  yardsticks: Yardstick[];
  items: SceneItem[];
  brightness?: number; // 0 = darkest, 50 = neutral, 100 = lightest
};

// The shape the editor controller expects from its storage adapter's load.
// `projectId`/`background` are design-tool app-shell concepts, unused under
// Path B — kept optional so the ported controller compiles unchanged.
export type Design = {
  id: string;
  projectId?: string | null;
  name: string;
  photoUrl: string | null;
  photoW: number | null;
  photoH: number | null;
  background?: string | null;
  scene: Scene;
  createdAt: number;
  updatedAt: number;
};

// One entry in the custom-graphic library (deferred in Phase 1).
export type CustomUpload = {
  id: string;
  filename: string;
  path: string;
  url: string;
  uploadedAt: number;
};

// Editable color palette entry.
export type BulbColor = {
  id: string;
  label: string;
  hex: string;
  glow: string;
  builtin?: boolean;
};

// Per-item-type tool defaults, keyed by item-type identifier.
export type ToolDefaults = Record<string, Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Type guards used throughout the editor.
// ---------------------------------------------------------------------------
export function isStrand(item: SceneItem): item is StrandItem {
  return item.kind === 'strand';
}
export function isWreath(item: SceneItem): item is WreathItem {
  return item.kind === 'wreath';
}
export function isBow(item: SceneItem): item is BowItem {
  return item.kind === 'bow';
}
export function isGarland(item: SceneItem): item is GarlandItem {
  return item.kind === 'garland';
}
export function isSpritzer(item: SceneItem): item is SpritzerItem {
  return item.kind === 'spritzer';
}
export function isText(item: SceneItem): item is TextItem {
  return item.kind === 'text';
}
export function isCustom(item: SceneItem): item is CustomItem {
  return item.kind === 'custom';
}
export function isPole(item: SceneItem): item is PoleItem {
  return item.kind === 'pole';
}
