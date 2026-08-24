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
  // Which photo of the design this item is drawn on (#13 multi-image). Matches
  // a `DesignExtraPhoto.id`; absent/null = the BASE photo, so every item that
  // predates multi-image renders exactly where it always did. Additive +
  // optional — core geometry stays byte-identical. RELAY: reaches the design
  // tool's scene types together with the #13 editor-core changes (PR2a).
  photoId?: string | null;
  // #13 linked twins: this item is a RENDER-ONLY depiction of another item
  // (the canonical), re-drawn on a different photo of the same house (staff
  // re-draw the whole display per photo — one tree decorated in photo 1 AND
  // photo 2 is still ONE billed tree). Twins are skipped by the pricing
  // projection, materials projection, and fulfillability (same pattern as
  // groupId members); the portal toggle/recolor reaches them via sceneLinks
  // twin-expansion. Deleting the canonical deletes its twins; deleting a twin
  // removes just that depiction. Absent/null = a normal billable item.
  linkedToId?: string | null;
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
  showBeam?: boolean; // permanent: render the light beam/cone (default true); off = puck dots only
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
  // #249 review fix: PROVENANCE for `sideOfHouse` — true = baked on by the
  // pre-draw quick-tag default (sticky across strands drawn on the same
  // photo), not a deliberate per-strand choice. False/absent = a human
  // explicitly set or confirmed the tag via the post-hoc dropdown (or the
  // field predates this flag). Additive + optional — old scenes and the
  // un-relayed standalone tool are unaffected; harmless there either way
  // since only this repo's training capture reads it. Consumers: bills,
  // displays, and the portal per-side toggle all read `sideOfHouse` alone and
  // ignore this flag (an auto tag is still a fine on-screen label); ONLY
  // permanent-lighting training-example capture (trainingExamples.ts) gates
  // on it, to keep unconfirmed sticky tags out of AI ground truth. RELAY:
  // shared with the standalone design tool.
  sideOfHouseAuto?: boolean;
};

export type WreathItem = ItemBase & {
  kind: 'wreath';
  x: number;
  y: number;
  sizeIn: number; // any value valid/stored; quick-picks are 24 / 36 / 60 (#202) — VISUAL ONLY (not the billed size)
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
  sizeIn: number; // any value valid/stored; quick-picks are 12 / 24 / 48 (#202)
  rotation?: number;
};

export type GarlandItem = ItemBase & {
  kind: 'garland';
  points: number[];
  drawingStyle: DrawingStyle;
  withLights: boolean;
  sizeIn?: number; // rope thickness, any value valid/stored; quick-picks are 6 / 12 / 24 (#202) — VISUAL ONLY
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
  sizeIn: number; // any value valid/stored; quick-picks are 16 / 24 / 48 (#202) — VISUAL ONLY (not the billed size)
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
  heightIn: number; // any value valid/stored; quick-picks are 96 / 120 / 180 (8 / 10 / 15 ft) (#202)
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
  // #240: this scattershot belongs to a MiniGroupItem (mixed groups can hold
  // strands AND areas) → priced via the group + skipped in its own per-item
  // projection (no double-count). Mirrors StrandItem.groupId exactly.
  groupId?: string;
};

// A mini-light GROUP (#27 A2 / v0.4; #240: members can be strands AND/OR
// scattershots): several drawn strands and/or mini-light areas grouped into
// ONE priced unit (e.g. a railing). Geometry-less — its extent is its
// members, which still render individually and carry a `groupId` backref.
// One group = one priced mini unit (surface + MiniBilling); grouped members
// are skipped in their own per-item projection.
export type MiniGroupItem = ItemBase & MiniBilling & {
  kind: 'miniGroup';
  memberIds: string[]; // member strand and/or scattershot ids
  // One physical mini-light unit needs one authoritative install pattern.
  // Group edits mirror this value onto the visual member items; absent on a
  // legacy group means the existing warm-white fulfillment default.
  colorPattern?: string[];
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
  /**
   * How big the lights are DRAWN, as a multiplier (0.5–4, default 1). Purely
   * presentational, exactly like `brightness` above: it changes the picture
   * staff and the customer see and it changes nothing that is priced.
   *
   * It exists because a whole-house photo runs 10–25 px/ft, below the floor
   * where a bulb's real-world size takes over, so every light pins to a few
   * pixels and the yardstick cannot make it any bigger. The yardstick is NOT
   * the workaround: `pxPerFoot` also drives bulb spacing and divides strand
   * pixel length into billed footage, so stretching it for a nicer picture
   * corrupts the quote. This field is the separate knob.
   *
   * Absent/invalid reads as 1 via `normalizeLightScale` — see
   * `editor-core/lightScale.ts` for the sizing math and the money-safety rule.
   */
  lightScale?: number;
};

