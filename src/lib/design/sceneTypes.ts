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
  // Which drawn axis the operator's `realFeet` refers to. ADDITIVE + OPTIONAL:
  // existing/design-tool data without this field is treated as "width" so the
  // scale stays byte-identical for every yardstick drawn before this field
  // existed (and for the common horizontal door/garage reference). Set to
  // "height" when the reference is vertical (a downspout, column, or a
  // garage-door HEIGHT) so px/ft is measured along the side the feet describe.
  axis?: "width" | "height";
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
  | 'stake-lighting' // independent stake-lighting runs (manual ft × difficulty, own portal kind)
  | 'bush'
  | 'tree'
  | 'column'
  | 'railing' // grouped mini-light wraps (A2). Tags today; needs a price-book rate (v0.5) to bill.
  | 'curtain'; // mini lights hung from the roof in a curtain — grouped + billed per string at the railing rate (#100)
// Physical roof feature for a c9 roofline run — drives clip-SKU selection in the
// inventory materials engine (#82 Slice 2b). NET-NEW + optional, so the core
// geometry stays byte-identical and data without it is simply "unset". Distinct
// from `surface` (a BILLING category): this is the PHYSICAL attachment surface.
// 'metal' = magnetic socket wire, no clip (flagged for staff). RELAY: mirror to
// the standalone design tool's scene types (byte-identical, like 'stake-lighting').
export type RoofFeature = 'gutter' | 'peak' | 'side' | 'ridge' | 'pathway' | 'flat' | 'metal';
// Which side of the house a c9 / permanent strand runs on (#103). NET-NEW +
// optional single-select, so the core geometry stays byte-identical and data
// without it is simply "unset". A staff TAG only — no portal/pricing/packages
// yet (later: permanent-lighting packages like "Front of house" / "all sides").
// RELAY: mirror to the standalone design tool's scene types (byte-identical,
// like RoofFeature / 'stake-lighting').
export type SideOfHouse = 'front' | 'back' | 'left' | 'right';
export type Tier = 'bow' | 'fullDecor'; // wreath + garland price tier — bow = Non-Decorated, fullDecor = Decorated (#17; 'labor' retired)
export type WrapStyle = 'canopy' | 'trunk'; // mini-light wrap style

// Billed mini-light attrs shared by EVERY authoring path (A1 mini strands, A2
// area fills, A2 grouped railings) so the billed fields stay identical across all
// three — one place to evolve. The bush/tree/column category stays on `surface`
// (ItemBase). (#27 A2 / v0.4)
export type MiniBilling = {
  wrapStyle?: WrapStyle; // canopy | trunk — billed rate
  stringCount?: number; // default 1; billed quantity
};

// Quote-spec sizes — the REAL billed product, set by staff in the editor's
// Quote-binding panel, INDEPENDENT of the item's on-canvas visual size. These
// mirror the price-book keys in pricingEngine (BUSINESS_RULES) member-for-member.
export type QuoteSpritzerSize = '16' | '24' | '32';
export type QuoteWreathSize = '24noble' | '30noble' | '36noble' | '48noble' | '60noble' | '72noble';
export type QuoteGarlandLength = '4.5ft' | '9ft';

export type ItemBase = {
  id: string;
  yardstickId: string | null;
  // --- binding additions (§4) ---
  surface?: Surface | null; // absent/null = unmapped (renders, no line item)
  included?: boolean; // default true; portal selection state
  // Staff-set "advised for this home" flag (#12). SEPARATE from `included`
  // (which is "is it in the quote at all"): `recommended` pre-selects the item
  // on the customer portal and shows a "Recommended" label. Default false.
  recommended?: boolean;
};

export type StrandItem = ItemBase & MiniBilling & {
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
  // mini-light wraps (bush/tree/column): wrapStyle/stringCount via MiniBilling.
  // --- binding (A2 / v0.4) ---
  // groupId: this strand belongs to a MiniGroupItem (a railing) → priced via the
  // group + skipped in the per-strand projection (no double-count).
  groupId?: string;
  // Physical roof feature for clip selection in the inventory materials engine
  // (#82 Slice 2b). Optional; null/absent = unset. Set by staff (+ AI auto-detect
  // in 2c) on c9 roofline runs only. RELAY: shared with the standalone design tool.
  roofFeature?: RoofFeature | null;
  // Which side of the house this run is on (#103). Optional single-select;
  // null/absent = unset. Set by staff on c9 + permanent strands. A tag only — no
  // pricing yet. RELAY: shared with the standalone design tool.
  sideOfHouse?: SideOfHouse | null;
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

// A mini-light AREA (#27 A2 / v0.4): a box or traced polygon that fills with
// single mini-lights at a VISUAL density. One area = one priced mini unit
// (surface + MiniBilling). Bushes-first in v1 (tree canopy optional); columns
// stay strand-based (a vertical trunk wrap won't read as an area fill).
export type MiniAreaItem = ItemBase & MiniBilling & {
  kind: 'miniArea';
  shape: 'box' | 'polygon';
  x?: number; // box
  y?: number;
  width?: number;
  height?: number;
  points?: number[]; // polygon, flat [x0,y0,…], auto-closed on finish
  density?: number; // 0–1 VISUAL fill (bulbs-per-area at render), NOT a count
  colorPattern?: string[]; // palette color IDs; bulbs cycle the pattern (spritzer semantics); empty ⇒ warm-white. VISUAL-only (no projection impact).
  // surface (bush/tree/column) + included inherited from ItemBase
};

// A mini-light GROUP (#27 A2 / v0.4): several drawn strands grouped into ONE
// priced unit (e.g. a railing). Geometry-less — its extent is its members, which
// still render individually and carry a `groupId` backref. One group = one
// priced mini unit (surface + MiniBilling); grouped strands are skipped in the
// per-strand projection.
export type MiniGroupItem = ItemBase & MiniBilling & {
  kind: 'miniGroup';
  memberIds: string[]; // the member strand ids
};

export type SceneItem =
  | StrandItem
  | WreathItem
  | BowItem
  | GarlandItem
  | SpritzerItem
  | TextItem
  | CustomItem
  | PoleItem
  | MiniAreaItem
  | MiniGroupItem;

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
export function isMiniArea(item: SceneItem): item is MiniAreaItem {
  return item.kind === 'miniArea';
}
export function isMiniGroup(item: SceneItem): item is MiniGroupItem {
  return item.kind === 'miniGroup';
}