// One extra street photo as the editor sees it (#13 multi-image): a signed URL
// + dims + optional staff title. Matches DesignWithPhoto.extraPhotos.
export type EditorExtraPhoto = {
  id: string;
  url: string | null;
  w: number;
  h: number;
  title: string | null;
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
  // Extra street photos (#13 multi-image). Optional + additive — the design
  // tool's own storage doesn't supply it and the editor treats absent as "no
  // extras", so both apps compile/run unchanged without it.
  extraPhotos?: EditorExtraPhoto[];
  // Compare-and-swap counter for the scene write (ledger row 260). Optional +
  // additive — the standalone design tool's own storage doesn't supply it;
  // absent/null is treated as "unknown version" (adopt, don't guard) by the
  // storage seam and the server, so both apps compile/run unchanged without it.
  version?: number | null;
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

// #13 multi-image: does this item belong to the given photo? `photoId` on the
// item and `activePhotoId` both use null/absent for the BASE photo, so every
// pre-multi-image item matches the base mount. Pure — shared by the editor's
// per-photo filtering and (later) the portal's per-photo rendering.
export function isItemOnPhoto(
  item: { photoId?: string | null },
  activePhotoId: string | null,
): boolean {
  return (item.photoId ?? null) === activePhotoId;
}

// #13 linked twins: render-only depiction of a canonical item on another photo.
export function isLinkedTwin(item: { linkedToId?: string | null }): boolean {
  return !!item.linkedToId;
}

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

// #240: is this item eligible to join (or start) a mini-light GROUP? A strand
// must be bulbType 'mini' (only mini bulbs wrap into a group); a scattershot
// (miniArea) is inherently mini-light so no bulbType check applies to it.
// Either kind is excluded once already grouped (`groupId` set — grouping it
// again would silently move it between groups) or once it's a #13 linked twin
// (`linkedToId` set — a twin never bills on its own, so grouping one would
// create a group with nothing feeding it). Shared by every "select 2+ →
// group" gate so strand-only, scattershot-only, and mixed selections agree.
export function isMiniGroupable(item: SceneItem): item is StrandItem | MiniAreaItem {
  if (item.linkedToId) return false;
  if (isStrand(item)) return item.bulbType === 'mini' && !item.groupId;
  if (isMiniArea(item)) return !item.groupId;
  return false;
}

// #227: a `miniGroup` (a grouped railing/curtain) whose members have ALL been
// deleted renders nothing (it has no points of its own — its extent is its
// members'), so the editor gives no way to select or delete it, yet
// `projectScene` would otherwise keep emitting it and billing its
// `stringCount` forever. Call this immediately after ANY operation that
// removes strand or (#240) scattershot items from a scene's `items` array, so
// the dangling group is deleted in the same edit instead of surviving as an
// unbillable-but-still-billed ghost. A PARTIALLY orphaned group (some members
// still alive) is left alone — it still bills normally. A group with an empty
// `memberIds` (never produced by the editor's own grouping flow, which
// requires >=2 selected members) is also left alone — this only targets the
// "used to have members, now has none" case.
export function pruneOrphanedMiniGroups(items: SceneItem[]): SceneItem[] {
  // #240: a group's members can be strands AND/OR miniAreas — count both as
  // "still alive" so a mixed group isn't wrongly pruned when only its strand
  // members survive (or vice versa).
  const memberIds = new Set(items.filter((i) => isStrand(i) || isMiniArea(i)).map((i) => i.id));
  return items.filter((item) => {
    if (!isMiniGroup(item)) return true;
    if (item.memberIds.length === 0) return true;
    return item.memberIds.some((id) => memberIds.has(id));
  });
}

// #741 defect 1 (round 2): drop every item tagged to `photoId` (plus any
// linked twin of one of those — it would otherwise dangle, render-only,
// forever, per #13), then prune any miniGroup left with zero surviving
// members. Pure — mirrors designs.ts's server-side removeDesignExtraPhoto
// prune exactly, and is shared by TWO call sites in editor.ts: the live-scene
// splice (removePhotoItems) AND the undo/redo history rewrite that must apply
// this identical edit to every snapshot already sitting in `past`/`future`,
// so that walking back (or forward) through history can never resurrect a
// deleted photo's items. Returns the SAME array reference when nothing on
// `items` is tagged to `photoId`, so callers can cheaply no-op.
export function removeItemsForPhoto(items: SceneItem[], photoId: string): SceneItem[] {
  const droppedIds = new Set(
    items.filter((it) => it.photoId === photoId).map((it) => it.id),
  );
  if (droppedIds.size === 0) return items;
  return pruneOrphanedMiniGroups(
    items.filter((it) => it.photoId !== photoId && !(it.linkedToId && droppedIds.has(it.linkedToId))),
  );
}
