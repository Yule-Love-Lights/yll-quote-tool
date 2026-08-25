import Konva from "konva";
// VENDOR ADAPTATION (Path B): types come from our local sceneTypes (not the
// design tool's ../api), the Fastify `api` client is replaced by our Supabase
// storage connector (createEditorApi, below), and the sibling renderers live in
// THIS folder (./). Everything else in this file is byte-identical with the
// design tool's canonical editor.ts — keep it that way.
import { isStrand, isWreath, isBow, isGarland, isSpritzer, isText, isCustom, isPole, isItemOnPhoto, type Design, type Scene, type SceneItem, type Strand, type StrandItem, type WreathItem, type BowItem, type GarlandItem, type SpritzerItem, type TextItem, type CustomItem, type CustomUpload, type PoleItem, type Yardstick, type BulbType, type DrawingStyle, type Surface, type RoofFeature, type SideOfHouse, type Tier, type WrapStyle, type QuoteWreathSize, type QuoteSpritzerSize, type QuoteGarlandLength, isMiniArea, isMiniGroup, isMiniGroupable, pruneOrphanedMiniGroups, removeItemsForPhoto, type MiniAreaItem, type MiniGroupItem } from "@/lib/design/sceneTypes";
import { addMiniGroupMembers, createMiniGroup, resolveMiniGroupSelection, setMiniGroupMemberSpacing, sharedMiniGroupColorPattern, updateMiniGroupMemberColorPatterns, updateSelectedColorPatterns } from "@/lib/design/miniGroupEdits";
import { createEditorApi, SceneConflictError } from "./storage";
import { COLORS, setPalette } from "./colors";
import { renderStrand, strandLengthPx } from "./strand";
import { createWreath } from "./wreath";
import { createBow } from "./bow";
import { renderGarland, garlandLengthPx } from "./garland";
import { createSpritzer } from "./spritzer";
import { renderText, fontsReady, FONT_OPTIONS, DEFAULT_TEXT_SIZE_IN, type FontFamily } from "./text";
import { createCustom } from "./custom";
import { createPole } from "./pole";
import { renderMiniArea } from "./miniArea";
import { LIGHT_SCALE_MAX, LIGHT_SCALE_MIN, normalizeLightScale } from "./lightScale";
import { preloadAssets } from "./assets";
import { renderYardstick, pxPerFoot, yardstickLabel } from "./yardstick";
import { DEFAULT_KEYMAP, resolveAction, type KeyMap } from "./keymap";
import {
  WREATH_SIZES,
  BOW_SIZES,
  GARLAND_SIZES,
  SPRITZER_SIZES,
  POLE_HEIGHTS,
  C9_SPACINGS,
  MINI_SPACINGS,
  BISTRO_SPACINGS,
  sizePresetLabel,
  formatRawSize,
  offPresetSizeSuffix,
} from "./sizePresets";
import { isLineDrawContext } from "./drawContext";
import { surfaceOptionsForBulbType } from "./surfaceOptions";
import { sideOfHouseOptions } from "./sideOfHouseOptions";
import { brightnessForPhoto, setBrightnessForPhoto, removeBrightnessForPhoto } from "@/lib/design/photoBrightness";
import { seedGroupStringCount } from "./miniGroupBilling";

// Default real-world width for newly-placed custom uploads — about 3 feet,
// big enough to spot on the photo, small enough to resize down with the
// Transformer if needed. Aspect is preserved from the natural image.
const DEFAULT_CUSTOM_WIDTH_IN = 36;

type PoleBaseType = PoleItem["baseType"];

// Renders a Size/Height quick-pick row's buttons (#202 F1): the 3 kept
// presets from `options`, PLUS -- when `values` is a single value that isn't
// one of them -- a 4th button showing the real stored number, marked active.
// That 4th button is how an off-preset item (an old design's dropped tier,
// a stale saved default loaded via applyDefaultsForCurrentType, or anything
// reached via the resize handles) stays visible, labeled, and clickable-back-
// to within the session, instead of the row rendering three unlit buttons
// with no indication of the item's actual size. Every button also gets a
// `title` with the real number, so hovering any preset confirms its exact
// inches/feet.
// `values` mirrors offPresetSizeSuffix (pass [tool.xSizeIn] for a single new-
// item value, or a bulk-edit panel's uniq'd `sharedSize`/`sharedHeight` --
// a mixed multi-select is `values.length > 1`, which gets no 4th button
// since there's no one number to show). `attr` picks the data attribute the
// existing click handlers already read (data-s for decor, data-h for poles)
// -- this only changes what's rendered into the row, not how clicks are
// wired: each render site's `querySelectorAll("#<row-id> button")` already
// wires every button in the container, this 4th one included.
function sizeButtons(options: readonly number[], values: number[], attr: "data-s" | "data-h", unit: "in" | "ft" = "in"): string {
  const isActive = (v: number) => values.length === 1 && values[0] === v;
  const preset = options
    .map((v) => `<button ${attr}="${v}" class="${isActive(v) ? "active" : ""}" title="${formatRawSize(v, unit)}">${sizePresetLabel(options, v)}</button>`)
    .join("");
  if (values.length !== 1 || sizePresetLabel(options, values[0]) !== null) return preset;
  const raw = formatRawSize(values[0], unit);
  return preset + `<button ${attr}="${values[0]}" class="active" title="${raw}">${raw}</button>`;
}

// Renders the whole "Spacing" quick-pick row (#248): the <h3> + the button
// row, for the new-tool draw panel (#spacings) and the select/bulk-edit
// panel (#sel-spacings) alike, so the two render sites can't drift apart.
// c9/mini/bistro get the S/M/L treatment (sizeButtons/offPresetSizeSuffix —
// the same #202 decor pattern, including its off-preset 4th "you are here"
// button for a legacy stored spacing the trim dropped, e.g. an old 36" c9
// strand). Permanent is explicitly excluded — S/M/L is degenerate for its
// single fixed option — and keeps the exact pre-#248 raw-inch rendering.
// `values` mirrors sizeButtons' contract: [tool.spacingIn] for the new-tool
// panel, or the bulk-edit panel's uniq'd `sharedSpacing` (mixed selections
// get no active button / no 4th button, same as decor's mixed-size case).
function spacingRowHtml(isPermanentType: boolean, options: number[], values: number[], containerId: string): string {
  if (isPermanentType) {
    const isActive = (v: number) => values.length === 1 && values[0] === v;
    return `
        <h3>Spacing (in)</h3>
        <div class="spacing-row" id="${containerId}">
          ${options.map((s) => `<button data-s="${s}" class="${isActive(s) ? "active" : ""}">${s}"</button>`).join("")}
        </div>`;
  }
  return `
        <h3>Spacing${offPresetSizeSuffix(options, values)}</h3>
        <div class="spacing-row" id="${containerId}">
          ${sizeButtons(options, values, "data-s")}
        </div>`;
}

const BULB_TYPES: { id: BulbType; label: string }[] = [
  { id: "c9", label: "C9" },
  { id: "permanent", label: "Permanent" },
  { id: "mini", label: "Mini" },
  { id: "bistro", label: "Bistro" },
];

// #248: trimmed to 3 values per type (Jason's picks), same shape as the
// decor size presets in sizePresets.ts. c9/mini/bistro get the S/M/L
// relabel (sizeButtons/offPresetSizeSuffix, below); permanent is excluded —
// a single fixed option has no small/medium/large to show — and stays a
// local literal here.
const SPACINGS: Record<BulbType, number[]> = {
  c9: C9_SPACINGS,
  mini: MINI_SPACINGS,
  // #88: permanent pucks ship 8" on-center ONLY — no other spacing is offered
  // (the BOM math already assumes 8"). Single fixed option.
  permanent: [8],
  bistro: BISTRO_SPACINGS,
};

const STYLES: { id: DrawingStyle; label: string }[] = [
  { id: "strand", label: "Strand" },
  { id: "trace", label: "Trace" },
  { id: "single", label: "Single" },
];

const STYLE_HELP: Record<DrawingStyle, string> = {
  strand: "Click and drag a straight line of lights.",
  trace: "Click to start. Click each bend. Press Enter or move off the photo to finish.",
  single: "Click to place a single bulb.",
};

// "Scattershot" is a lights-only 4th drawing style tracked by a LOCAL tool flag
// (tool.scattershot) — deliberately NOT added to the shared DrawingStyle type,
// which garland drawing also uses. It drag-draws a box that fills with
// scattered mini-lights (a MiniAreaItem; the internal kind stays "miniArea").
const SCATTERSHOT_HELP =
  "Click and drag a box — it fills with scattered mini-lights in the selected color pattern. Drag its corners after to refit; set fill density in the edit panel.";

type ItemCategory = "lights" | "decor" | "text" | "custom" | "poles";
type DecorType = "wreath" | "bow" | "garland" | "spritzer";

type ToolState = {
  category: ItemCategory;
  bulbType: BulbType;
  spacingIn: number;
  drawingStyle: DrawingStyle;
  // Lights-only local style flag — see SCATTERSHOT_HELP. When true, the
  // drawingStyle buttons render inactive and drags create mini-light areas.
  scattershot: boolean;
  colorPattern: string[];
  pickerColorId: string;
  // Type-specific defaults that get baked into new strands at creation time.
  // Lets users pre-configure the look BEFORE drawing — matches HHC's UX.
  beamLengthFt: number;
  beamWidthFt: number;
  distanceToSurfaceFt: number;
  opacity: number;
  showCoverage: boolean;
  showBeam: boolean;
  // Bistro-only: per-strand catenary sag as a fraction of horizontal span.
  bistroSagFactor: number;
  // #249: pre-draw billing-category tag — baked into new strands/mini areas at
  // creation time (see quoteDefaultsForNewStrand). "" = untagged (today's
  // default); only ever holds a value valid for the current bulbType (see the
  // #bulb-types click handler, which resets it on a type switch).
  surface: Surface | "";
  // #249 (permanent side-of-house pre-draw tag): same shape as `surface` above
  // but for permanent bulb type only — baked onto new permanent strands (see
  // quoteDefaultsForNewStrand). "" = untagged. Reset on leaving permanent (see
  // resetToolSideOfHouseIfInvalid).
  sideOfHouse: SideOfHouse | "";
  // Decor sub-type
  decorType: DecorType;
  // Decor — wreath
  wreathSizeIn: number;
  wreathWithLights: boolean;
  wreathWithBow: boolean;
  wreathColorId: string;
  // Decor — bow
  bowSizeIn: number;
  // Decor — garland (drawn strand-like, sized like wreath/bow)
  garlandSizeIn: number;
  garlandWithLights: boolean;
  // Decor — spritzer (procedural radial spray, like a firework starburst)
  spritzerSizeIn: number;
  spritzerColorPattern: string[];
  spritzerPickerColorId: string;
  // Text — its own top-level category
  textContent: string;
  textFont: FontFamily;
  textColorId: string;
  textOutline: boolean;
  // Custom — user-uploaded graphics, own top-level category
  customActiveUploadPath: string | null; // imagePath of the library entry currently armed for placement
  customAutoHalo: boolean;                // default glow setting for new placements
  // Poles — vertical supports for bistro lights, own top-level category
  poleHeightIn: number;
  poleBaseType: PoleBaseType;
};

export async function renderEditor(
  root: HTMLElement,
  designId: string,
  opts: { embedded?: boolean; onBack?: () => void; showQuoteBinding?: boolean; keymap?: KeyMap; activePhotoId?: string | null; permanentOnly?: boolean; bistroOnly?: boolean } = {},
): Promise<EditorHandle> {
  // (EditorHandle = the destroy fn + an optional flushSave — defined below.)
  // VENDOR ADAPTATION (Path B): storage connector bound to this design — talks
  // to our Supabase /api/designs routes in place of the design tool's Fastify
  // `api`. The rest of the file uses `api.*` exactly as upstream.
  const api = createEditorApi(designId);
  let design: Design;
  try {
    design = await api.getDesign(designId);
  } catch {
    if (!opts.embedded) window.location.hash = "#/";
    else root.innerHTML = `<div class="project-empty">Couldn't load this design.</div>`;
    return () => {};
  }

  // #13 multi-image: which photo of the design this mount edits. null = the
  // base photo (every pre-multi-image design). The background loads from the
  // matching extra photo; items are FILTERED to this photo at render and new
  // items are STAMPED with it. The host remounts the editor to switch photos,
  // so this is fixed for the lifetime of a mount. The full scene (including
  // other photos' items) stays in memory and is saved whole — doSave
  // serializes `scene`, never the stage.
  const activePhotoId = opts.activePhotoId ?? null;
  const activeExtra = activePhotoId
    ? (design.extraPhotos ?? []).find((p) => p.id === activePhotoId) ?? null
    : null;
  const extraPhotoIds = (design.extraPhotos ?? []).map((p) => p.id);
  const activeBgUrl = activePhotoId ? (activeExtra?.url ?? null) : design.photoUrl;
  // An item belongs to the mounted photo when its photoId matches (absent/null
  // = the base photo).
  const onActivePhoto = (item: { photoId?: string | null }) => isItemOnPhoto(item, activePhotoId);
  // Stamp a freshly-created item with the mounted photo. On the base photo the
  // fields stay untouched — byte-identical to pre-multi-image items. On an
  // extra, also drop any yardstick binding: yardsticks live on the base photo
  // only, so a cross-photo scale must never attach (extras carry no
  // measurement; staff size items visually).
  const stampPhoto = <T extends { photoId?: string | null; yardstickId?: string | null }>(item: T): T => {
    if (activePhotoId) {
      item.photoId = activePhotoId;
      item.yardstickId = null;
    }
    return item;
  };

  // ── #13 linked twins — "Place on this photo" ─────────────────────────────
  // Staff re-draw the whole display on every photo; a TWIN is a render-only
  // depiction of a canonical item from another photo (bills once, toggles/
  // recolors everywhere). Billable per-unit kinds only; mini GROUPS are
  // excluded (stamp members individually).
  const MINI_WRAP_SURFACES = new Set<string>(["bush", "tree", "column", "railing", "curtain"]);
  const isStampableCanonical = (i: SceneItem): boolean =>
    !i.linkedToId &&
    (isWreath(i) || isBow(i) || isGarland(i) || isSpritzer(i) ||
      // #240: a GROUPED scattershot is excluded too, same reason as the
      // grouped-strand exclusion just below — its extent is the group's, so
      // stamping just this one member alone wouldn't reflect the whole unit.
      (isMiniArea(i) && !i.groupId) ||
      (isStrand(i) && !i.groupId && MINI_WRAP_SURFACES.has(i.surface ?? "")) ||
      // #88 (S23): permanent roofline runs DO twin across photos (unlike holiday
      // roofline, which staff re-draw per photo) so a portal package toggle
      // hides/shows a side's lights on every angle it appears on.
      (isStrand(i) && i.bulbType === "permanent"));
  const stampCandidates = (): SceneItem[] =>
    scene.items.filter((i) => isStampableCanonical(i) && !onActivePhoto(i));
  const photoLabelOf = (i: { photoId?: string | null }): string => {
    const pid = i.photoId ?? null;
    if (!pid) return "Photo 1";
    const extras = design.extraPhotos ?? [];
    const idx = extras.findIndex((p) => p.id === pid);
    return extras[idx]?.title || `Photo ${idx + 2}`;
  };
  const stampLabel = (i: SceneItem): string =>
    isWreath(i) ? `${i.sizeIn}" wreath`
      : isBow(i) ? `${i.sizeIn}" bow`
        : isGarland(i) ? "garland run"
          : isSpritzer(i) ? `${i.sizeIn}" spritzer`
            : isMiniArea(i) ? `${i.surface ?? "bush"} minis`
              : isStrand(i) && i.bulbType === "permanent" ? `${i.sideOfHouse ?? "front"} roofline`
                : isStrand(i) ? `${i.surface ?? "mini"} wrap`
                  : "item";
  // Deep-copy the source, re-anchor its geometry at p, and mark it a twin of
  // the TRUE canonical (chains through if the source was somehow a twin).
  function makeTwinAt(src: SceneItem, p: { x: number; y: number }): SceneItem {
    const twin = JSON.parse(JSON.stringify(src)) as SceneItem;
    twin.id = cryptoId();
    twin.linkedToId = src.linkedToId ?? src.id;
    twin.yardstickId = null;
    delete (twin as { recommended?: boolean }).recommended;
    if (activePhotoId) twin.photoId = activePhotoId;
    else delete (twin as { photoId?: string | null }).photoId;
    if ("points" in twin && Array.isArray(twin.points) && twin.points.length >= 2) {
      const pts = twin.points;
      const n = pts.length / 2;
      let cx = 0, cy = 0;
      for (let k = 0; k + 1 < pts.length; k += 2) { cx += pts[k]; cy += pts[k + 1]; }
      cx /= n; cy /= n;
      const dx = p.x - cx, dy = p.y - cy;
      twin.points = pts.map((v, k) => (k % 2 === 0 ? v + dx : v + dy));
    } else if (isMiniArea(twin) && twin.shape === "box") {
      twin.x = p.x - (twin.width ?? 0) / 2;
      twin.y = p.y - (twin.height ?? 0) / 2;
    } else if ("x" in twin && "y" in twin) {
      (twin as { x: number; y: number }).x = p.x;
      (twin as { x: number; y: number }).y = p.y;
    }
    return twin;
  }

  root.innerHTML = `
    <div class="editor${opts.embedded ? " embedded" : ""}">
      <div class="topbar">
        <button class="icon" id="back" title="Back">←</button>
        <input class="title" id="name" />
        <span class="saving" id="saving"></span>
        <span class="spacer"></span>
        <div class="tool-toggle">
          <button id="tool-draw" class="active" title="Draw new strands">✎ Draw</button>
          <button id="tool-select" title="Drag a box to select multiple strands">⛶ Select</button>
        </div>
        <button id="undo-btn" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
        <button id="redo-btn" title="Redo (Ctrl+Shift+Z)" disabled>↷ Redo</button>
        <button id="ys-btn">+ Yardstick</button>
        <button id="zoom-out-btn" title="Zoom out (ctrl + scroll)">−</button>
        <button id="zoom-reset-btn" title="Reset zoom">100%</button>
        <button id="zoom-in-btn" title="Zoom in (ctrl + scroll)">+</button>
        <button id="settings-btn" title="App settings (palette, defaults)">⚙ Settings</button>
        <button id="dl-btn">Download</button>
      </div>
      <div class="stage-wrap" id="stage-wrap">
        <div id="stage-host" style="position:absolute;inset:0"></div>
        <div class="brightness" id="brightness-ui">
          <span class="ctl-label" title="Brightness applies to the photo you are viewing. Every other photo in this design keeps its own setting, so darkening a multi-photo design means adjusting each tab.">Brightness (this photo)</span>
          <span class="icon" title="Darker">${moonSvg()}</span>
          <div class="slider-wrap">
            <input type="range" min="0" max="100" value="50" id="brightness" title="This photo only. Double-click to reset to neutral." />
            <div class="neutral-tick" title="Neutral — original photo brightness"></div>
          </div>
          <span class="icon" title="Brighter">${sunSvg()}</span>
          <span class="ctl-sep"></span>
          <span class="ctl-label" title="How big the lights are drawn. Presentation only: this does not change footage or price.">Light size</span>
          <div class="slider-wrap narrow">
            <input type="range" min="${LIGHT_SCALE_MIN}" max="${LIGHT_SCALE_MAX}" step="0.1" value="1" id="light-scale" title="Double-click to reset to 1.0x" />
          </div>
          <span class="ctl-value" id="light-scale-val">1.0x</span>
        </div>
        <div class="stage-empty" id="empty"${activeBgUrl ? ' style="display:none"' : ""}>
          <div>${activePhotoId ? "This photo couldn't be loaded." : "Upload a photo of the house to get started."}</div>
          <button class="upload" id="upload-btn"${activePhotoId ? ' style="display:none"' : ""}>Upload Photo</button>
          <input type="file" id="upload-file" accept="image/*" style="display:none" />
        </div>
      </div>
      <aside class="sidebar" id="sidebar"></aside>
      <div class="bottombar">
        <div class="total" id="total">No strands yet</div>
      </div>
    </div>
  `;

  // --- State ---
  let scene: Scene = {
    ...design.scene,
    brightness: design.scene.brightness ?? 50,
    // Normalize on load, not just on edit: an older design has no field at
    // all, and a hand-edited scene JSON could carry 0 (invisible lights) or a
    // huge number. Seeding it here means every later read is already sane.
    lightScale: normalizeLightScale(design.scene.lightScale),
  };
  // #88/#117: a permanent (or permanent-bistro) quote's design is locked to
  // one bulb type so the operator only ever draws that type's runs.
  const initialBulbType: BulbType = opts.permanentOnly ? "permanent" : opts.bistroOnly ? "bistro" : "c9";
  // #248: the old shared "12" literal happened to sit inside all three
  // pre-trim SPACINGS lists; it isn't in c9's or bistro's trimmed lists
  // ([9,15,24] / [9,18,24]), so seed from SPACINGS' own middle (Medium)
  // value instead — mirrors the bulb-type click handler's clamp below and
  // keeps a freshly-opened tool showing a real preset active, never the
  // off-preset 4th button, matching the decor ToolState defaults' convention
  // of seeding the array's middle value.
  const initialSpacings = SPACINGS[initialBulbType];
  const tool: ToolState = {
    category: "lights",
    bulbType: initialBulbType,
    spacingIn: initialSpacings[Math.floor(initialSpacings.length / 2)],
    drawingStyle: "strand",
    scattershot: false,
    colorPattern: ["warm-white"],
    pickerColorId: "warm-white",
    beamLengthFt: 4,
    beamWidthFt: 1.7,
    distanceToSurfaceFt: 0,
    opacity: 1,
    showCoverage: false,
    showBeam: true,
    bistroSagFactor: 0.10,
    surface: "",
    sideOfHouse: "",
    decorType: "wreath",
    wreathSizeIn: 36,
    wreathWithLights: true,
    wreathWithBow: true,
    wreathColorId: "warm-white",
    bowSizeIn: 24,
    garlandSizeIn: 12,
    garlandWithLights: true,
    spritzerSizeIn: 24,
    spritzerColorPattern: ["warm-white"],
    spritzerPickerColorId: "warm-white",
    textContent: "Merry Christmas",
    textFont: "Oswald",
    textColorId: "black",
    textOutline: false,
    customActiveUploadPath: null,
    customAutoHalo: false,
    poleHeightIn: 120,
    poleBaseType: "cube",
  };

  // ----- Custom-upload library (server-persisted, shared across designs) -----
  // Fetched lazily on first entry to the Custom category and re-fetched after
  // upload/delete. Lives at editor scope so the sidebar can re-render against
  // the latest list without re-hitting the server every keystroke.
  let uploads: CustomUpload[] = [];
  let uploadsLoaded = false;
  async function ensureUploadsLoaded(): Promise<void> {
    if (uploadsLoaded) return;
    try {
      uploads = await api.listUploads();
    } catch {
      uploads = [];
    }
    uploadsLoaded = true;
  }
  async function refreshUploads(): Promise<void> {
    try {
      uploads = await api.listUploads();
    } catch {
      // Keep whatever we had on failure.
    }
    renderSidebar();
  }
  let activeYardstickId: string | null = scene.yardsticks[0]?.id ?? null;
  let creatingYardstick = false;
  let pendingYsFeet = 0;
  let ysDragStart: { x: number; y: number } | null = null;
  // #13 linked twins: the armed "Place on this photo" stamp source (one-shot,
  // creatingYardstick pattern) — the next stage click places a linked twin.
  let stampSourceId: string | null = null;

  // Strand drag state (for "strand" mode)
  let dragPts: number[] | null = null;
  // Trace polyline state (for "trace" mode) — accumulates committed points; last entry tracks the cursor.
  let tracePts: number[] | null = null;
  // #63: the existing item a strand-draw gesture started ON TOP of (if any). On a
  // click without a real drag we select it; on a drag we draw through it. Reset on
  // each mousedown, consumed on mouseup.
  let drawOverItemId: string | null = null;
  let drawPreview: Konva.Line | null = null;
  // Scattershot box-drag state (lights-only local style → commits a MiniAreaItem).
  let scattershotStart: { x: number; y: number } | null = null;
  // Mini-group / scattershot / spritzer edit panels: when armed (via "+ Add to pattern"),
  // the next color tap APPENDS to the pattern instead of replacing it.
  let mgAddArmed = false;
  let maAddArmed = false;
  let spAddArmed = false;

  // --- Tool mode ---
  // "draw" = clicks/drags create new strands (current behavior).
  // "select" = clicks/drags create a marquee rectangle to multi-select existing strands.
  type ToolMode = "draw" | "select";
  let toolMode: ToolMode = "draw";
  let marqueeStart: { x: number; y: number } | null = null;
  let marqueePreview: Konva.Rect | null = null;

  // --- Selection ---
  // Strands and yardsticks are mutually exclusive: selecting one clears the other.
  let selectedIds = new Set<string>();
  let selectedYardstickId: string | null = null;

  // --- Clipboard (Ctrl+C / Ctrl+V) ---
  // Holds deep clones of items copied from the scene. Paste creates fresh IDs
  // and offsets all items so their centroid lands at the cursor.
  let clipboard: SceneItem[] = [];
  // Most-recent cursor position in image-space; updated on stage mousemove.
  // Used as the paste anchor so Ctrl+V puts the new items wherever the mouse is.
  let lastImgPoint: { x: number; y: number } | null = null;

  // Persisted per-type defaults loaded from /api/settings/defaults at init.
  // We re-read this whenever the user switches bulb type so the relevant fields
  // (spacing, drawing style, color, perm-specific) jump to that type's defaults.
  let savedDefaults: Record<string, Record<string, unknown>> = {};

  // Look up a strand's yardstick (or fall back to the first yardstick if its own
  // was deleted; or null if no yardsticks exist).
  function yardstickForStrand(strand: Strand): Yardstick | null {
    const tied = strand.yardstickId
      ? scene.yardsticks.find((y) => y.id === strand.yardstickId)
      : undefined;
    return tied ?? scene.yardsticks[0] ?? null;
  }
  function ppfForStrand(strand: Strand): number {
    return pxPerFoot(yardstickForStrand(strand));
  }

  // Helper: filter scene.items down to strand items.
  // Used in many read paths where we need strand-specific props (bulbType, colorPattern, etc).
  // #13: photo-scoped — every allX() helper sees only the mounted photo's
  // items, so sidebar lists/counts, bulk ops, and select-alls can never touch
  // (or worse, bulk-delete) another photo's hidden items.
  function allStrands(): StrandItem[] {
    return scene.items.filter(isStrand).filter(onActivePhoto);
  }

  // --- Undo / redo history ---
  // past[] holds snapshots in chronological order; the current `scene` is the latest.
  // future[] is filled by undo() so we can redo.
  // We snapshot via structuredClone (JSON-safe deep clone).
  const snap = (s: Scene): Scene => JSON.parse(JSON.stringify(s)) as Scene;
  let past: Scene[] = [snap(scene)];
  let future: Scene[] = [];
  const HISTORY_LIMIT = 100;

  function commit() {
    // Push the CURRENT scene state. Only called after discrete user actions
    // (button click, slider drag end, strand drag end, etc.) — never per-frame.
    past.push(snap(scene));
    if (past.length > HISTORY_LIMIT) past.shift();
    future = [];
    updateUndoRedoButtons();
  }

  function undo() {
    if (past.length < 2) return;
    future.unshift(past.pop()!);
    scene = snap(past[past.length - 1]);
    selectedIds.clear();
    scheduleSave();
    redrawScene();
    // Row 348: redrawScene() only rebuilds the drawn items (bulbs resize via
    // activeLightScale(), read fresh off the reverted `scene`) — it never
    // touches the two slider controls or the tint layer. Left alone, both
    // sliders keep showing the pre-undo value (and, for brightness, the
    // canvas keeps the pre-undo tint too, since drawTint() also wasn't
    // called), so it reads as "did my undo actually work?" right where
    // staff most reach for Ctrl+Z. Resync all three explicitly.
    showLightScale(activeLightScale());
    brightnessEl.value = String(brightnessForPhoto(scene, activePhotoId));
    drawTint();
    updateUndoRedoButtons();
  }

  function redo() {
    const next = future.shift();
    if (!next) return;
    past.push(next);
    scene = snap(next);
    selectedIds.clear();
    scheduleSave();
    redrawScene();
    // Row 348: same resync as undo() above — see its comment.
    showLightScale(activeLightScale());
    brightnessEl.value = String(brightnessForPhoto(scene, activePhotoId));
    drawTint();
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    const ub = root.querySelector("#undo-btn") as HTMLButtonElement | null;
    const rb = root.querySelector("#redo-btn") as HTMLButtonElement | null;
    if (ub) ub.disabled = past.length < 2;
    if (rb) rb.disabled = future.length === 0;
  }

  // --- rAF-coalesced canvas redraw ---
  // Slider drags fire many `input` events per second; calling redrawScene() each time
  // is too heavy when rendering hundreds of permanent-light cones. We coalesce to one
  // redraw per animation frame.
  let redrawHandle = 0;
  function requestCanvasRedraw() {
    if (redrawHandle) return;
    redrawHandle = requestAnimationFrame(() => {
      redrawHandle = 0;
      redrawCanvas();
    });
  }

  // --- Konva stage ---
  const stageWrap = root.querySelector("#stage-wrap") as HTMLDivElement;
  const stageHost = root.querySelector("#stage-host") as HTMLDivElement;
  const stage = new Konva.Stage({
    container: stageHost,
    width: stageWrap.clientWidth,
    height: stageWrap.clientHeight,
  });
  const emptyEl = root.querySelector("#empty") as HTMLElement | null;
  if (emptyEl) emptyEl.style.zIndex = "10";
  const bgLayer = new Konva.Layer();
  const tintLayer = new Konva.Layer({ listening: false });
  const drawLayer = new Konva.Layer();
  // Dedicated UI layer on top so transformer + handles are never washed out by the bulb glow.
  const uiLayer = new Konva.Layer();
  stage.add(bgLayer);
  stage.add(tintLayer);
  stage.add(drawLayer);
  stage.add(uiLayer);

  // Konva Transformer — handles resize/rotate/drag on selected strand group(s).
  const transformer = new Konva.Transformer({
    rotateEnabled: true,
    anchorSize: 12,
    anchorStroke: "#4f8cff",
    anchorStrokeWidth: 2,
    anchorFill: "#ffffff",
    anchorCornerRadius: 2,
    borderStroke: "#4f8cff",
    borderStrokeWidth: 2,
    borderDash: [8, 5],
    keepRatio: false,
    rotateAnchorOffset: 30,
    enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right", "top-center", "bottom-center"],
  });
  uiLayer.add(transformer);

  // Yardsticks get their own transformer — no rotation (they're axis-aligned),
  // and a different accent color to match the yardstick selection styling.
  const yardstickTransformer = new Konva.Transformer({
    rotateEnabled: false,
    anchorSize: 12,
    anchorStroke: "#ffb454",
    anchorStrokeWidth: 2,
    anchorFill: "#ffffff",
    anchorCornerRadius: 2,
    borderStroke: "#ffb454",
    borderStrokeWidth: 2,
    borderDash: [8, 5],
    keepRatio: false,
    enabledAnchors: ["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right", "top-center", "bottom-center"],
  });
  uiLayer.add(yardstickTransformer);

  let bgImageNode: Konva.Image | null = null;
  let tintRect: Konva.Rect | null = null;
  let fitScale = 1;          // scale to fit photo into stage
  let userZoom = 1;          // ctrl+wheel zoom multiplier
  let panOffset = { x: 0, y: 0 }; // user pan offset (px, in stage coords)
  let stageOffset = { x: 0, y: 0 };  // computed = centering + panOffset
  let stageScale = 1;        // computed = fitScale * userZoom

  async function loadPhoto(url: string, w: number, h: number) {
    const img = await loadHTMLImage(url);
    bgImageNode?.destroy();
    bgImageNode = new Konva.Image({ image: img, width: w, height: h });
    bgLayer.add(bgImageNode);
    fitStage(w, h);
    bgLayer.batchDraw();
    drawTint();
  }

  function fitStage(imgW: number, imgH: number) {
    const cw = stageWrap.clientWidth;
    const ch = stageWrap.clientHeight;
    fitScale = Math.min(cw / imgW, ch / imgH);
    applyTransform(imgW, imgH);
  }

  function applyTransform(imgW?: number, imgH?: number) {
    const w = imgW ?? bgImageNode?.width() ?? 0;
    const h = imgH ?? bgImageNode?.height() ?? 0;
    const cw = stageWrap.clientWidth;
    const ch = stageWrap.clientHeight;
    stageScale = fitScale * userZoom;
    stageOffset = {
      x: (cw - w * stageScale) / 2 + panOffset.x,
      y: (ch - h * stageScale) / 2 + panOffset.y,
    };
    stage.size({ width: cw, height: ch });
    const s = { x: stageScale, y: stageScale };
    bgLayer.position(stageOffset).scale(s);
    tintLayer.position(stageOffset).scale(s);
    drawLayer.position(stageOffset).scale(s);
    uiLayer.position(stageOffset).scale(s);
    bgLayer.batchDraw();
    tintLayer.batchDraw();
    drawLayer.batchDraw();
    uiLayer.batchDraw();
  }

  function zoomAt(screenX: number, screenY: number, factor: number) {
    if (!bgImageNode) return;
    const oldZoom = userZoom;
    const newZoom = Math.max(0.5, Math.min(8, oldZoom * factor));
    if (newZoom === oldZoom) return;
    // Keep the image point under the cursor stationary in screen space.
    const imgX = (screenX - stageOffset.x) / stageScale;
    const imgY = (screenY - stageOffset.y) / stageScale;
    userZoom = newZoom;
    const newStageScale = fitScale * userZoom;
    const cw = stageWrap.clientWidth;
    const ch = stageWrap.clientHeight;
    const w = bgImageNode.width();
    const h = bgImageNode.height();
    const baseOffsetX = (cw - w * newStageScale) / 2;
    const baseOffsetY = (ch - h * newStageScale) / 2;
    panOffset.x = screenX - imgX * newStageScale - baseOffsetX;
    panOffset.y = screenY - imgY * newStageScale - baseOffsetY;
    applyTransform();
  }

  function resetZoom() {
    userZoom = 1;
    panOffset = { x: 0, y: 0 };
    applyTransform();
  }

  function drawTint() {
    tintRect?.destroy();
    tintRect = null;
    if (!bgImageNode) {
      tintLayer.batchDraw();
      return;
    }
    const b = brightnessForPhoto(scene, activePhotoId);
    if (b === 50) {
      tintLayer.batchDraw();
      return;
    }
    const w = bgImageNode.width();
    const h = bgImageNode.height();
    let fill: string;
    if (b < 50) {
      // Darken: heavy black-blue overlay so the photo can read as a true night scene.
      // t=0 → fully overlaid (~0.94 alpha, essentially pitch-black with a hint of blue);
      // t=50 → no overlay.
      const t = (50 - b) / 50;
      const a = Math.pow(t, 0.9) * 0.94;
      fill = `rgba(0,4,12,${a})`;
    } else {
      // Lighten: white-ish overlay (subtle wash).
      const a = ((b - 50) / 50) * 0.25;
      fill = `rgba(255,250,235,${a})`;
    }
    tintRect = new Konva.Rect({
      width: w,
      height: h,
      fill,
      listening: false,
    });
    tintLayer.add(tintRect);
    tintLayer.batchDraw();
  }

  function imagePoint(): { x: number; y: number } | null {
    const p = stage.getPointerPosition();
    if (!p) return null;
    return {
      x: (p.x - stageOffset.x) / stageScale,
      y: (p.y - stageOffset.y) / stageScale,
    };
  }

  function inPhoto(p: { x: number; y: number }): boolean {
    if (!bgImageNode) return false;
    return p.x >= 0 && p.y >= 0 && p.x <= bgImageNode.width() && p.y <= bgImageNode.height();
  }

  function activeYs(): Yardstick | null {
    return scene.yardsticks.find((y) => y.id === activeYardstickId) ?? scene.yardsticks[0] ?? null;
  }

  function redrawScene() {
    redrawCanvas();
    renderSidebar();
  }

  function redrawCanvas() {
    // Detach transformers before destroying children so they don't hold stale refs.
    transformer.nodes([]);
    yardstickTransformer.nodes([]);
    drawLayer.destroyChildren();

    let selectedYardstickNode: Konva.Group | null = null;
    // #13: yardsticks are a BASE-photo concern (measurement lives on photo 1 —
    // extras carry no scale). On an extra photo they neither render nor place.
    (activePhotoId ? [] : scene.yardsticks).forEach((ys, idx) => {
      const isSel = selectedYardstickId === ys.id;
      const g = renderYardstick(ys, yardstickLabel(idx), isSel);
      g.on("click tap", (e) => {
        e.cancelBubble = true;
        selectedIds.clear();
        selectedYardstickId = ys.id;
        redrawScene();
      });
      g.on("dragend", () => {
        // Bake new position into the yardstick state.
        scene = {
          ...scene,
          yardsticks: scene.yardsticks.map((y) =>
            y.id === ys.id ? { ...y, x: g.x(), y: g.y() } : y,
          ),
        };
        scheduleSave();
        commit();
        renderSidebar();
      });
      g.on("transformend", () => {
        bakeYardstickTransform(g, ys.id);
      });
      drawLayer.add(g);
      if (isSel) selectedYardstickNode = g;
    });

    const selectedItemNodes: Konva.Node[] = [];
    for (const item of scene.items) {
      // #13: render only the mounted photo's items. Other photos' items stay in
      // `scene.items` (and in every save — doSave serializes the array) but get
      // no nodes, so they can't be clicked, marquee'd, dragged, or deleted here.
      if (!onActivePhoto(item)) continue;
      let g: Konva.Group;
      if (isStrand(item)) {
        g = renderStrand(item, ppfForStrand(item), activeLightScale());
        g.draggable(true);
        g.on("transformend dragend", () => bakeTransformIntoStrand(g, item.id));
      } else if (isWreath(item)) {
        g = createWreath(item, ppfForActiveYardstick(), requestCanvasRedraw);
        g.on("transformend dragend", () => bakeTransformIntoWreath(g, item.id));
      } else if (isBow(item)) {
        g = createBow(item, ppfForActiveYardstick(), requestCanvasRedraw);
        g.on("transformend dragend", () => bakeTransformIntoBow(g, item.id));
      } else if (isGarland(item)) {
        g = renderGarland(item, ppfForGarland(item), requestCanvasRedraw);
        g.draggable(true);
        g.on("transformend dragend", () => bakeTransformIntoGarland(g, item.id));
      } else if (isSpritzer(item)) {
        g = createSpritzer(item, ppfForActiveYardstick(), activeLightScale());
        g.on("transformend dragend", () => bakeTransformIntoSpritzer(g, item.id));
      } else if (isText(item)) {
        g = renderText(item, ppfForActiveYardstick());
        g.on("transformend dragend", () => bakeTransformIntoText(g, item.id));
        g.on("dblclick dbltap", (e) => {
          e.cancelBubble = true;
          beginInPlaceTextEdit(g, item.id);
        });
      } else if (isCustom(item)) {
        g = createCustom(item, ppfForActiveYardstick(), requestCanvasRedraw);
        g.on("transformend dragend", () => bakeTransformIntoCustom(g, item.id));
      } else if (isPole(item)) {
        g = createPole(item, ppfForActiveYardstick());
        g.on("transformend dragend", () => bakeTransformIntoPole(g, item.id));
        // In bistro draw mode, mousedown on a pole must START A SPAN, not
        // drag the pole. Konva's built-in draggable handler would otherwise
        // grab the mousedown before the stage's draw handler can see it,
        // and we'd end up moving the pole instead of drawing.
        if (tool.category === "lights" && tool.bulbType === "bistro" && toolMode === "draw") {
          g.draggable(false);
        }
      } else if (isMiniArea(item)) {
        g = renderMiniArea(item, ppfForActiveYardstick(), activeLightScale());
        g.draggable(true);
        g.on("transformend dragend", () => bakeTransformIntoMiniArea(g, item.id));
      } else {
        continue;
      }
      g.setAttr("itemId", item.id);
      // #63: in strand-draw mode items render non-draggable, so a press-drag draws
      // THROUGH them instead of moving them (no drag arms → no dragend/bake). The
      // tool-change handlers redrawScene(), so this flag is always fresh.
      if (isStrandDrawContext()) g.draggable(false);
      g.on("click tap", (e) => {
        e.cancelBubble = true;
        // While tracing, clicks must continue the polyline — never select.
        if (tracePts) return;
        // #63: in strand-draw mode, selection is decided by the deferred
        // mousedown/mouseup draw logic (drag = draw-through, click = select) —
        // don't also select here.
        if (isStrandDrawContext()) return;
        // In bistro draw mode, clicks on poles must NOT select — they
        // start (or end) a bistro span. Without this, after dragging a
        // span from pole A to pole B the click event on pole B would
        // select it instead of leaving the new strand selected.
        if (
          isPole(item) &&
          tool.category === "lights" &&
          tool.bulbType === "bistro" &&
          toolMode === "draw"
        ) {
          return;
        }
        selectedYardstickId = null;
        const additive = e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey;
        if (!additive) selectedIds.clear();
        if (additive && selectedIds.has(item.id)) selectedIds.delete(item.id);
        else selectedIds.add(item.id);
        redrawScene();
      });
      drawLayer.add(g);
      if (selectedIds.has(item.id)) selectedItemNodes.push(g);
    }
    transformer.nodes(selectedItemNodes);
    // Image-backed items (wreath, bow) preserve aspect ratio while resizing so
    // they don't get squished. Strands and garlands are path geometry, so
    // free non-uniform scale is fine — scaling bakes into the polyline points
    // and the bulbs/stamps re-render at the same per-item size (strand bulbs
    // via pxPerFoot, garland stamps via item.sizeIn × pxPerFoot).
    const allImageItems =
      selectedItemNodes.length > 0 &&
      selectedItemNodes.every((n) => {
        const name = (n as Konva.Group).name();
        // Spritzers are radial too — keep-ratio scaling makes more sense than
        // free non-uniform stretch, even though they're procedural not PNG.
        // Text and custom uploads also keep ratio so their content doesn't
        // get squashed.
        return name === "wreath" || name === "bow" || name === "spritzer" || name === "text" || name === "custom";
      });
    const allPolesSelected =
      selectedItemNodes.length > 0 &&
      selectedItemNodes.every((n) => (n as Konva.Group).name() === "pole");
    transformer.keepRatio(allImageItems);
    // Poles get only the top-center anchor so dragging it changes height
    // while the base stays put on the ground; no rotation either since
    // poles are always vertical.
    transformer.rotateEnabled(!allPolesSelected);
    transformer.enabledAnchors(
      allPolesSelected
        ? ["top-center"]
        : ["top-left", "top-right", "bottom-left", "bottom-right", "middle-left", "middle-right", "top-center", "bottom-center"],
    );
    yardstickTransformer.nodes(selectedYardstickNode ? [selectedYardstickNode] : []);
    drawLayer.batchDraw();
    uiLayer.batchDraw();
  }

  // Wreaths size themselves using whatever yardstick is "active" right now.
  // (They don't have an own-yardstick concept yet — that'd be an easy add later.)
  function ppfForActiveYardstick(): number {
    return pxPerFoot(activeYs());
  }

  // The scene's light-size multiplier, read fresh on every render so the
  // slider updates the canvas live. Presentation only: this feeds the bulb
  // renderers and nothing that computes footage or price. Deliberately NOT
  // folded into ppfForActiveYardstick above, because px/ft is the money
  // number (footage = strand px / px/ft) and must stay untouched.
  function activeLightScale(): number {
    return normalizeLightScale(scene.lightScale);
  }

  // #13: all photo-scoped, like allStrands above.
  function allWreaths(): WreathItem[] {
    return scene.items.filter(isWreath).filter(onActivePhoto);
  }

  function allBows(): BowItem[] {
    return scene.items.filter(isBow).filter(onActivePhoto);
  }

  function allGarlands(): GarlandItem[] {
    return scene.items.filter(isGarland).filter(onActivePhoto);
  }

  function allSpritzers(): SpritzerItem[] {
    return scene.items.filter(isSpritzer).filter(onActivePhoto);
  }

  function allTexts(): TextItem[] {
    return scene.items.filter(isText).filter(onActivePhoto);
  }

  function allCustoms(): CustomItem[] {
    return scene.items.filter(isCustom).filter(onActivePhoto);
  }

  function allPoles(): PoleItem[] {
    return scene.items.filter(isPole).filter(onActivePhoto);
  }

  function allMiniAreas(): MiniAreaItem[] {
    return scene.items.filter(isMiniArea).filter(onActivePhoto);
  }

  // Garlands size themselves using their own yardstick (or the first one as
  // fallback if their own was deleted), same fall-back behavior as strands.
  function yardstickForGarland(g: GarlandItem): Yardstick | null {
    const tied = g.yardstickId
      ? scene.yardsticks.find((y) => y.id === g.yardstickId)
      : undefined;
    return tied ?? scene.yardsticks[0] ?? null;
  }
  function ppfForGarland(g: GarlandItem): number {
    return pxPerFoot(yardstickForGarland(g));
  }

  // Double-clicking a text item swaps the Konva text for an overlay textarea
  // positioned over it, so the user can type to edit the actual text content
  // in-place on the canvas. Commit on Enter (without Shift) or blur; cancel
  // on Escape.
  function beginInPlaceTextEdit(group: Konva.Group, textId: string) {
    const item = scene.items.find((i) => i.id === textId);
    if (!item || !isText(item)) return;
    const textNode = group.findOne<Konva.Text>(".text-letters");
    if (!textNode) return;
    // Hide the Konva text while editing so it doesn't double up with the
    // textarea (they'd overlap visually).
    textNode.visible(false);
    // Also hide selection chrome so it doesn't get in the way.
    transformer.nodes([]);
    drawLayer.batchDraw();
    uiLayer.batchDraw();

    // Position the textarea over the text's screen footprint. The group's
    // (x, y) is the text's visual center (we set offsetX/Y = w/2, h/2 in the
    // renderer), so the bounding box in screen coords is centered on the
    // group's absolute position scaled by the current stage scale.
    const stageContainer = stage.container();
    const containerRect = stageContainer.getBoundingClientRect();
    const groupAbs = group.getAbsolutePosition();
    const widthPx = textNode.width() * stageScale;
    const heightPx = textNode.height() * stageScale;
    // groupAbs already accounts for stage offset + scale + group rotation
    // origin. Position the textarea so its center matches the text center.
    const screenX = containerRect.left + groupAbs.x;
    const screenY = containerRect.top + groupAbs.y;

    const fontSizePx = textNode.fontSize() * stageScale;

    const textarea = document.createElement("textarea");
    textarea.value = item.text;
    textarea.style.position = "fixed";
    textarea.style.left = `${screenX - widthPx / 2}px`;
    textarea.style.top = `${screenY - heightPx / 2}px`;
    textarea.style.width = `${Math.max(120, widthPx)}px`;
    textarea.style.height = `${Math.max(40, heightPx)}px`;
    textarea.style.fontFamily = `'${item.fontFamily}', sans-serif`;
    textarea.style.fontSize = `${fontSizePx}px`;
    textarea.style.lineHeight = "1";
    textarea.style.color = "#ffffff";
    textarea.style.background = "rgba(0, 0, 0, 0.65)";
    textarea.style.border = "2px solid #4f8cff";
    textarea.style.borderRadius = "6px";
    textarea.style.padding = "4px 6px";
    textarea.style.outline = "none";
    textarea.style.zIndex = "1000";
    textarea.style.resize = "none";
    textarea.style.textAlign = "center";
    textarea.style.transform = item.rotation ? `rotate(${item.rotation}deg)` : "";
    textarea.style.transformOrigin = "center";
    textarea.style.boxShadow = "0 4px 24px rgba(0,0,0,0.5)";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    let committed = false;
    const cleanup = (newText: string | null) => {
      if (committed) return;
      committed = true;
      textarea.remove();
      textNode.visible(true);
      if (newText !== null && newText !== item.text) {
        scene = {
          ...scene,
          items: scene.items.map((i) =>
            i.id === textId && isText(i) ? { ...i, text: newText } : i,
          ),
        };
        scheduleSave();
        commit();
        redrawScene();
      } else {
        // No-op restore — just redraw to bring back the text + selection.
        redrawScene();
      }
    };

    textarea.addEventListener("blur", () => cleanup(textarea.value));
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        cleanup(textarea.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      }
      // Stop Ctrl+Z / Backspace etc. from bubbling to the editor-level
      // keyboard handler (which would undo a strand or delete a selection).
      e.stopPropagation();
    });
  }

  // Every transform/drag bake funnels its "persist + re-render" tail through
  // here. The redraw and the undo commit are DEFERRED and COALESCED into ONE
  // microtask per gesture. Why: a MULTI-item drag moves every selected node
  // together — Konva's Transformer proxies the drag to all attached nodes and
  // startDrag()s them, so each selected node fires its OWN dragend → its OWN
  // bake. Every sibling must fold its new position into the scene BEFORE we
  // re-render; a synchronous redrawScene() on the first dragend would destroy
  // the not-yet-baked sibling nodes and they'd snap back to their old spot —
  // the multi-select-move bug (#72). Coalescing commit() also makes a whole
  // multi-move a single undo step. Single-item bakes behave exactly as before,
  // just one microtask later (imperceptible — microtasks run before paint).
  let bakeFinalizeScheduled = false;
  function finishBake() {
    scheduleSave();
    if (bakeFinalizeScheduled) return;
    bakeFinalizeScheduled = true;
    queueMicrotask(() => {
      bakeFinalizeScheduled = false;
      if (destroyed) return;
      commit();
      redrawScene();
    });
  }

  // The pole's Transformer only exposes the top-center anchor, so dragging
  // it scales group.scaleY and keeps the base (bottom-center) anchored.
  // Bake scaleY into heightIn, reset scale, accept group's x/y as the new
  // base position (drag-to-move also lands here).
  function bakeTransformIntoPole(group: Konva.Group, poleId: string) {
    const cur = scene.items.find((i) => i.id === poleId);
    if (!cur || !isPole(cur)) return;
    const sy = group.scaleY();
    const newHeight = Math.max(8, cur.heightIn * sy);
    scene = {
      ...scene,
      items: scene.items.map((i) =>
        i.id === poleId && isPole(i)
          ? { ...i, x: group.x(), y: group.y(), heightIn: newHeight }
          : i,
      ),
    };
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // Same shape as wreath/bow/text bake — average X/Y scale into widthIn so
  // the image redraws at the new size with identity group transform. Flip
  // state is preserved (we never touch flipH/flipV here — those are toggled
  // via the edit panel, not the Transformer).
  function bakeTransformIntoCustom(group: Konva.Group, customId: string) {
    const cur = scene.items.find((i) => i.id === customId);
    if (!cur || !isCustom(cur)) return;
    const sx = group.scaleX();
    const sy = group.scaleY();
    const avgScale = (sx + sy) / 2;
    const newWidth = Math.max(4, cur.widthIn * avgScale);
    scene = {
      ...scene,
      items: scene.items.map((i) =>
        i.id === customId && isCustom(i)
          ? { ...i, x: group.x(), y: group.y(), widthIn: newWidth, rotation: group.rotation() }
          : i,
      ),
    };
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // Same wreath-style bake: average scale into sizeIn, reset, commit. Rotation
  // is included because text supports it (unlike spritzer / wreath / bow,
  // text orientation matters — slanted rooftop signs etc.).
  function bakeTransformIntoText(group: Konva.Group, textId: string) {
    const cur = scene.items.find((i) => i.id === textId);
    if (!cur || !isText(cur)) return;
    const sx = group.scaleX();
    const sy = group.scaleY();
    const avgScale = (sx + sy) / 2;
    const newSize = Math.max(4, cur.sizeIn * avgScale);
    scene = {
      ...scene,
      items: scene.items.map((i) =>
        i.id === textId && isText(i)
          ? { ...i, x: group.x(), y: group.y(), sizeIn: newSize, rotation: group.rotation() }
          : i,
      ),
    };
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // Same shape as wreath/bow bake — average the X/Y scale into sizeIn and
  // reset the transformer scale to 1 so the next render is identity. Radial
  // shape so a single sizeIn captures everything.
  function bakeTransformIntoSpritzer(group: Konva.Group, spritzerId: string) {
    const cur = scene.items.find((i) => i.id === spritzerId);
    if (!cur || !isSpritzer(cur)) return;
    const sx = group.scaleX();
    const sy = group.scaleY();
    const avgScale = (sx + sy) / 2;
    const newSize = Math.max(4, cur.sizeIn * avgScale);
    scene = {
      ...scene,
      items: scene.items.map((i) =>
        i.id === spritzerId && isSpritzer(i)
          ? { ...i, x: group.x(), y: group.y(), sizeIn: newSize }
          : i,
      ),
    };
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // Bake a miniArea move/resize back into the item. Box: position → x/y, scale →
  // width/height. Polygon: shift/scale the points by the group's transform.
  function bakeTransformIntoMiniArea(group: Konva.Group, areaId: string) {
    const cur = scene.items.find((i) => i.id === areaId);
    if (!cur || !isMiniArea(cur)) return;
    const sx = group.scaleX();
    const sy = group.scaleY();
    if (cur.shape === "polygon" && cur.points && cur.points.length >= 6) {
      let minX = Infinity, minY = Infinity;
      for (let i = 0; i + 1 < cur.points.length; i += 2) {
        minX = Math.min(minX, cur.points[i]);
        minY = Math.min(minY, cur.points[i + 1]);
      }
      const next = cur.points.map((p, i) =>
        i % 2 === 0 ? group.x() + (p - minX) * sx : group.y() + (p - minY) * sy,
      );
      scene = {
        ...scene,
        items: scene.items.map((i) => (i.id === areaId && isMiniArea(i) ? { ...i, points: next } : i)),
      };
    } else {
      const w = Math.max(4, (cur.width ?? 0) * sx);
      const h = Math.max(4, (cur.height ?? 0) * sy);
      scene = {
        ...scene,
        items: scene.items.map((i) =>
          i.id === areaId && isMiniArea(i) ? { ...i, x: group.x(), y: group.y(), width: w, height: h } : i,
        ),
      };
    }
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // After a Transformer move/rotate (no resize — anchors disabled for garland),
  // bake the group's transform back into the garland's point coordinates so
  // the next render uses an identity transform on the group again.
  function bakeTransformIntoGarland(group: Konva.Group, garlandId: string) {
    const cur = scene.items.find((i) => i.id === garlandId);
    if (!cur || !isGarland(cur)) return;
    const tx = group.x();
    const ty = group.y();
    const sx = group.scaleX();
    const sy = group.scaleY();
    const rot = (group.rotation() * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const newPts: number[] = [];
    for (let i = 0; i < cur.points.length; i += 2) {
      const x = cur.points[i] * sx;
      const y = cur.points[i + 1] * sy;
      newPts.push(tx + x * cos - y * sin, ty + x * sin + y * cos);
    }
    scene = {
      ...scene,
      items: scene.items.map((i) =>
        i.id === garlandId && isGarland(i) ? { ...i, points: newPts } : i,
      ),
    };
    finishBake();
  }

  // Bake the Transformer's scale into the wreath's stored sizeIn so the next
  // render uses a clean identity transform on the group (just x/y/rotation).
  function bakeTransformIntoWreath(group: Konva.Group, wreathId: string) {
    const cur = scene.items.find((i) => i.id === wreathId);
    if (!cur || !isWreath(cur)) return;
    const sx = group.scaleX();
    const sy = group.scaleY();
    const avgScale = (sx + sy) / 2; // wreath is round, average for safety
    const newSize = Math.max(6, cur.sizeIn * avgScale);
    scene = {
      ...scene,
      items: scene.items.map((i) =>
        i.id === wreathId && isWreath(i)
          ? { ...i, x: group.x(), y: group.y(), sizeIn: newSize, rotation: group.rotation() }
          : i,
      ),
    };
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // Same as bakeTransformIntoWreath but for bows. keepRatio is on for bows too,
  // so sx ≈ sy; we average for safety.
  function bakeTransformIntoBow(group: Konva.Group, bowId: string) {
    const cur = scene.items.find((i) => i.id === bowId);
    if (!cur || !isBow(cur)) return;
    const sx = group.scaleX();
    const sy = group.scaleY();
    const avgScale = (sx + sy) / 2;
    const newSize = Math.max(6, cur.sizeIn * avgScale);
    scene = {
      ...scene,
      items: scene.items.map((i) =>
        i.id === bowId && isBow(i)
          ? { ...i, x: group.x(), y: group.y(), sizeIn: newSize, rotation: group.rotation() }
          : i,
      ),
    };
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // After the user drags a Transformer anchor on a yardstick, bake the scale into
  // width/height and reset scale to 1. Also commit the new position.
  function bakeYardstickTransform(group: Konva.Group, ysId: string) {
    const rect = group.findOne<Konva.Rect>(".yardstick-rect");
    if (!rect) return;
    const sx = group.scaleX();
    const sy = group.scaleY();
    const newWidth = Math.max(8, rect.width() * sx);
    const newHeight = Math.max(4, rect.height() * sy);
    scene = {
      ...scene,
      yardsticks: scene.yardsticks.map((y) =>
        y.id === ysId
          ? { ...y, x: group.x(), y: group.y(), width: newWidth, height: newHeight }
          : y,
      ),
    };
    // Reset the group transform so the next redraw uses identity scale.
    group.scaleX(1);
    group.scaleY(1);
    finishBake();
  }

  // After a Transformer move/scale/rotate, fold the group's transform back into the strand's
  // point coordinates so re-render produces an identity transform on the group again.
  function bakeTransformIntoStrand(group: Konva.Group, strandId: string) {
    const strand = scene.items.find((s) => s.id === strandId);
    if (!strand || !isStrand(strand)) return;
    const tx = group.x();
    const ty = group.y();
    const sx = group.scaleX();
    const sy = group.scaleY();
    const rot = (group.rotation() * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const newPts: number[] = [];
    for (let i = 0; i < strand.points.length; i += 2) {
      const x = strand.points[i] * sx;
      const y = strand.points[i + 1] * sy;
      newPts.push(tx + x * cos - y * sin, ty + x * sin + y * cos);
    }
    scene = {
      ...scene,
      items: scene.items.map((s) => (s.id === strandId ? { ...s, points: newPts } : s)),
    };
    finishBake();
  }

  function clearSelection() {
    if (selectedIds.size === 0 && !selectedYardstickId) return;
    selectedIds.clear();
    selectedYardstickId = null;
    redrawScene();
  }

  // #99: marquee select on TOUCH — select any item (of the active tool category)
  // whose RENDERED bounds overlap the marquee, rather than only items fully
  // enclosed or whose center is inside. Uses each item's Konva bounding box in
  // layer coordinates (the same space the marquee rect is built in).
  function selectMatchingInRect(x1: number, y1: number, x2: number, y2: number) {
    selectedYardstickId = null;
    // Build id → rendered node once. Items are direct children of drawLayer, each
    // tagged with an "itemId" attr (see redrawScene); the marquee preview + other
    // chrome have no itemId so they're skipped.
    const nodeById = new Map<string, Konva.Node>();
    for (const n of drawLayer.getChildren()) {
      const id = n.getAttr("itemId");
      if (typeof id === "string") nodeById.set(id, n);
    }
    // AABB overlap of the item's rendered bounds with the marquee (touch counts).
    const touches = (id: string): boolean => {
      const node = nodeById.get(id);
      if (!node) return false;
      const r = node.getClientRect({ relativeTo: drawLayer });
      return r.x <= x2 && r.x + r.width >= x1 && r.y <= y2 && r.y + r.height >= y1;
    };
    let matchIds: string[];
    if (tool.category === "decor" && tool.decorType === "wreath") {
      matchIds = allWreaths().filter((w) => touches(w.id)).map((w) => w.id);
    } else if (tool.category === "decor" && tool.decorType === "bow") {
      matchIds = allBows().filter((b) => touches(b.id)).map((b) => b.id);
    } else if (tool.category === "decor" && tool.decorType === "spritzer") {
      matchIds = allSpritzers().filter((s) => touches(s.id)).map((s) => s.id);
    } else if (tool.category === "text") {
      matchIds = allTexts().filter((t) => touches(t.id)).map((t) => t.id);
    } else if (tool.category === "custom") {
      matchIds = allCustoms().filter((c) => touches(c.id)).map((c) => c.id);
    } else if (tool.category === "poles") {
      matchIds = allPoles().filter((p) => touches(p.id)).map((p) => p.id);
    } else if (tool.category === "decor" && tool.decorType === "garland") {
      matchIds = allGarlands().filter((g) => touches(g.id)).map((g) => g.id);
    } else if (tool.category === "lights" && tool.scattershot) {
      matchIds = allMiniAreas().filter((a) => touches(a.id)).map((a) => a.id);
    } else {
      // Strand items of the active bulb type whose rendered bounds touch the box.
      matchIds = allStrands()
        .filter((s) => s.bulbType === tool.bulbType && touches(s.id))
        .map((s) => s.id);
    }
    selectedIds = new Set(matchIds);
    redrawScene();
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    // #13 linked twins: deleting a CANONICAL removes its render-only twins on
    // every photo (they'd dangle otherwise); deleting a twin removes just that
    // depiction — the canonical (and the billing) is untouched.
    // #227: pruneOrphanedMiniGroups drops any miniGroup left with zero
    // surviving member strands by this delete (it would otherwise render
    // nothing, be unselectable, and keep billing forever).
    scene = {
      ...scene,
      items: pruneOrphanedMiniGroupsNotify(scene.items.filter(
        (s) => !selectedIds.has(s.id) && !(s.linkedToId && selectedIds.has(s.linkedToId)),
      )),
    };
    selectedIds.clear();
    // Discrete keyboard action — not a multi-node Transformer gesture — so the
    // redraw stays SYNCHRONOUS here. finishBake()'s deferred coalescing is only
    // needed for the drag/transform bakes that fire one dragend per node (#72).
    scheduleSave();
    commit();
    redrawScene();
  }

  // ============================================================
  // Copy / paste (Ctrl+C / Ctrl+V)
  // ============================================================

  // Average position of every "point" across the items — polyline points for
  // strands/garlands; (x, y) for wreaths/bows. Used as the anchor that lands
  // on the cursor when pasting, so multi-item paste preserves relative layout.
  function centroidOf(items: SceneItem[]): { x: number; y: number } {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const it of items) {
      if (isStrand(it) || isGarland(it)) {
        for (let i = 0; i < it.points.length; i += 2) {
          sx += it.points[i];
          sy += it.points[i + 1];
          n++;
        }
      } else if (isWreath(it) || isBow(it) || isSpritzer(it) || isText(it) || isCustom(it) || isPole(it)) {
        sx += it.x;
        sy += it.y;
        n++;
      } else if (isMiniArea(it)) {
        if (it.shape === "polygon" && it.points) {
          for (let i = 0; i < it.points.length; i += 2) {
            sx += it.points[i];
            sy += it.points[i + 1];
            n++;
          }
        } else {
          sx += it.x ?? 0;
          sy += it.y ?? 0;
          n++;
        }
      }
    }
    return n === 0 ? { x: 0, y: 0 } : { x: sx / n, y: sy / n };
  }

  // Translate a single item by (dx, dy). Strands/garlands shift their polyline
  // points; wreaths/bows shift their (x, y) center.
  function shiftItem(it: SceneItem, dx: number, dy: number): SceneItem {
    if (isStrand(it)) {
      return {
        ...it,
        points: it.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
      };
    }
    if (isGarland(it)) {
      return {
        ...it,
        points: it.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
      };
    }
    if (isWreath(it) || isBow(it) || isSpritzer(it) || isText(it) || isCustom(it) || isPole(it)) {
      return { ...it, x: it.x + dx, y: it.y + dy };
    }
    if (isMiniArea(it)) {
      if (it.shape === "polygon" && it.points) {
        return {
          ...it,
          points: it.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
        };
      }
      return { ...it, x: (it.x ?? 0) + dx, y: (it.y ?? 0) + dy };
    }
    return it;
  }

  function copySelectedToClipboard() {
    if (selectedIds.size === 0) return;
    // Deep-clone via JSON to fully detach from the live scene.
    clipboard = scene.items
      .filter((i) => selectedIds.has(i.id))
      .map((i) => JSON.parse(JSON.stringify(i)) as SceneItem);
  }

  function pasteFromClipboard() {
    if (clipboard.length === 0) return;
    // Anchor: cursor position if we have one, otherwise a +20px nudge from
    // the originals so the paste is at least visible.
    const centroid = centroidOf(clipboard);
    const target = lastImgPoint ?? { x: centroid.x + 20, y: centroid.y + 20 };
    const dx = target.x - centroid.x;
    const dy = target.y - centroid.y;
    const newItems: SceneItem[] = clipboard.map((it) => {
      const cloned = JSON.parse(JSON.stringify(it)) as SceneItem;
      cloned.id = cryptoId();
      cloned.linkedToId = undefined;
      if ("groupId" in cloned) cloned.groupId = undefined;
      return shiftItem(cloned, dx, dy);
    });
    scene = { ...scene, items: [...scene.items, ...newItems] };
    selectedIds = new Set(newItems.map((i) => i.id));
    selectedYardstickId = null;
    // Discrete keyboard action (not a multi-node Transformer gesture) → the
    // redraw stays SYNCHRONOUS; finishBake()'s coalescing is only for the
    // per-node drag/transform bakes (#72).
    scheduleSave();
    commit();
    redrawScene();
  }

  // --- Save (debounced) ---
  let saveTimer: number | null = null;
  let pendingSave = false;
  let retryTimer: number | null = null;
  let saveSeq = 0;
  // Ledger row 260: true once the server has rejected a save with a scene
  // version conflict (a concurrent writer — another tab, another operator, a
  // server-side re-seed — won the race). Saving is BLOCKED from here on; the
  // operator must reload to see the current design before editing again. This
  // is deliberately the only way out — reload-and-reapply-the-edit is a real
  // design decision this fix doesn't make; see showConflictBanner().
  let conflicted = false;
  // Ledger row 260: every doSave() call chains onto this tail instead of
  // firing its own overlapping PUT. Without this, two saves in flight at once
  // (a slow autosave overlapping a forced #741 corrective save, or a retry
  // racing a fresh edit) would both read the SAME `design.version` and send
  // it — the CAS then rejects whichever lands second with a 409 that's
  // actually just this client's own earlier write, not a real external
  // conflict. Serializing means each queued save always uses the freshest
  // scene + the freshest known version, and a caller awaiting doSave()'s
  // return value (flushSave) genuinely waits for everything queued so far.
  let saveTail: Promise<void> = Promise.resolve();
  const savingEl = root.querySelector("#saving") as HTMLElement;
  function doSave(): Promise<void> {
    saveTail = saveTail.then(() => (conflicted ? undefined : runSave()));
    return saveTail;
  }
  async function runSave() {
    // AUDIT FIX (editor-autosave-honest-failure): the PUT can throw on any
    // non-2xx. Previously pendingSave was cleared BEFORE the await and there was
    // no try/catch, so a failed save dropped the billable edit while the pill
    // still read "Saved". Keep pendingSave true until the write actually lands;
    // on failure surface an honest state + schedule a backoff retry (the PUT
    // writes the whole scene, so a later retry self-heals).
    // AUDIT FIX (W3-008): saves are now serialized (see doSave()), so this is
    // belt-and-suspenders rather than load-bearing — kept as a cheap guard
    // against a future regression that reintroduces overlap.
    const seq = ++saveSeq;
    try {
      const result = await api.updateDesign(design.id, { scene, name: design.name, version: design.version ?? null });
      if (typeof result.version === "number") design.version = result.version;
    } catch (err) {
      if (err instanceof SceneConflictError) {
        // Fix round (HIGH, four-lens review): this branch must run BEFORE the
        // `destroyed` early-return below. destroy()'s final teardown flush
        // calls runSave() with `destroyed` already true — and this function
        // always RESOLVES rather than rejects on a caught error, so
        // destroy()'s own `flushSave().catch(...)` (which sets the same
        // marker) never fires either. Without this, a conflict on that last
        // flush was swallowed completely: no banner (nothing left to show it
        // to — correct), but also no recovery marker, so the operator's last
        // edit vanished with no trace. Record the marker for the CURRENT
        // save attempt (seq === saveSeq — a stale/superseded attempt has
        // already been overtaken by a newer save and recording it here would
        // be a false positive) regardless of destroyed; UI updates still
        // only happen on the live (non-destroyed) path below.
        if (seq === saveSeq) {
          try { localStorage.setItem("editorUnsavedDesign", design.id); } catch { /* storage unavailable */ }
        }
        if (destroyed || seq !== saveSeq) return;
        // Ledger row 260: a lost race, NOT a transient failure — do not retry
        // (retrying would just resend the same now-stale overwrite forever).
        // Block further saves and tell the operator plainly.
        conflicted = true;
        pendingSave = false; // the queued edit is NOT persisted, but nothing further will attempt it — see showConflictBanner()
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        savingEl.textContent = "Save blocked — reload";
        showConflictBanner();
        return;
      }
      if (destroyed || seq !== saveSeq) return;
      pendingSave = true; // edit not persisted — keep it queued
      savingEl.textContent = "Save failed — retry";
      if (!retryTimer) {
        retryTimer = window.setTimeout(() => { retryTimer = null; void doSave(); }, 4000);
      }
      return;
    }
    // Don't touch the (possibly detached) DOM if we were torn down mid-flight.
    if (destroyed) { pendingSave = false; return; }
    if (seq !== saveSeq) return;
    pendingSave = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    clearUnsavedBanner(); // a successful write clears any stale "unsaved" marker
    savingEl.textContent = "Saved";
    window.setTimeout(() => {
      if (savingEl.textContent === "Saved") savingEl.textContent = "";
    }, 1500);
  }
  // Ledger row 260: a persistent, non-auto-dismissing notice — unlike
  // showTransientNotice, this stays until the operator reloads. Styled INLINE
  // for the same reason showTransientNotice is (see its comment above): this
  // file travels unchanged into the standalone design tool, which has no rule
  // for a class this repo invents.
  function showConflictBanner() {
    if (root.querySelector("#scene-conflict-banner")) return; // already shown
    const host = root.querySelector(".editor");
    if (!host) return;
    const banner = document.createElement("div");
    banner.id = "scene-conflict-banner";
    banner.style.cssText = [
      "position:fixed", "top:12px", "left:50%", "transform:translateX(-50%)", "z-index:9999",
      "max-width:min(90vw,480px)", "padding:10px 14px", "border-radius:8px",
      "background:#7a1f1f", "color:#fff2f2", "border:1px solid rgba(255,255,255,0.25)",
      "box-shadow:0 4px 14px rgba(0,0,0,0.35)", "font-size:13px", "line-height:1.4",
      "text-align:center",
    ].join(";");
    banner.textContent = "This design changed elsewhere — your recent edits here are NOT saved. ";
    const btn = document.createElement("button");
    btn.textContent = "Reload";
    btn.style.cssText = "margin-left:6px;text-decoration:underline;cursor:pointer;background:none;border:none;color:inherit;font:inherit;padding:0;";
    // Fix round (MED, four-lens review): a bare reload() here silently
    // discarded more than just this banner's already-lost scene edit — this
    // editor is often EMBEDDED in a page with its OWN unrelated unsaved form
    // state (the quote builder's pricing overrides, line items) that a
    // reload would wipe with no warning at all. A confirm is the simplest
    // guard, not a state-preservation system — consistent with this file's
    // constraint of staying framework-free (it travels unchanged into the
    // standalone design tool, which has no rule for a class this repo
    // invents).
    btn.addEventListener("click", () => {
      if (window.confirm("Reload now? Any other unsaved changes on this page will also be lost.")) {
        window.location.reload();
      }
    });
    banner.appendChild(btn);
    host.prepend(banner);
  }
  function scheduleSave() {
    if (conflicted) return; // #260: blocked until reload — see showConflictBanner()
    if (saveTimer) clearTimeout(saveTimer);
    pendingSave = true;
    savingEl.textContent = "Saving…";
    saveTimer = window.setTimeout(() => { void doSave(); }, 600);
  }
  // Synchronously persist a pending debounced save NOW (no-op if none pending).
  async function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (pendingSave) await doSave();
  }
  // #741 defect 1: cancel any pending debounced save WITHOUT persisting it.
  // destroy() unconditionally best-effort flushes on teardown (below) — that's
  // right for a normal navigate-away/unmount, but wrong for a caller-forced
  // remount that follows a server-side change already landing (a photo
  // delete's prune, a re-analyze's reseed): the resident `scene` this mount
  // holds predates that change, so flushing it would PUT it straight back
  // over the server's fresh row, resurrecting exactly what the server just
  // removed. The caller awaits the server response, then calls this BEFORE
  // triggering the remount, so destroy()'s flushSave() becomes a no-op.
  // Trade-off: a genuine edit made during that round trip is discarded too —
  // accepted, since resurrecting deleted/pruned billing is the worse failure.
  // #741 defect 6: returns whether it actually discarded a real pending edit
  // (vs. the common no-op case where the caller's own pre-action flush
  // already cleared everything) so the caller can tell the operator their
  // in-progress edit was thrown away, instead of losing it silently.
  function discardPending(): boolean {
    const hadPending = pendingSave;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    pendingSave = false;
    return hadPending;
  }
  // AUDIT FIX (editor-autosave-honest-failure): non-blocking banner shown when a
  // prior teardown flush may have failed to persist (marker set in destroy()).
  // Cleared on the next successful doSave().
  function clearUnsavedBanner() {
    try { localStorage.removeItem("editorUnsavedDesign"); } catch { /* storage unavailable */ }
    root.querySelector("#unsaved-banner")?.remove();
  }
  function showUnsavedBannerIfNeeded() {
    let stored: string | null = null;
    try { stored = localStorage.getItem("editorUnsavedDesign"); } catch { /* storage unavailable */ }
    if (stored !== design.id) return;
    if (root.querySelector("#unsaved-banner")) return;
    const banner = document.createElement("div");
    banner.id = "unsaved-banner";
    banner.className = "unsaved-banner";
    banner.textContent = "Some earlier edits may not have saved. Make any change to re-save.";
    root.querySelector(".editor")?.prepend(banner);
  }

  // #227 FIX 3: a miniGroup's `stringCount` is a deliberate staff billing
  // decision, and pruneOrphanedMiniGroups deletes it silently at every call
  // site below — including the one that already confirms the STRAND deletion
  // but never mentions the group it takes with it. A confirm dialog would
  // over-interrupt routine strand cleanup, so this is a non-blocking,
  // auto-dismissing notice instead.
  //
  // Styled INLINE and positioned FIXED on purpose. The first cut reused
  // showUnsavedBannerIfNeeded's bare `prepend` + className pattern, but that
  // class has no CSS rule anywhere in this repo — so the notice rendered as a
  // full-width, normal-flow block that shoved the whole canvas down the page
  // (caught on Jason's device check). Inline styles also travel with the file
  // when it is hand-relayed into the standalone design tool, which has its own
  // separate stylesheet — a class-based fix would silently render unstyled
  // there for exactly the same reason.
  const MINI_SURFACE_LABELS: Record<string, string> = {
    bush: "Bush", tree: "Tree", column: "Column", railing: "Railing", curtain: "Curtain",
  };
  function showTransientNotice(text: string) {
    const host = root.querySelector(".editor");
    if (!host) return;
    const n = document.createElement("div");
    n.className = "transient-notice";
    n.textContent = text;
    // Stack downward if several groups are pruned by one delete, so notices
    // don't render on top of each other.
    const offset = root.querySelectorAll(".transient-notice").length * 40;
    n.style.cssText = [
      "position:fixed",
      `top:${12 + offset}px`,
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:9999",
      "pointer-events:none",
      "max-width:min(90vw,420px)",
      "padding:8px 14px",
      "border-radius:8px",
      "background:rgba(24,24,27,0.95)",
      "color:#fafafa",
      "border:1px solid rgba(250,250,250,0.15)",
      "box-shadow:0 4px 14px rgba(0,0,0,0.35)",
      "font-size:13px",
      "line-height:1.35",
      "text-align:center",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
    ].join(";");
    host.appendChild(n);
    window.setTimeout(() => n.remove(), 5000);
  }
  // #249/#753 review fix: clears tool.surface the moment it's no longer valid
  // for the current bulbType/scattershot combo (e.g. a c9-only tag surviving
  // a switch to mini, or "curtain" surviving a switch into Scattershot) and
  // tells the operator via a transient notice — reusing showTransientNotice
  // rather than inventing a second mechanism (mirrors
  // pruneOrphanedMiniGroupsNotify's silent-correction notice below). Without
  // this, a silently-reset tag could leave the operator drawing several
  // untagged items before noticing the row flipped to None.
  function resetToolSurfaceIfInvalid(contextLabel: string) {
    if (!tool.surface) return;
    const stillValid = surfaceOptionsForBulbType(tool.bulbType, { scattershot: tool.scattershot }).some(
      ([v]) => v === tool.surface,
    );
    if (stillValid) return;
    showTransientNotice(`Surface tag cleared — pick again for ${contextLabel}.`);
    tool.surface = "";
  }
  // #249 (side-of-house pre-draw tag): mirrors resetToolSurfaceIfInvalid above
  // — clears tool.sideOfHouse the moment the bulb type leaves permanent (the
  // only bulb type the pre-draw section applies to) and tells the operator via
  // the same transient-notice mechanism, so a stale tag can't silently survive
  // a switch away and mis-tag the next item drawn after switching back.
  function resetToolSideOfHouseIfInvalid(contextLabel: string) {
    if (!tool.sideOfHouse) return;
    if (tool.bulbType === "permanent") return;
    showTransientNotice(`Side of house tag cleared — pick again for ${contextLabel}.`);
    tool.sideOfHouse = "";
  }
  // Wraps pruneOrphanedMiniGroups: diffs which miniGroup item(s) it actually
  // dropped and surfaces one notice per group. Every call site below should
  // call THIS, not pruneOrphanedMiniGroups directly.
  function pruneOrphanedMiniGroupsNotify(items: SceneItem[]): SceneItem[] {
    const before = items.filter(isMiniGroup);
    const after = pruneOrphanedMiniGroups(items);
    if (after.length === items.length) return after; // nothing pruned — the common case
    const afterIds = new Set(after.filter(isMiniGroup).map((g) => g.id));
    before.filter((g) => !afterIds.has(g.id)).forEach((g) => {
      const label = MINI_SURFACE_LABELS[g.surface ?? ""] ?? "group";
      const n = g.stringCount ?? 1;
      showTransientNotice(`Also removed empty group: ${label} — ${n} string${n === 1 ? "" : "s"}`);
    });
    return after;
  }
  // #741 defect 2: splice a deleted photo's items out of the RESIDENT
  // in-memory scene WITHOUT tearing the editor down — for when the deleted
  // photo is NOT the one this mount is showing. A full remount there would
  // reset zoom/selection/undo history and silently drop any in-progress
  // drawing that lives only in editor-local closures (never in scene.items,
  // so no flush could have saved it) — routine work for an operator who was
  // simply cleaning up a stray extra-photo tab. Mirrors designs.ts's
  // removeDesignExtraPhoto server-side prune exactly: drop items tagged to
  // the deleted photo, drop any linked twin of one of those (it would
  // otherwise dangle, render-only, forever), then prune any miniGroup left
  // with zero surviving members. Once this returns, the resident scene
  // matches server truth, so a later teardown flush is harmless.
  function removePhotoItems(photoId: string, serverVersion?: number | null) {
    // Row 371 (staff lens HIGH): adopt the version the server's own prune just
    // wrote, BEFORE the no-op early-return below. `design.version` is otherwise
    // only ever refreshed from this editor's own save response (runSave), so a
    // server-side prune left this still-mounted editor one version behind and
    // the next save — of a completely unrelated edit, on a surviving photo —
    // lost the CAS and hit the "Save blocked — reload" banner, discarding that
    // edit. Adopting a version that is merely OLD is safe: it can only lose the
    // CAS again, which is the correct outcome for a genuine outside write.
    // Ordered first on purpose: a deleted photo carrying NO drawn items still
    // bumps the version (its brightness entry is pruned), and that is exactly
    // the case the early-return below skips.
    if (typeof serverVersion === 'number') design.version = serverVersion;

    // Row 371 fix round (delta-verify MED): prune the deleted photo's
    // brightness override from the RESIDENT scene too. This is not cosmetic
    // bookkeeping — adopting the version above means the next autosave now
    // SUCCEEDS its CAS, and an autosave writes the whole scene, so a client
    // still holding the key would write it straight back over the server's
    // prune and resurrect the exact orphan this row exists to remove. Same
    // pure helper the server prune uses, so the two cannot drift.
    const prunedScene = removeBrightnessForPhoto(scene, photoId);
    const nextItems = removeItemsForPhoto(scene.items, photoId);
    // Both comparisons are REFERENCE checks by contract: removeItemsForPhoto and
    // removeBrightnessForPhoto each return the scene/array they were given when
    // there is nothing to remove (see their own docs). If either ever starts
    // returning a fresh object unconditionally, this no-op check silently stops
    // being one and every photo delete commits an empty undo step.
    if (nextItems === scene.items && prunedScene === scene) return; // nothing on this photo at all — no-op

    // #741 defect 1 (round 2, HIGH): also scrub every EXISTING undo/redo
    // snapshot's copy of this photo's items — commit() below only appends a
    // new (already-clean) snapshot and clears `future`; it does nothing about
    // snapshots already sitting in `past`. Without this, one Ctrl+Z (or a
    // click on #undo-btn) after this delete restores a pre-delete snapshot
    // that still holds the deleted photo's items (and any mini group they
    // carried) into the resident scene — and undo()'s unconditional
    // scheduleSave() then autosaves them straight back over the server row
    // this delete just correctly pruned, re-entering the #227/#254 dead-
    // billing failure through undo. `future` doesn't need the same treatment:
    // commit() unconditionally clears it right below, on every call.
    // Row 371: the same scrub covers the brightness key, for the same reason —
    // undo() restores a whole snapshot and then autosaves it, so a snapshot
    // still carrying the key would reintroduce it through Ctrl+Z.
    past = past.map((s) => {
      const pruned = removeBrightnessForPhoto(s, photoId);
      const filtered = removeItemsForPhoto(pruned.items, photoId);
      return filtered === pruned.items ? pruned : { ...pruned, items: filtered };
    });

    // #741 defect 2: no in-canvas toast here (unlike deleteSelected's
    // pruneOrphanedMiniGroupsNotify) — the caller already reports this exact
    // server-side prune up to QuoteBuilder's persistent banner (the
    // authoritative channel: it reflects what the server actually did).
    // Firing both duplicated one removal into two differently-worded notices.
    scene = { ...prunedScene, items: nextItems };
    commit();
    redrawScene();

    // #741 defect 5 (MED): close the autosave race during the delete round
    // trip. Nothing gates canvas input while the DELETE request is in
    // flight — if the operator draws on THIS (surviving, still-mounted)
    // photo during that window, scheduleSave()'s 600ms debounce can fire and
    // PUT the still-un-spliced scene, landing AFTER the server's own prune
    // write and silently reverting it. Force an immediate corrective save of
    // the now-spliced scene right after processing: it cancels any debounce
    // timer so the PUT goes out now rather than later. Ledger row 260: doSave()
    // now SERIALIZES every save (see its comment above) rather than letting an
    // earlier stale PUT race a later one concurrently, so this corrective save
    // simply queues after whatever's already in flight and always uses the
    // freshest `scene` + `design.version` when its turn comes — no separate
    // staleness reasoning needed here anymore. Kept as a forced immediate save
    // (rather than relying on the 600ms debounce) purely to close the WINDOW
    // before the next edit, same trade-off already accepted by the pre-delete
    // flush in DesignEditor.deletePhoto and seedDesignFromAnalysis.
    if (conflicted) return; // #260: blocked until reload — see showConflictBanner()
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    pendingSave = true;
    savingEl.textContent = "Saving…";
    void doSave();
  }

  // --- Sidebar ---
  function renderSidebar() {
    const sb = root.querySelector("#sidebar") as HTMLElement;
    if (selectedYardstickId) {
      renderYardstickSidebar(sb);
      renderTotal();
      return;
    }
    if (selectedIds.size > 0) {
      renderSelectedSidebar(sb);
      appendBillingLinkSection(sb); // #13 linked twins — "bills as" fallback
      renderTotal();
      return;
    }
    sb.innerHTML = `
      ${opts.permanentOnly || opts.bistroOnly ? "" : `
      <section>
        <h3>Category</h3>
        <div class="bulb-types" id="categories" style="flex-wrap:wrap">
          <button data-cat="lights" class="${tool.category === "lights" ? "active" : ""}">Lights</button>
          <button data-cat="decor" class="${tool.category === "decor" ? "active" : ""}">Decor</button>
          <button data-cat="text" class="${tool.category === "text" ? "active" : ""}">Text</button>
          <button data-cat="custom" class="${tool.category === "custom" ? "active" : ""}">Custom</button>
          <button data-cat="poles" class="${tool.category === "poles" ? "active" : ""}">Poles</button>
        </div>
      </section>`}
      ${(() => {
        // #13 linked twins: re-place items from OTHER photos onto this one.
        const cands = stampCandidates();
        if (cands.length === 0) return "";
        return `
      <section>
        <h3>Re-place from other photos</h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">Click one, then click the photo — a linked copy shows here but bills once (via its original).</div>
        ${cands.map((i) => `<button class="stamp-row" data-id="${i.id}" style="display:block;width:100%;text-align:left;margin-bottom:2px${stampSourceId === i.id ? ";outline:2px solid var(--accent, #4f8cff)" : ""}">📌 ${stampLabel(i)} — ${photoLabelOf(i)}</button>`).join("")}
      </section>`;
      })()}
      ${tool.category === "poles" ? `
      <section>
        <h3>Base Type</h3>
        <div class="bulb-types" id="pole-base-types">
          <button data-base="none" class="${tool.poleBaseType === "none" ? "active" : ""}">None</button>
          <button data-base="cube" class="${tool.poleBaseType === "cube" ? "active" : ""}">Cube</button>
          <button data-base="barrel" class="${tool.poleBaseType === "barrel" ? "active" : ""}">Barrel</button>
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">None for permanent in-ground installs or attaching to existing poles/buildings.</div>
      </section>
      <section>
        <h3>Height${offPresetSizeSuffix(POLE_HEIGHTS, [tool.poleHeightIn], "ft")}</h3>
        <div class="spacing-row" id="pole-heights">
          ${sizeButtons(POLE_HEIGHTS, [tool.poleHeightIn], "data-h", "ft")}
        </div>
      </section>
      ${(() => {
        const count = allPoles().length;
        return `<section><button id="select-all-poles" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Poles${count > 0 ? ` (${count})` : ""}
        </button></section>`;
      })()}
      <section>
        <div class="style-help">Click anywhere on the photo to place a pole. The click sets the BASE — the pole extends straight up from there.</div>
      </section>
      ` : tool.category === "custom" ? `
      <section>
        <h3>Library</h3>
        <input type="file" id="custom-upload-input" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="display:none" />
        <button id="custom-upload-btn" style="width:100%">+ Upload image</button>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">PNG/JPG/WebP/GIF/SVG up to 25 MB.</div>
        <div id="custom-library" style="margin-top:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
          ${uploads.length === 0
            ? `<div style="grid-column:1/-1;color:var(--text-dim);font-size:12px;padding:12px;text-align:center;border:1px dashed var(--border);border-radius:6px">No uploads yet. Click + Upload image to add one.</div>`
            : uploads.map((u) => `
              <div class="custom-thumb" data-path="${u.path}" data-id="${u.id}" title="${escapeAttr(u.filename)}" style="position:relative;border:2px solid ${tool.customActiveUploadPath === u.path ? "#4f8cff" : "var(--border)"};border-radius:6px;background:var(--surface-2);cursor:pointer;aspect-ratio:1;display:flex;align-items:center;justify-content:center;overflow:hidden">
                <img src="${u.url}" alt="" style="max-width:100%;max-height:100%;object-fit:contain" />
                <button class="custom-thumb-del" title="Remove from library" style="position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.6);color:white;border:none;font-size:12px;line-height:1;cursor:pointer;padding:0">×</button>
              </div>
            `).join("")}
        </div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="custom-auto-halo" ${tool.customAutoHalo ? "checked" : ""} />
          <span>Glow by default</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Adds a soft halo around bright pixels. Looks great for lit signs; less great for opaque photos.</div>
      </section>
      ${(() => {
        const count = allCustoms().length;
        return `<section><button id="select-all-customs" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Customs${count > 0 ? ` (${count})` : ""}
        </button></section>`;
      })()}
      <section>
        <div class="style-help">${tool.customActiveUploadPath ? "Click anywhere on the photo to place the selected graphic." : "Pick a graphic from the library to start placing."}</div>
      </section>
      ` : tool.category === "text" ? `
      <section>
        <h3>Text</h3>
        <input type="text" id="tool-text" value="${escapeAttr(tool.textContent)}" placeholder="Type your text..." style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);box-sizing:border-box" />
      </section>
      <section>
        <h3>Font</h3>
        <div class="bulb-types" id="text-fonts" style="flex-wrap:wrap">
          ${FONT_OPTIONS.map((f) => `<button data-font="${f}" class="${tool.textFont === f ? "active" : ""}" style="font-family:'${f}',sans-serif;font-size:14px">${f}</button>`).join("")}
        </div>
      </section>
      <section>
        <h3>Color</h3>
        <div class="colors" id="text-colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}" class="${tool.textColorId === c.id ? "active" : ""}"></button>`).join("")}
        </div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="text-outline" ${tool.textOutline ? "checked" : ""} />
          <span>Outline</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Adds a contrasting stroke around each letter.</div>
      </section>
      ${(() => {
        const count = allTexts().length;
        return `<section><button id="select-all-texts" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Texts${count > 0 ? ` (${count})` : ""}
        </button></section>`;
      })()}
      <section>
        <div class="style-help">Click anywhere on the photo to place text. Drag corners to resize.</div>
      </section>
      ` : tool.category === "lights" ? `
      <section>
        <h3>Bulb Type</h3>
        <div class="bulb-types" id="bulb-types">
          ${BULB_TYPES.filter((b) => opts.permanentOnly ? b.id === "permanent" : opts.bistroOnly ? b.id === "bistro" : true).map((b) => `<button data-type="${b.id}" class="${tool.bulbType === b.id ? "active" : ""}">${b.label}</button>`).join("")}
        </div>
        ${(() => {
          const count = allStrands().filter((s) => s.bulbType === tool.bulbType).length;
          const typeLabel = BULB_TYPES.find((b) => b.id === tool.bulbType)?.label ?? tool.bulbType;
          return `<button id="select-all-type" style="margin-top:8px;width:100%" ${count === 0 ? "disabled" : ""}>
            Select All ${typeLabel} Lights${count > 0 ? ` (${count})` : ""}
          </button>`;
        })()}
      </section>
      ${tool.scattershot ? "" : `
      <section>
        ${spacingRowHtml(tool.bulbType === "permanent", SPACINGS[tool.bulbType], [tool.spacingIn], "spacings")}
      </section>
      `}
      <section>
        <h3>Drawing Style</h3>
        <div class="style-row" id="styles">
          ${STYLES.map((s) => `<button data-style="${s.id}" class="${!tool.scattershot && tool.drawingStyle === s.id ? "active" : ""}">${s.label}</button>`).join("")}
          ${tool.bulbType === "mini" ? `<button data-style="scattershot" class="${tool.scattershot ? "active" : ""}">Scattershot</button>` : ""}
        </div>
        <div class="style-help">${tool.scattershot ? SCATTERSHOT_HELP : STYLE_HELP[tool.drawingStyle]}</div>
      </section>
      ${(() => {
        // #249: pre-draw quick-tag — sets the Surface billing category BEFORE
        // drawing so new strands (and scattershot mini areas) carry it
        // automatically instead of a post-hoc draw→select→dropdown cycle per
        // item. Options track the current bulbType via the same lookup the
        // post-hoc #sel-surface dropdown uses (surfaceOptionsForBulbType), so
        // the two pickers can't drift apart. Hidden entirely when this bulb
        // type has no surface tag (permanent/bistro) or the design isn't
        // quote-bound (standalone design tool / non-binding mounts).
        // #753 review fix: also passes the live scattershot flag, which drops
        // "curtain" from the row while Scattershot is active — the item that
        // style commits (a MiniAreaItem) has no `curtain` option in its OWN
        // edit panel (#sel-ma-surface), so pre-tagging it would bake on a tag
        // that panel could never show or correct (see surfaceOptions.ts).
        if (!opts.showQuoteBinding) return "";
        const toolSurfaceOpts = surfaceOptionsForBulbType(tool.bulbType, { scattershot: tool.scattershot });
        if (toolSurfaceOpts.length === 0) return "";
        return `
      <section>
        <h3>Surface</h3>
        <div class="bulb-types" id="tool-surfaces">
          <button data-surface="" class="${tool.surface === "" ? "active" : ""}">None</button>
          ${toolSurfaceOpts.map(([v, l]) => `<button data-surface="${v}" class="${tool.surface === v ? "active" : ""}">${l}</button>`).join("")}
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Tags every new item you draw with this billing category. Leave on None to tag after drawing, same as before.</div>
      </section>
        `;
      })()}
      ${(() => {
        // #249 (permanent side-of-house pre-draw tag): mirrors the Surface
        // quick-tag section above, but permanent-only (locked by the dev — c9
        // also has a side-of-house tag post-hoc, but its pre-draw sidebar is
        // already the crowded one Part A had to fix, so it does NOT get this
        // pre-draw section too). Options come from the same lookup the
        // post-hoc #sel-side-of-house dropdown uses (sideOfHouseOptions), so
        // the two pickers can't drift apart.
        // #249 review fix (provenance): a tag set HERE is sticky/unconfirmed
        // (sideOfHouseAuto = true, quoteDefaultsForNewStrand below) — it still
        // bills, displays, and drives the portal per-side toggle like any
        // other tag, but AI training capture never trusts it until a human
        // confirms via the dropdown (trainingExamples.ts extractFinalStreetRuns).
        if (!opts.showQuoteBinding) return "";
        if (tool.bulbType !== "permanent") return "";
        return `
      <section>
        <h3>Side of House</h3>
        <div class="bulb-types" id="tool-side-of-house">
          <button data-side="" class="${tool.sideOfHouse === "" ? "active" : ""}">None</button>
          ${sideOfHouseOptions().map(([v, l]) => `<button data-side="${v}" class="${tool.sideOfHouse === v ? "active" : ""}">${l}</button>`).join("")}
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Tags every new item you draw with this side. Left/right = the HOMEOWNER's, standing at the front door facing the street — the MIRROR of your own left/right looking at the house from the road. Leave on None to tag after drawing, same as before.</div>
      </section>
        `;
      })()}
      ${tool.bulbType === "permanent" ? `
      <section>
        <h3>Beam Length <span id="tool-beam-len-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="tool-beam-len" min="0.5" max="20" step="0.1" value="${tool.beamLengthFt}" />
      </section>
      <section>
        <h3>Beam Width <span id="tool-beam-wid-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="tool-beam-wid" min="0.2" max="6" step="0.1" value="${tool.beamWidthFt}" />
      </section>
      <section>
        <h3>Distance to Surface <span id="tool-dist-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="tool-dist" min="0" max="5" step="0.1" value="${tool.distanceToSurfaceFt}" />
      </section>
      <section>
        <h3>Opacity <span id="tool-opacity-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="tool-opacity" min="0.1" max="1" step="0.01" value="${tool.opacity}" />
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="tool-beam" ${tool.showBeam ? "checked" : ""} />
          <span>Show light beam</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Off = just the puck dots, no cone.</div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="tool-coverage" ${tool.showCoverage ? "checked" : ""} />
          <span>Show floor coverage</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">These settings apply to every new perm-light strand you draw.</div>
      </section>
      ` : ""}
      ${tool.bulbType === "bistro" ? `
      <section>
        <h3>Sag <span id="tool-bistro-sag-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="tool-bistro-sag" min="0" max="0.25" step="0.005" value="${tool.bistroSagFactor}" />
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">How much the cord droops between supports, as a fraction of the horizontal span. 0 = taut, 0.10 ≈ typical, 0.25 = heavy.</div>
      </section>
      ` : ""}
      <section>
        <h3>Color</h3>
        <div class="colors" id="colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}" class="${tool.pickerColorId === c.id ? "active" : ""}"></button>`).join("")}
        </div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button id="add-color">+ Add to pattern</button>
          <button id="clear-pattern">Clear</button>
        </div>
        <div class="pattern-row" id="pattern">
          ${tool.colorPattern.map((id, i) => {
            const c = COLORS.find((cc) => cc.id === id);
            return `<div class="swatch" data-i="${i}" style="background:${c?.hex ?? "#333"}"><button>×</button></div>`;
          }).join("")}
        </div>
      </section>
      <section>
        <h3>Strands (${allStrands().length})</h3>
        <div class="strands-list" id="strands">
          ${allStrands().map((s) => {
            const ft = strandLengthPx(s) / ppfForStrand(s);
            const swatch = COLORS.find((c) => c.id === s.colorPattern[0]);
            const label = s.bulbType === "permanent" ? "PERM" : s.bulbType.toUpperCase();
            return `<div class="strand-row" data-id="${s.id}">
              <span><span class="swatch" style="background:${swatch?.hex ?? "#888"}"></span>${label} @ ${s.spacingIn}" — ${ft.toFixed(1)} ft</span>
              <button title="Delete">×</button>
            </div>`;
          }).join("")}
        </div>
      </section>
      ` : `
      <section>
        <h3>Decor</h3>
        <div class="bulb-types" id="decor-types">
          <button data-decor="wreath" class="${tool.decorType === "wreath" ? "active" : ""}">Wreath</button>
          <button data-decor="bow" class="${tool.decorType === "bow" ? "active" : ""}">Bow</button>
          <button data-decor="garland" class="${tool.decorType === "garland" ? "active" : ""}">Garland</button>
          <button data-decor="spritzer" class="${tool.decorType === "spritzer" ? "active" : ""}">Spritzer</button>
        </div>
        ${(() => {
          if (tool.decorType === "wreath") {
            const count = allWreaths().length;
            return `<button id="select-all-wreaths" style="margin-top:8px;width:100%" ${count === 0 ? "disabled" : ""}>
              Select All Wreaths${count > 0 ? ` (${count})` : ""}
            </button>`;
          }
          if (tool.decorType === "bow") {
            const count = allBows().length;
            return `<button id="select-all-bows" style="margin-top:8px;width:100%" ${count === 0 ? "disabled" : ""}>
              Select All Bows${count > 0 ? ` (${count})` : ""}
            </button>`;
          }
          if (tool.decorType === "garland") {
            const count = allGarlands().length;
            return `<button id="select-all-garlands" style="margin-top:8px;width:100%" ${count === 0 ? "disabled" : ""}>
              Select All Garlands${count > 0 ? ` (${count})` : ""}
            </button>`;
          }
          const count = allSpritzers().length;
          return `<button id="select-all-spritzers" style="margin-top:8px;width:100%" ${count === 0 ? "disabled" : ""}>
            Select All Spritzers${count > 0 ? ` (${count})` : ""}
          </button>`;
        })()}
      </section>
      ${tool.decorType === "wreath" ? `
      <section>
        <h3>Size${offPresetSizeSuffix(WREATH_SIZES, [tool.wreathSizeIn])}</h3>
        <div class="spacing-row" id="wreath-sizes">
          ${sizeButtons(WREATH_SIZES, [tool.wreathSizeIn], "data-s")}
        </div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="wreath-with-lights" ${tool.wreathWithLights ? "checked" : ""} />
          <span>With lights</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Pre-lit vs. greenery only.</div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="wreath-with-bow" ${tool.wreathWithBow ? "checked" : ""} />
          <span>Include bow</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Adds a red bow to the wreath. The bow moves and resizes with it.</div>
      </section>
      <section>
        <div class="style-help">Click anywhere on the photo to place a wreath.</div>
      </section>
      ` : tool.decorType === "bow" ? `
      <section>
        <h3>Size${offPresetSizeSuffix(BOW_SIZES, [tool.bowSizeIn])}</h3>
        <div class="spacing-row" id="bow-sizes">
          ${sizeButtons(BOW_SIZES, [tool.bowSizeIn], "data-s")}
        </div>
      </section>
      <section>
        <div class="style-help">Click anywhere on the photo to place a bow.</div>
      </section>
      ` : tool.decorType === "garland" ? `
      <section>
        <h3>Size${offPresetSizeSuffix(GARLAND_SIZES, [tool.garlandSizeIn])}</h3>
        <div class="spacing-row" id="garland-sizes">
          ${sizeButtons(GARLAND_SIZES, [tool.garlandSizeIn], "data-s")}
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Thickness of the greenery rope on the photo.</div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="garland-with-lights" ${tool.garlandWithLights ? "checked" : ""} />
          <span>With lights</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Pre-lit greenery vs. plain greenery.</div>
      </section>
      <section>
        <h3>Drawing Style</h3>
        <div class="style-row" id="garland-styles">
          ${STYLES.map((s) => `<button data-style="${s.id}" class="${tool.drawingStyle === s.id ? "active" : ""}">${s.label}</button>`).join("")}
        </div>
        <div class="style-help">${STYLE_HELP[tool.drawingStyle]}</div>
      </section>
      ` : `
      <section>
        <h3>Size${offPresetSizeSuffix(SPRITZER_SIZES, [tool.spritzerSizeIn])}</h3>
        <div class="spacing-row" id="spritzer-sizes">
          ${sizeButtons(SPRITZER_SIZES, [tool.spritzerSizeIn], "data-s")}
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Diameter of the radial spray on the photo.</div>
      </section>
      <section>
        <h3>Color</h3>
        <div class="colors" id="spritzer-colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}" class="${tool.spritzerPickerColorId === c.id ? "active" : ""}"></button>`).join("")}
        </div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button id="spritzer-add-color">+ Add to pattern</button>
          <button id="spritzer-clear-pattern">Clear</button>
          <button id="spritzer-multi" title="Set the pattern to every color in the palette">Multi</button>
        </div>
        <div class="pattern-row" id="spritzer-pattern">
          ${tool.spritzerColorPattern.map((id, i) => {
            const c = COLORS.find((cc) => cc.id === id);
            return `<div class="swatch" data-i="${i}" style="background:${c?.hex ?? "#333"}"><button>×</button></div>`;
          }).join("")}
        </div>
      </section>
      <section>
        <div class="style-help">Click anywhere on the photo to place a spritzer.</div>
      </section>
      `}
      `}
    `;

    // #13: arm the stamp — the next canvas click places the linked twin.
    sb.querySelectorAll(".stamp-row").forEach((el) =>
      el.addEventListener("click", () => {
        stampSourceId = (el as HTMLElement).dataset.id ?? null;
        clearSelection();
        stage.container().style.cursor = "copy";
        renderSidebar();
      }),
    );

    sb.querySelectorAll("#categories button").forEach((b) =>
      b.addEventListener("click", () => {
        const next = (b as HTMLElement).dataset.cat as ItemCategory;
        tool.category = next;
        cancelInProgress();
        applyDefaultsForCurrentType();
        // First entry into Custom triggers an uploads fetch so the library
        // grid populates. After the first load it stays in editor state and
        // refreshes only on upload/delete actions.
        if (next === "custom" && !uploadsLoaded) {
          ensureUploadsLoaded().then(() => renderSidebar());
        }
        renderSidebar();
        redrawScene(); // #63: refresh item draggable flags for the new tool context
      }),
    );
    sb.querySelectorAll("#bulb-types button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.bulbType = (b as HTMLElement).dataset.type as BulbType;
        // Scattershot is a mini-light-only style — leaving Mini drops back to
        // the regular drawing style.
        if (tool.bulbType !== "mini") tool.scattershot = false;
        // Pull the user's saved defaults for the newly-active type. Falls back to
        // factory values for anything not overridden in Settings.
        applyDefaultsForCurrentType();
        const spacings = SPACINGS[tool.bulbType];
        if (!spacings.includes(tool.spacingIn)) tool.spacingIn = spacings[Math.floor(spacings.length / 2)];
        // #249/#753: a picked surface tag can be invalid for the new bulb type
        // (e.g. "santas-roofline" carried over from c9 into mini) — clear it
        // and tell the operator (resetToolSurfaceIfInvalid), rather than
        // silently mis-tagging the next item.
        resetToolSurfaceIfInvalid(BULB_TYPES.find((t) => t.id === tool.bulbType)?.label ?? tool.bulbType);
        resetToolSideOfHouseIfInvalid(BULB_TYPES.find((t) => t.id === tool.bulbType)?.label ?? tool.bulbType);
        renderSidebar();
        redrawScene(); // #63: bistro vs non-bistro flips strand-draw context
      }),
    );
    sb.querySelectorAll("#tool-surfaces button").forEach((b) =>
      b.addEventListener("click", () => {
        // #249: pre-draw quick-tag — sets the default `surface` baked into the
        // next drawn strand/mini area (see quoteDefaultsForNewStrand /
        // commitMiniArea). Purely a tool-state change; doesn't touch any
        // already-drawn item, so no redrawScene needed.
        tool.surface = ((b as HTMLElement).dataset.surface ?? "") as Surface | "";
        renderSidebar();
      }),
    );
    sb.querySelectorAll("#tool-side-of-house button").forEach((b) =>
      b.addEventListener("click", () => {
        // #249: pre-draw quick-tag — sets the default `sideOfHouse` baked into
        // the next drawn permanent strand (see quoteDefaultsForNewStrand).
        // Purely a tool-state change; doesn't touch any already-drawn item, so
        // no redrawScene needed (mirrors #tool-surfaces just above).
        tool.sideOfHouse = ((b as HTMLElement).dataset.side ?? "") as SideOfHouse | "";
        renderSidebar();
      }),
    );
    sb.querySelectorAll("#decor-types button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.decorType = (b as HTMLElement).dataset.decor as DecorType;
        // Switching decor sub-type mid-trace would orphan the polyline; bail out.
        cancelInProgress();
        applyDefaultsForCurrentType();
        renderSidebar();
        redrawScene(); // #63: garland vs other decor flips strand-draw context
      }),
    );
    sb.querySelectorAll("#garland-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.garlandSizeIn = Number((b as HTMLElement).dataset.s);
        renderSidebar();
      }),
    );
    const garlandWl = sb.querySelector("#garland-with-lights") as HTMLInputElement | null;
    garlandWl?.addEventListener("change", () => {
      tool.garlandWithLights = garlandWl.checked;
      renderSidebar();
    });
    sb.querySelectorAll("#garland-styles button").forEach((b) =>
      b.addEventListener("click", () => {
        cancelInProgress();
        tool.drawingStyle = (b as HTMLElement).dataset.style as DrawingStyle;
        renderSidebar();
        redrawScene(); // #63: garland drawingStyle changes flip strand-draw context
      }),
    );
    sb.querySelector("#select-all-garlands")?.addEventListener("click", () => {
      const ids = allGarlands().map((g) => g.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelector("#select-all-spritzers")?.addEventListener("click", () => {
      const ids = allSpritzers().map((s) => s.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    // ----- Text category event wiring -----
    const textInput = sb.querySelector("#tool-text") as HTMLInputElement | null;
    textInput?.addEventListener("input", () => {
      // Just update state; don't re-render the sidebar or the user loses focus
      // mid-typing. The next render naturally picks up the new value.
      tool.textContent = textInput.value;
    });
    sb.querySelectorAll("#text-fonts button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.textFont = (b as HTMLElement).dataset.font as FontFamily;
        renderSidebar();
      }),
    );
    sb.querySelectorAll("#text-colors button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.textColorId = (b as HTMLElement).dataset.c!;
        renderSidebar();
      }),
    );
    const textOutlineCb = sb.querySelector("#text-outline") as HTMLInputElement | null;
    textOutlineCb?.addEventListener("change", () => {
      tool.textOutline = textOutlineCb.checked;
      renderSidebar();
    });
    sb.querySelector("#select-all-texts")?.addEventListener("click", () => {
      const ids = allTexts().map((t) => t.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    // ----- Custom category event wiring -----
    const customFileInput = sb.querySelector("#custom-upload-input") as HTMLInputElement | null;
    sb.querySelector("#custom-upload-btn")?.addEventListener("click", () => {
      customFileInput?.click();
    });
    customFileInput?.addEventListener("change", async () => {
      const file = customFileInput.files?.[0];
      if (!file) return;
      // Reset the input so the same file can be re-picked later if needed.
      customFileInput.value = "";
      // Upload and post-upload bookkeeping are kept in SEPARATE try blocks
      // so a render-time error doesn't get mis-attributed as an upload error.
      // Previously a single try wrapped both and any post-success client
      // bug looked like "Upload failed" to the user.
      let entry: Awaited<ReturnType<typeof api.createUpload>>;
      try {
        entry = await api.createUpload(file);
      } catch (err) {
        console.error("custom-upload failed:", err);
        alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      try {
        uploads = [entry, ...uploads];
        // Arm the newly-uploaded graphic so the user can immediately click
        // on the photo to place it.
        tool.customActiveUploadPath = entry.path;
        renderSidebar();
      } catch (err) {
        console.error("custom-upload post-success error:", err);
        // Upload itself succeeded; refresh from the server so the library at
        // least reflects reality, then surface the real error.
        refreshUploads();
        alert(`Upload saved, but rendering the library threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    sb.querySelectorAll("#custom-library .custom-thumb").forEach((thumb) => {
      const path = (thumb as HTMLElement).dataset.path!;
      const id = (thumb as HTMLElement).dataset.id!;
      thumb.addEventListener("click", (e) => {
        // Ignore clicks on the × delete button — it has its own handler.
        if ((e.target as HTMLElement).classList.contains("custom-thumb-del")) return;
        tool.customActiveUploadPath = path;
        renderSidebar();
      });
      const delBtn = thumb.querySelector(".custom-thumb-del") as HTMLElement | null;
      delBtn?.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Remove this graphic from your library? Already-placed copies stay on their designs.")) return;
        // Separate try blocks so a render-time error doesn't get mis-attributed
        // to the server delete call (which is usually what's actually fine).
        try {
          await api.deleteUpload(id);
        } catch (err) {
          console.error("custom-delete failed:", err);
          alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        try {
          uploads = uploads.filter((u) => u.id !== id);
          if (tool.customActiveUploadPath === path) tool.customActiveUploadPath = null;
          renderSidebar();
        } catch (err) {
          console.error("custom-delete post-success error:", err);
          refreshUploads();
          alert(`Deleted on the server, but updating the library view threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    });
    const haloCb = sb.querySelector("#custom-auto-halo") as HTMLInputElement | null;
    haloCb?.addEventListener("change", () => {
      tool.customAutoHalo = haloCb.checked;
    });
    sb.querySelector("#select-all-customs")?.addEventListener("click", () => {
      const ids = allCustoms().map((c) => c.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    // ----- Poles category event wiring -----
    sb.querySelectorAll("#pole-base-types button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.poleBaseType = (b as HTMLElement).dataset.base as PoleBaseType;
        renderSidebar();
      }),
    );
    sb.querySelectorAll("#pole-heights button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.poleHeightIn = Number((b as HTMLElement).dataset.h);
        renderSidebar();
      }),
    );
    sb.querySelector("#select-all-poles")?.addEventListener("click", () => {
      const ids = allPoles().map((p) => p.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#spritzer-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.spritzerSizeIn = Number((b as HTMLElement).dataset.s);
        renderSidebar();
      }),
    );
    sb.querySelectorAll("#spritzer-colors button").forEach((b) =>
      b.addEventListener("click", () => {
        const id = (b as HTMLElement).dataset.c!;
        tool.spritzerPickerColorId = id;
        // Replace the pattern when it's a single-color pattern; preserve
        // multi-color patterns (user can Clear or Add-to-pattern to extend).
        if (tool.spritzerColorPattern.length <= 1) tool.spritzerColorPattern = [id];
        renderSidebar();
      }),
    );
    sb.querySelector("#spritzer-add-color")?.addEventListener("click", () => {
      tool.spritzerColorPattern = [...tool.spritzerColorPattern, tool.spritzerPickerColorId];
      renderSidebar();
    });
    sb.querySelector("#spritzer-clear-pattern")?.addEventListener("click", () => {
      tool.spritzerColorPattern = [tool.spritzerPickerColorId];
      renderSidebar();
    });
    sb.querySelector("#spritzer-multi")?.addEventListener("click", () => {
      // One-click rainbow: pattern = every color in the active palette.
      tool.spritzerColorPattern = COLORS.map((c) => c.id);
      renderSidebar();
    });
    sb.querySelectorAll("#spritzer-pattern .swatch button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = Number(((btn as HTMLElement).parentElement as HTMLElement).dataset.i);
        tool.spritzerColorPattern = tool.spritzerColorPattern.filter((_, idx) => idx !== i);
        if (tool.spritzerColorPattern.length === 0) {
          tool.spritzerColorPattern = [tool.spritzerPickerColorId];
        }
        renderSidebar();
      });
    });
    sb.querySelectorAll("#wreath-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.wreathSizeIn = Number((b as HTMLElement).dataset.s);
        renderSidebar();
      }),
    );
    const withLightsCb = sb.querySelector("#wreath-with-lights") as HTMLInputElement | null;
    withLightsCb?.addEventListener("change", () => {
      tool.wreathWithLights = withLightsCb.checked;
      renderSidebar();
    });
    const withBowCb = sb.querySelector("#wreath-with-bow") as HTMLInputElement | null;
    withBowCb?.addEventListener("change", () => {
      tool.wreathWithBow = withBowCb.checked;
      renderSidebar();
    });
    sb.querySelector("#select-all-wreaths")?.addEventListener("click", () => {
      const ids = allWreaths().map((w) => w.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#bow-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.bowSizeIn = Number((b as HTMLElement).dataset.s);
        renderSidebar();
      }),
    );
    sb.querySelector("#select-all-bows")?.addEventListener("click", () => {
      const ids = allBows().map((b) => b.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelector("#select-all-type")?.addEventListener("click", () => {
      const ids = allStrands().filter((s) => s.bulbType === tool.bulbType).map((s) => s.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });

    // Pre-draw config for perm lights. Updates tool state (no scene mutation; these
    // values get baked into newly-created strands only). Labels update inline.
    // Category guard: the sliders only exist in the Lights branch HTML, but
    // tool.bulbType keeps its value across category switches — without the
    // guard this block throws when e.g. Decor renders while bulbType is
    // still "permanent".
    if (tool.category === "lights" && tool.bulbType === "permanent") {
      const wireToolSlider = (
        id: string,
        key: "beamLengthFt" | "beamWidthFt" | "distanceToSurfaceFt" | "opacity",
        suffix: string,
        decimals: number,
      ) => {
        const input = sb.querySelector(`#${id}`) as HTMLInputElement;
        const label = sb.querySelector(`#${id}-val`) as HTMLElement;
        const write = () => {
          label.textContent = `${Number(input.value).toFixed(decimals)}${suffix}`;
        };
        write();
        input.addEventListener("input", () => {
          write();
          tool[key] = Number(input.value);
        });
      };
      wireToolSlider("tool-beam-len", "beamLengthFt", " ft", 1);
      wireToolSlider("tool-beam-wid", "beamWidthFt", " ft", 1);
      wireToolSlider("tool-dist", "distanceToSurfaceFt", " ft", 1);
      wireToolSlider("tool-opacity", "opacity", "", 2);
      const beamCb = sb.querySelector("#tool-beam") as HTMLInputElement;
      beamCb.addEventListener("change", () => {
        tool.showBeam = beamCb.checked;
      });
      const cov = sb.querySelector("#tool-coverage") as HTMLInputElement;
      cov.addEventListener("change", () => {
        tool.showCoverage = cov.checked;
      });
    }
    if (tool.bulbType === "bistro") {
      // Bistro draw-time sag slider. The strand's per-item sagFactor is set
      // from this at creation time (commitStrand / commitTraceSegments).
      const input = sb.querySelector("#tool-bistro-sag") as HTMLInputElement | null;
      const label = sb.querySelector("#tool-bistro-sag-val") as HTMLElement | null;
      if (input && label) {
        const write = () => {
          label.textContent = `${(Number(input.value) * 100).toFixed(0)}%`;
        };
        write();
        input.addEventListener("input", () => {
          write();
          tool.bistroSagFactor = Number(input.value);
        });
      }
    }
    sb.querySelectorAll("#spacings button").forEach((b) =>
      b.addEventListener("click", () => {
        tool.spacingIn = Number((b as HTMLElement).dataset.s);
        renderSidebar();
      }),
    );
    sb.querySelectorAll("#styles button").forEach((b) =>
      b.addEventListener("click", () => {
        cancelInProgress();
        const s = (b as HTMLElement).dataset.style!;
        // "scattershot" is the local 4th style — a tool flag, never written
        // into tool.drawingStyle (that type is shared with garland drawing).
        if (s === "scattershot") {
          tool.scattershot = true;
          // #753 review fix: entering Scattershot can invalidate a pre-picked
          // "curtain" tag (see surfaceOptionsForBulbType) — clear + notify
          // the same way a bulb-type switch does, so the state never bakes
          // an unreachable tag onto the next commitMiniArea.
          resetToolSurfaceIfInvalid("Scattershot");
        } else {
          tool.scattershot = false;
          tool.drawingStyle = s as DrawingStyle;
        }
        renderSidebar();
        redrawScene(); // #63: drawingStyle/scattershot changes flip strand-draw context
      }),
    );
    sb.querySelectorAll("#colors button").forEach((b) =>
      b.addEventListener("click", () => {
        const id = (b as HTMLElement).dataset.c!;
        tool.pickerColorId = id;
        // Replace the pattern when it's a single-color pattern (the common case).
        // Multi-color patterns are preserved — user can hit "+ Add to pattern" or "Clear" to extend.
        if (tool.colorPattern.length <= 1) tool.colorPattern = [id];
        renderSidebar();
      }),
    );
    // These exist only in the Lights branch — optional-chain so rendering any
    // other category's panel doesn't throw mid-renderSidebar (a throw here
    // aborts the caller's redrawScene and corrupts Konva's event dispatch).
    sb.querySelector("#add-color")?.addEventListener("click", () => {
      tool.colorPattern = [...tool.colorPattern, tool.pickerColorId];
      renderSidebar();
    });
    sb.querySelector("#clear-pattern")?.addEventListener("click", () => {
      tool.colorPattern = [tool.pickerColorId];
      renderSidebar();
    });
    sb.querySelectorAll(".swatch button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = Number((btn.parentElement as HTMLElement).dataset.i);
        tool.colorPattern = tool.colorPattern.filter((_, idx) => idx !== i);
        if (tool.colorPattern.length === 0) tool.colorPattern = [tool.pickerColorId];
        renderSidebar();
      });
    });
    sb.querySelectorAll("#strands .strand-row button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = (btn as HTMLElement).closest(".strand-row") as HTMLElement | null;
        const id = row?.dataset.id;
        if (!id) return;
        // #227: prune a miniGroup left with zero surviving members by this delete.
        scene = { ...scene, items: pruneOrphanedMiniGroupsNotify(scene.items.filter((s) => s.id !== id)) };
        scheduleSave();
        commit();
        redrawScene();
      });
    });
    // Clicking anywhere on a strand row (not the × button) selects that strand
    // on the canvas, same as clicking the strand directly. The × button's
    // stopPropagation above prevents double-handling.
    sb.querySelectorAll<HTMLElement>("#strands .strand-row").forEach((row) => {
      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        if (!id) return;
        selectedYardstickId = null;
        selectedIds = new Set([id]);
        redrawScene();
      });
    });

    renderTotal();
  }

  function renderTotal() {
    const strs = allStrands();
    const gars = allGarlands();
    const totalStrandFt = strs.reduce((acc, s) => acc + strandLengthPx(s) / ppfForStrand(s), 0);
    const totalGarlandFt = gars.reduce((acc, g) => acc + garlandLengthPx(g) / ppfForGarland(g), 0);
    const ysCount = scene.yardsticks.length;
    if (ysCount === 0) {
      (root.querySelector("#total") as HTMLElement).innerHTML =
        `<span style="color:var(--warn)">Drop a Yardstick to get real-world measurements.</span>`;
      return;
    }
    const parts: string[] = [];
    parts.push(`<strong>${totalStrandFt.toFixed(1)} ft</strong> across ${strs.length} strand${strs.length === 1 ? "" : "s"}`);
    if (gars.length > 0) {
      parts.push(`<strong>${totalGarlandFt.toFixed(1)} ft</strong> across ${gars.length} garland${gars.length === 1 ? "" : "s"}`);
    }
    parts.push(`${ysCount} yardstick${ysCount === 1 ? "" : "s"}`);
    (root.querySelector("#total") as HTMLElement).innerHTML = parts.join(" · ");
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected strand(s)
  // ============================================================
  // #13 linked twins — the draw-first-link-later fallback: a single selected
  // billable per-unit item gets a "Billing link" section (own line item vs
  // "same as" a same-kind item on another photo). Appended AFTER the kind
  // panel so every per-kind sidebar gets it from one insertion point.
  function appendBillingLinkSection(sb: HTMLElement) {
    if (selectedIds.size !== 1) return;
    const item = scene.items.find((i) => selectedIds.has(i.id));
    if (!item) return;
    if (!isStampableCanonical(item) && !item.linkedToId) return;
    const candidates = scene.items.filter(
      (c) =>
        c.id !== item.id &&
        !c.linkedToId &&
        c.kind === item.kind &&
        (!isStrand(c) || !isStrand(item) || (c.surface ?? "") === (item.surface ?? "")) &&
        (c.photoId ?? null) !== (item.photoId ?? null),
    );
    if (candidates.length === 0 && !item.linkedToId) return;
    const orphanLink = item.linkedToId && !candidates.some((c) => c.id === item.linkedToId);
    sb.insertAdjacentHTML(
      "beforeend",
      `<section>
        <h3>Billing link</h3>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">${
          item.linkedToId
            ? "A linked copy — shows on this photo, bills once via its original."
            : "Link this drawing to an item on another photo so it bills once."
        }</div>
        <select id="sel-billing-link" class="yardstick-select">
          <option value="">Own line item</option>
          ${candidates
            .map(
              (c) =>
                `<option value="${c.id}" ${item.linkedToId === c.id ? "selected" : ""}>Same as: ${stampLabel(c)} — ${photoLabelOf(c)}</option>`,
            )
            .join("")}
          ${orphanLink ? `<option value="${item.linkedToId}" selected>Same as: (linked item)</option>` : ""}
        </select>
      </section>`,
    );
    const sel = sb.querySelector("#sel-billing-link") as HTMLSelectElement | null;
    sel?.addEventListener("change", () => {
      const v = sel.value || null;
      scene = {
        ...scene,
        items: scene.items.map((i) => (i.id === item.id ? { ...i, linkedToId: v } : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    });
  }

  function renderSelectedSidebar(sb: HTMLElement) {
    const selectedItems = scene.items.filter((i) => selectedIds.has(i.id));
    if (selectedItems.length === 0) {
      // Shouldn't happen, but guard anyway.
      renderSidebar();
      return;
    }
    const wreathSel = selectedItems.filter(isWreath);
    const bowSel = selectedItems.filter(isBow);
    const strandSel = selectedItems.filter(isStrand);
    const garlandSel = selectedItems.filter(isGarland);
    const spritzerSel = selectedItems.filter(isSpritzer);
    const textSel = selectedItems.filter(isText);
    const customSel = selectedItems.filter(isCustom);
    const poleSel = selectedItems.filter(isPole);
    const miniAreaSel = selectedItems.filter(isMiniArea);

    // #240: a mini-light group can mix strand + scattershot members. Check for
    // one represented group before the kind-specific panels so its existing
    // members can be edited together and eligible ungrouped minis can be added.
    const miniCandidates: (StrandItem | MiniAreaItem)[] = [...strandSel, ...miniAreaSel];
    const miniGroupSelection = resolveMiniGroupSelection(scene.items, selectedIds);
    if (miniGroupSelection) {
      renderSelectedMiniGroupSidebar(sb, miniGroupSelection.group, miniGroupSelection.addableMembers);
      return;
    }

    // All-of-one-kind → dedicated edit panel.
    if (wreathSel.length === selectedItems.length) {
      renderSelectedWreathSidebar(sb, wreathSel);
      return;
    }
    if (bowSel.length === selectedItems.length) {
      renderSelectedBowSidebar(sb, bowSel);
      return;
    }
    if (garlandSel.length === selectedItems.length) {
      renderSelectedGarlandSidebar(sb, garlandSel);
      return;
    }
    if (spritzerSel.length === selectedItems.length) {
      renderSelectedSpritzerSidebar(sb, spritzerSel);
      return;
    }
    if (textSel.length === selectedItems.length) {
      renderSelectedTextSidebar(sb, textSel);
      return;
    }
    if (customSel.length === selectedItems.length) {
      renderSelectedCustomSidebar(sb, customSel);
      return;
    }
    if (poleSel.length === selectedItems.length) {
      renderSelectedPoleSidebar(sb, poleSel);
      return;
    }
    if (miniAreaSel.length === selectedItems.length) {
      renderSelectedMiniAreaSidebar(sb, miniAreaSel);
      return;
    }
    if (strandSel.length === selectedItems.length) {
      // Pure-strand selection, no shared group matched above — falls through
      // to the strand panel below.
    } else if (strandSel.length > 0 && miniAreaSel.length > 0 && miniCandidates.length === selectedItems.length) {
      // #240: a mixed strand + scattershot selection (no shared group, or the
      // check above would already have returned) — offer to group them into
      // one billed unit, same affordance the strand-only panel has.
      const groupable = opts.showQuoteBinding && miniCandidates.length >= 2 && miniCandidates.every(isMiniGroupable);
      const canGroup = groupable && sharedMiniGroupColorPattern(miniCandidates) !== null;
      sb.innerHTML = `
        <section>
          <h3>Mixed selection</h3>
          <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px">
            ${strandSel.length} strand${strandSel.length === 1 ? "" : "s"} + ${miniAreaSel.length} scattershot${miniAreaSel.length === 1 ? "" : "s"} selected.
            ${groupable ? "Group them as one billed unit, or delete." : "Delete, or select only strands / only scattershots to edit them."}
          </div>
        </section>
        ${groupable ? `
        <section>
          <button id="sel-group-mini-mixed" style="width:100%" ${canGroup ? "" : "disabled"}>Group as one quote unit</button>
          <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">${canGroup ? `Bills these ${miniCandidates.length} items as a single unit (e.g. a railing).` : "Match the strand and scattershot color patterns before grouping."}</div>
        </section>
        ` : ""}
        <section><button class="danger" id="sel-delete" style="width:100%">Delete all selected</button></section>
      `;
      sb.querySelector("#sel-delete")?.addEventListener("click", deleteSelected);
      if (canGroup) {
        sb.querySelector("#sel-group-mini-mixed")?.addEventListener("click", () => {
          groupSelectedMini(miniCandidates, miniCandidates[0].surface ?? "bush", seedGroupStringCount(miniCandidates, miniCandidates[0].stringCount ?? 1));
        });
      }
      return;
    } else {
      // Mixed selection across other kinds — just offer delete.
      const counts: string[] = [];
      if (strandSel.length) counts.push(`${strandSel.length} strand${strandSel.length === 1 ? "" : "s"}`);
      if (garlandSel.length) counts.push(`${garlandSel.length} garland${garlandSel.length === 1 ? "" : "s"}`);
      if (wreathSel.length) counts.push(`${wreathSel.length} wreath${wreathSel.length === 1 ? "" : "s"}`);
      if (bowSel.length) counts.push(`${bowSel.length} bow${bowSel.length === 1 ? "" : "s"}`);
      if (spritzerSel.length) counts.push(`${spritzerSel.length} spritzer${spritzerSel.length === 1 ? "" : "s"}`);
      if (textSel.length) counts.push(`${textSel.length} text${textSel.length === 1 ? "" : "s"}`);
      if (customSel.length) counts.push(`${customSel.length} custom${customSel.length === 1 ? "" : "s"}`);
      if (poleSel.length) counts.push(`${poleSel.length} pole${poleSel.length === 1 ? "" : "s"}`);
      if (miniAreaSel.length) counts.push(`${miniAreaSel.length} scattershot${miniAreaSel.length === 1 ? "" : "s"}`);
      sb.innerHTML = `
        <section>
          <h3>Mixed selection</h3>
          <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px">
            ${counts.join(" + ")} selected. Edit one kind at a time, or just delete.
          </div>
        </section>
        <section><button class="danger" id="sel-delete" style="width:100%">Delete all selected</button></section>
      `;
      sb.querySelector("#sel-delete")?.addEventListener("click", deleteSelected);
      return;
    }
    const sel = strandSel;
    const isPerm = sel.every((s) => s.bulbType === "permanent");
    const isBistro = sel.every((s) => s.bulbType === "bistro");
    const sharedBulbType = uniq(sel.map((s) => s.bulbType));
    const sharedSpacing = uniq(sel.map((s) => s.spacingIn));
    const sharedPattern = uniq(sel.map((s) => s.colorPattern.join(",")));
    const groupableMiniSelection = opts.showQuoteBinding && sel.length >= 2 && sel.every(isMiniGroupable);
    const canCreateMiniGroup = groupableMiniSelection && sharedMiniGroupColorPattern(sel) !== null;
    const totalFt = sel.reduce((acc, s) => acc + strandLengthPx(s) / ppfForStrand(s), 0);
    const sharedYsId = uniq(sel.map((s) => s.yardstickId ?? ""));

    const spacingOptions = sharedBulbType.length === 1 ? SPACINGS[sharedBulbType[0] as BulbType] : SPACINGS.c9;

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Strand" : `Edit ${sel.length} Strands`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          ${totalFt.toFixed(1)} ft total · drag handles to resize/rotate · drag body to move
        </div>
      </section>

      ${(() => {
        // Quick way to grab every strand of the same bulb type without
        // bouncing back to the draw panel. Only shows when the selection is
        // all-one-type (mixed types would make the label ambiguous).
        if (sharedBulbType.length !== 1) return "";
        const bt = sharedBulbType[0] as BulbType;
        const count = allStrands().filter((s) => s.bulbType === bt).length;
        const typeLabel = BULB_TYPES.find((b) => b.id === bt)?.label ?? bt;
        return `<section><button id="sel-select-all-strands" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All ${typeLabel} Lights (${count})
        </button></section>`;
      })()}

      <section>
        <h3>Bulb Type</h3>
        <div class="bulb-types" id="sel-bulb-types">
          ${BULB_TYPES.filter((b) => opts.permanentOnly ? b.id === "permanent" : opts.bistroOnly ? b.id === "bistro" : true).map((b) => `<button data-type="${b.id}" class="${sharedBulbType.length === 1 && sharedBulbType[0] === b.id ? "active" : ""}">${b.label}</button>`).join("")}
        </div>
      </section>

      <section>
        ${spacingRowHtml(isPerm, spacingOptions, sharedSpacing, "sel-spacings")}
      </section>

      <section>
        <h3>Color${sharedPattern.length > 1 ? " (mixed)" : ""}</h3>
        <div class="colors" id="sel-colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}"></button>`).join("")}
        </div>
        <div style="margin-top:8px;color:var(--text-dim);font-size:11px">
          Tap a color to replace the pattern. To build a multi-color pattern, deselect first.
        </div>
      </section>

      ${scene.yardsticks.length > 0 ? `
      <section>
        <h3>Sized using${sharedYsId.length > 1 ? " (mixed)" : ""}</h3>
        <select id="sel-yardstick" class="yardstick-select">
          ${sharedYsId.length > 1 ? `<option value="" disabled selected>— mixed —</option>` : ""}
          ${scene.yardsticks.map((y, i) => {
            const isSel = sharedYsId.length === 1 && (sharedYsId[0] === y.id || (sharedYsId[0] === "" && y.id === yardstickForStrand(sel[0])?.id));
            return `<option value="${y.id}" ${isSel ? "selected" : ""}>${yardstickLabel(i)} — ${y.realFeet} ft</option>`;
          }).join("")}
        </select>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Changing this rescales the bulbs to match the new yardstick's pixels-per-foot.</div>
      </section>
      ` : ""}

      ${isPerm ? `
      <section>
        <h3>Beam Length <span id="sel-beam-len-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="sel-beam-len" min="0.5" max="20" step="0.1" value="${avg(sel.map((s) => s.beamLengthFt ?? 4))}" />
      </section>
      <section>
        <h3>Beam Width <span id="sel-beam-wid-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="sel-beam-wid" min="0.2" max="6" step="0.1" value="${avg(sel.map((s) => s.beamWidthFt ?? 1.5))}" />
      </section>
      <section>
        <h3>Distance to Surface <span id="sel-dist-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="sel-dist" min="0" max="5" step="0.1" value="${avg(sel.map((s) => s.distanceToSurfaceFt ?? 0))}" />
      </section>
      <section>
        <h3>Opacity <span id="sel-opacity-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="sel-opacity" min="0.1" max="1" step="0.01" value="${avg(sel.map((s) => s.opacity ?? 1))}" />
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-beam" ${sel.every((s) => (s.showBeam ?? true)) ? "checked" : ""} />
          <span>Show light beam</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Off = just the puck dots, no cone.</div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-coverage" ${sel.every((s) => (s.showCoverage ?? true)) ? "checked" : ""} />
          <span>Show floor coverage</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">The soft horizontal glow where the cones land.</div>
      </section>
      ` : ""}

      ${isBistro ? `
      <section>
        <h3>Sag <span id="sel-bistro-sag-val" style="float:right;color:var(--text);font-weight:400"></span></h3>
        <input type="range" id="sel-bistro-sag" min="0" max="0.25" step="0.005" value="${avg(sel.map((s) => s.sagFactor ?? 0.10))}" />
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Fraction of horizontal span the cord droops. 0 = taut, 0.25 = heavy.</div>
      </section>
      ` : ""}

      ${groupableMiniSelection ? `
      <section>
        <button id="sel-group-mini" style="width:100%" ${canCreateMiniGroup ? "" : "disabled"}>Group as one quote unit</button>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">${canCreateMiniGroup ? `Bills these ${sel.length} mini strands as a single unit (e.g. a railing).` : "Match the strand color patterns before grouping."}</div>
      </section>
      ` : ""}
      ${opts.showQuoteBinding ? (() => {
        // #249: pulled from surfaceOptionsForBulbType (surfaceOptions.ts) so this
        // dropdown and the pre-draw quick-tag section can't drift apart. That
        // function itself carries the RELAY comment for the standalone design
        // tool now — see task_ledger Stake Lighting relay note.
        const surfaceOpts: [string, string][] =
          sharedBulbType.length === 1 ? surfaceOptionsForBulbType(sharedBulbType[0] as BulbType) : [];
        // RELAY: roof-feature options are shared with the standalone design tool —
        // mirror any change there too (#82 Slice 2b clip-feature tag). Shown only
        // for c9 roofline runs; drives the inventory clip-SKU selection.
        const isC9Roofline = sharedBulbType.length === 1 && sharedBulbType[0] === "c9";
        const roofFeatureOpts: [string, string][] = [
          ["gutter", "Gutterline"],
          ["peak", "Peak (gable, no gutter)"],
          ["side", "Side (shingles)"],
          ["ridge", "Ridge (apex)"],
          ["pathway", "Pathway / stake"],
          ["flat", "Flat / commercial"],
          ["metal", "Metal roof (flag)"],
        ];
        const sRoofFeature = uniq(sel.map((s) => s.roofFeature ?? ""));
        // #249: pulled from sideOfHouseOptions (sideOfHouseOptions.ts) so this
        // dropdown and the permanent-only pre-draw quick-tag section can't
        // drift apart — mirrors the surfaceOpts precedent just above. That
        // module itself carries the RELAY comment for the standalone design
        // tool (#103). A staff tag shown for c9 + permanent strands; no
        // pricing yet.
        const showSideOfHouse =
          sharedBulbType.length === 1 && (sharedBulbType[0] === "c9" || sharedBulbType[0] === "permanent");
        const sideOfHouseOpts: [string, string][] = sideOfHouseOptions();
        const sSideOfHouse = uniq(sel.map((s) => s.sideOfHouse ?? ""));
        const sSurface = uniq(sel.map((s) => s.surface ?? ""));
        const sInc = uniq(sel.map((s) => s.included ?? true));
        const sWrap = uniq(sel.map((s) => s.wrapStyle ?? "canopy"));
        const sCount = uniq(sel.map((s) => s.stringCount ?? 1));
        // Wrap style applies to wrapped surfaces only — railings and columns
        // have no wrap (the quote prices both per string and ignores
        // wrapStyle; only bushes/trees vary canopy vs trunk).
        const wrapSurface = sSurface.length === 1 && ["bush", "tree"].includes(sSurface[0]);
        const countSurface = sSurface.length === 1 && ["bush", "tree", "column", "railing", "curtain"].includes(sSurface[0]);
        return `
      <section>
        <h3>Quote binding</h3>
        ${surfaceOpts.length ? `
        <label style="display:block;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Surface</label>
        <select id="sel-surface" class="yardstick-select">
          <option value="">${sSurface.length > 1 ? "— mixed —" : "— none (untagged) —"}</option>
          ${surfaceOpts.map(([v, l]) => `<option value="${v}" ${sSurface.length === 1 && sSurface[0] === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        ` : `<div style="font-size:11px;color:var(--text-dim)">This light type isn't quoted yet — nothing to tag.</div>`}
        ${isC9Roofline ? `
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Roof feature</label>
        <select id="sel-roof-feature" class="yardstick-select">
          <option value="">${sRoofFeature.length > 1 ? "— mixed —" : "— none —"}</option>
          ${roofFeatureOpts.map(([v, l]) => `<option value="${v}" ${sRoofFeature.length === 1 && sRoofFeature[0] === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Clip type for the materials list. Metal = no clip (flag for staff). No window/C7 lighting.</div>
        ` : ""}
        ${showSideOfHouse ? `
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Side of house</label>
        <select id="sel-side-of-house" class="yardstick-select">
          <option value="">${sSideOfHouse.length > 1 ? "— mixed —" : "— none —"}</option>
          ${sideOfHouseOpts.map(([v, l]) => `<option value="${v}" ${sSideOfHouse.length === 1 && sSideOfHouse[0] === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Left/right = the HOMEOWNER's, standing at the front door facing the street — the MIRROR of your own left/right looking at the house from the road.</div>
        ` : ""}
        ${wrapSurface ? `
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Wrap style</label>
        <select id="sel-wrapstyle" class="yardstick-select">
          <option value="canopy" ${sWrap.length === 1 && sWrap[0] === "canopy" ? "selected" : ""}>Canopy</option>
          <option value="trunk" ${sWrap.length === 1 && sWrap[0] === "trunk" ? "selected" : ""}>Trunk</option>
        </select>
        ` : ""}
        ${countSurface ? `
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">String count</label>
        <input type="number" id="sel-stringcount" class="yardstick-select" style="width:90px" min="1" step="1" value="${sCount.length === 1 ? sCount[0] : 1}" />
        ` : ""}
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px">
          <input type="checkbox" id="sel-included" ${sInc.length === 1 && sInc[0] === false ? "" : "checked"} />
          <span>Included in quote</span>
        </label>
      </section>`;
      })() : ""}

      <section style="display:flex;gap:6px">
        <button id="sel-duplicate">Duplicate</button>
        <button id="sel-delete" class="danger">Delete</button>
      </section>
    `;

    // Discrete updates — full redraw + commit + save.
    const updateSelected = (mut: (s: Strand) => Strand) => {
      scene = {
        ...scene,
        items: scene.items.map((s) => (isStrand(s) && selectedIds.has(s.id) ? mut(s) : s)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };
    const updateSelectedColors = (mut: (pattern: string[]) => string[]) => {
      const next = updateSelectedColorPatterns(scene, selectedIds, mut);
      if (next === scene) return;
      scene = next;
      scheduleSave();
      commit();
      redrawScene();
    };

    // Continuous updates (slider drags) — mutate scene, request a coalesced canvas redraw,
    // update only the slider label inline so the sidebar HTML isn't recreated.
    const liveUpdateSelected = (mut: (s: Strand) => Strand) => {
      scene = {
        ...scene,
        items: scene.items.map((s) => (isStrand(s) && selectedIds.has(s.id) ? mut(s) : s)),
      };
      scheduleSave();
      requestCanvasRedraw();
    };

    sb.querySelector("#sel-select-all-strands")?.addEventListener("click", () => {
      if (sharedBulbType.length !== 1) return;
      const bt = sharedBulbType[0] as BulbType;
      const ids = allStrands().filter((s) => s.bulbType === bt).map((s) => s.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#sel-bulb-types button").forEach((b) =>
      b.addEventListener("click", () => {
        const t = (b as HTMLElement).dataset.type as BulbType;
        updateSelected((s) => ({ ...s, bulbType: t, spacingIn: SPACINGS[t].includes(s.spacingIn) ? s.spacingIn : SPACINGS[t][Math.floor(SPACINGS[t].length / 2)] }));
      }),
    );
    sb.querySelectorAll("#sel-spacings button").forEach((b) =>
      b.addEventListener("click", () => {
        const v = Number((b as HTMLElement).dataset.s);
        updateSelected((s) => ({ ...s, spacingIn: v }));
      }),
    );
    sb.querySelectorAll("#sel-colors button").forEach((b) =>
      b.addEventListener("click", () => {
        const c = (b as HTMLElement).dataset.c!;
        updateSelectedColors(() => [c]);
      }),
    );

    const ysSelect = sb.querySelector("#sel-yardstick") as HTMLSelectElement | null;
    ysSelect?.addEventListener("change", () => {
      const newYsId = ysSelect.value;
      if (!newYsId) return;
      updateSelected((s) => ({ ...s, yardstickId: newYsId }));
    });

    if (isPerm) {
      const wire = (id: string, key: keyof Strand, suffix: string, decimals: number) => {
        const input = sb.querySelector(`#${id}`) as HTMLInputElement;
        const label = sb.querySelector(`#${id}-val`) as HTMLElement;
        const writeLabel = () => {
          label.textContent = `${Number(input.value).toFixed(decimals)}${suffix}`;
        };
        writeLabel();
        // Smooth drag: update on every input but coalesce canvas redraws via rAF.
        input.addEventListener("input", () => {
          writeLabel();
          const v = Number(input.value);
          liveUpdateSelected((s) => ({ ...s, [key]: v }) as Strand);
        });
        // Snapshot for history once the drag ends.
        input.addEventListener("change", () => {
          commit();
        });
      };
      wire("sel-beam-len", "beamLengthFt", " ft", 1);
      wire("sel-beam-wid", "beamWidthFt", " ft", 1);
      wire("sel-dist", "distanceToSurfaceFt", " ft", 1);
      wire("sel-opacity", "opacity", "", 2);

      const beamSelCb = sb.querySelector("#sel-beam") as HTMLInputElement;
      beamSelCb.addEventListener("change", () => {
        updateSelected((s) => ({ ...s, showBeam: beamSelCb.checked }));
      });
      const coverageCb = sb.querySelector("#sel-coverage") as HTMLInputElement;
      coverageCb.addEventListener("change", () => {
        updateSelected((s) => ({ ...s, showCoverage: coverageCb.checked }));
      });
    }

    if (isBistro) {
      // Per-strand sag slider — live updates the catenary as you drag, then
      // snapshots history on release like the perm-light sliders.
      const input = sb.querySelector("#sel-bistro-sag") as HTMLInputElement | null;
      const label = sb.querySelector("#sel-bistro-sag-val") as HTMLElement | null;
      if (input && label) {
        const writeLabel = () => {
          label.textContent = `${(Number(input.value) * 100).toFixed(0)}%`;
        };
        writeLabel();
        input.addEventListener("input", () => {
          writeLabel();
          const v = Number(input.value);
          liveUpdateSelected((s) => ({ ...s, sagFactor: v }) as Strand);
        });
        input.addEventListener("change", () => {
          commit();
        });
      }
    }

    sb.querySelector("#sel-duplicate")!.addEventListener("click", () => {
      const newStrands = sel.map((s) => ({
        ...s,
        id: cryptoId(),
        groupId: undefined,
        linkedToId: undefined,
        points: s.points.map((p) => p + 20),
      }));
      scene = { ...scene, items: [...scene.items, ...newStrands] };
      selectedIds = new Set(newStrands.map((s) => s.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    if (opts.showQuoteBinding) {
      const surfSel = sb.querySelector("#sel-surface") as HTMLSelectElement | null;
      surfSel?.addEventListener("change", () => {
        const v = surfSel.value;
        // Railing or Curtain across a multi-selection means ONE grouped unit built
        // from these strands — emit a single MiniGroupItem (projection bills one
        // "Railing – N strings" / "Curtain Lights – N strings") instead of tagging
        // each strand as its own billed unit. #334: seed via seedGroupStringCount,
        // fallback sel.length (this site's historical seed, unchanged) — each
        // strand carries its own staff-editable stringCount (the #sel-stringcount
        // field above, shown whenever a selection's surface is bush/tree/column/
        // railing/curtain). Summing only fires when a member carries an explicit
        // count above 1 (a staffer set real per-strand counts before re-tagging to
        // Railing/Curtain); otherwise this seeds exactly sel.length, same as
        // before — a prod sweep found 84% of grouped members sit at the untouched
        // default of 1, where summing would silently OVER-bill (see
        // miniGroupBilling.ts), so the ordinary trace-then-group workflow is left
        // alone on purpose.
        // #227 FIX 2: exclude a selection containing a #13 linked twin — grouping
        // a twin (a render-only depiction of a canonical strand on ANOTHER photo)
        // lets a later delete of that OTHER photo's canonical cascade-prune the
        // group server-side while this already-mounted editor's stale in-memory
        // scene still holds it, so the next autosave resurrects the (still-
        // billing) group. Twins never bill on their own (projectScene skips
        // `linkedToId` items), so falling through to a plain surface tag below is
        // harmless — it just doesn't create a group to resurrect.
        if ((v === "railing" || v === "curtain") && groupableMiniSelection) {
          if (canCreateMiniGroup) groupSelectedMini(sel, v, seedGroupStringCount(sel, sel.length));
          else renderSidebar();
          return;
        }
        updateSelected((s) => ({ ...s, surface: v ? (v as Surface) : null }));
      });
      const roofSel = sb.querySelector("#sel-roof-feature") as HTMLSelectElement | null;
      roofSel?.addEventListener("change", () => {
        updateSelected((s) => ({ ...s, roofFeature: roofSel.value ? (roofSel.value as RoofFeature) : null }));
      });
      const sideSel = sb.querySelector("#sel-side-of-house") as HTMLSelectElement | null;
      sideSel?.addEventListener("change", () => {
        // #249 review fix (provenance): any deliberate write through this
        // dropdown — including re-confirming the side the sticky pre-draw tag
        // already guessed — clears sideOfHouseAuto, so training-example
        // capture (trainingExamples.ts extractFinalStreetRuns) treats the tag
        // as human-confirmed from here on. updateSelected replaces the whole
        // strand object per selected item, so the flag reliably clears.
        updateSelected((s) => ({
          ...s,
          sideOfHouse: sideSel.value ? (sideSel.value as SideOfHouse) : null,
          sideOfHouseAuto: false,
        }));
      });
      const wrapSel = sb.querySelector("#sel-wrapstyle") as HTMLSelectElement | null;
      wrapSel?.addEventListener("change", () => {
        updateSelected((s) => ({ ...s, wrapStyle: wrapSel.value as WrapStyle }));
      });
      const scInput = sb.querySelector("#sel-stringcount") as HTMLInputElement | null;
      scInput?.addEventListener("change", () => {
        const n = Math.max(1, Math.round(Number(scInput.value) || 1));
        updateSelected((s) => ({ ...s, stringCount: n }));
      });
      const incCb = sb.querySelector("#sel-included") as HTMLInputElement | null;
      incCb?.addEventListener("change", () => {
        updateSelected((s) => ({ ...s, included: incCb.checked }));
      });
    }
    sb.querySelector("#sel-group-mini")?.addEventListener("click", () => {
      groupSelectedMini(sel, sel[0].surface ?? "bush", seedGroupStringCount(sel, sel[0].stringCount ?? 1));
    });
    sb.querySelector("#sel-delete")!.addEventListener("click", deleteSelected);
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected wreath(s)
  // ============================================================
  function renderSelectedWreathSidebar(sb: HTMLElement, sel: WreathItem[]) {
    const sharedSize = uniq(sel.map((w) => w.sizeIn));
    const sharedWithLights = uniq(sel.map((w) => w.withLights));
    const sharedWithBow = uniq(sel.map((w) => w.withBow ?? true));

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Wreath" : `Edit ${sel.length} Wreaths`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag the body to move · drag corners to resize · drag rotation handle to rotate.
        </div>
      </section>
      ${(() => {
        const count = allWreaths().length;
        return `<section><button id="sel-select-all-wreaths" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Wreaths (${count})
        </button></section>`;
      })()}
      <section>
        <h3>Size${offPresetSizeSuffix(WREATH_SIZES, sharedSize)}</h3>
        <div class="spacing-row" id="sel-wreath-sizes">
          ${sizeButtons(WREATH_SIZES, sharedSize, "data-s")}
        </div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-wreath-with-lights" ${sharedWithLights.length === 1 && sharedWithLights[0] ? "checked" : ""} />
          <span>With lights${sharedWithLights.length > 1 ? " (mixed)" : ""}</span>
        </label>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-wreath-with-bow" ${sharedWithBow.length === 1 && sharedWithBow[0] ? "checked" : ""} />
          <span>Include bow${sharedWithBow.length > 1 ? " (mixed)" : ""}</span>
        </label>
      </section>
      ${opts.showQuoteBinding ? (() => {
        const sQS = uniq(sel.map((w) => w.quoteSize ?? ""));
        const sTier = uniq(sel.map((w) => w.tier ?? ""));
        const sInc = uniq(sel.map((w) => w.included ?? true));
        const WSIZES: [string, string][] = [["24noble", '24" Noble'], ["30noble", '30" Noble'], ["36noble", '36" Noble'], ["48noble", '48" Noble'], ["60noble", '60" Noble'], ["72noble", '72" Noble']];
        return `
      <section>
        <h3>Quote binding</h3>
        <label style="display:block;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Quote size (billed product)</label>
        <select id="sel-wreath-qsize" class="yardstick-select">
          <option value="">${sQS.length > 1 ? "— mixed —" : "— none —"}</option>
          ${WSIZES.map(([v, l]) => `<option value="${v}" ${sQS.length === 1 && sQS[0] === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Tier</label>
        <select id="sel-wreath-tier" class="yardstick-select">
          <option value="">${sTier.length > 1 ? "— mixed —" : "— none —"}</option>
          <option value="bow" ${sTier.length === 1 && sTier[0] === "bow" ? "selected" : ""}>Non-decorated</option>
          <option value="fullDecor" ${sTier.length === 1 && sTier[0] === "fullDecor" ? "selected" : ""}>Decorated</option>
        </select>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px">
          <input type="checkbox" id="sel-wreath-included" ${sInc.length === 1 && sInc[0] === false ? "" : "checked"} />
          <span>Included in quote</span>
        </label>
        ${sel.some((w) => w.quoteSize === undefined || w.tier === undefined)
          ? `<div style="margin-top:8px;font-size:11px;color:var(--warn,#c9831f)">⚠ No billed size/tier set — will default to 36" Noble Non-decorated.</div>`
          : ""}
      </section>`;
      })() : ""}
      <section style="display:flex;gap:6px">
        <button id="sel-wreath-duplicate">Duplicate</button>
        <button id="sel-wreath-delete" class="danger">Delete</button>
      </section>
    `;

    const updateWreaths = (mut: (w: WreathItem) => WreathItem) => {
      scene = {
        ...scene,
        items: scene.items.map((i) => (isWreath(i) && selectedIds.has(i.id) ? mut(i) : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };

    sb.querySelector("#sel-select-all-wreaths")?.addEventListener("click", () => {
      const ids = allWreaths().map((w) => w.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#sel-wreath-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        const v = Number((b as HTMLElement).dataset.s);
        updateWreaths((w) => ({ ...w, sizeIn: v }));
      }),
    );
    const wl = sb.querySelector("#sel-wreath-with-lights") as HTMLInputElement | null;
    wl?.addEventListener("change", () => {
      updateWreaths((w) => ({ ...w, withLights: wl.checked }));
    });
    const wb = sb.querySelector("#sel-wreath-with-bow") as HTMLInputElement | null;
    wb?.addEventListener("change", () => {
      updateWreaths((w) => ({ ...w, withBow: wb.checked }));
    });

    sb.querySelector("#sel-wreath-duplicate")?.addEventListener("click", () => {
      const newWreaths = sel.map((w) => ({ ...w, id: cryptoId(), x: w.x + 20, y: w.y + 20 }));
      scene = { ...scene, items: [...scene.items, ...newWreaths] };
      selectedIds = new Set(newWreaths.map((w) => w.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    if (opts.showQuoteBinding) {
      const qs = sb.querySelector("#sel-wreath-qsize") as HTMLSelectElement | null;
      qs?.addEventListener("change", () => {
        const v = qs.value;
        updateWreaths((w) => ({ ...w, quoteSize: v ? (v as QuoteWreathSize) : undefined }));
      });
      const tr = sb.querySelector("#sel-wreath-tier") as HTMLSelectElement | null;
      tr?.addEventListener("change", () => {
        const v = tr.value;
        updateWreaths((w) => ({ ...w, tier: v ? (v as Tier) : undefined }));
      });
      const inc = sb.querySelector("#sel-wreath-included") as HTMLInputElement | null;
      inc?.addEventListener("change", () => {
        updateWreaths((w) => ({ ...w, included: inc.checked }));
      });
    }
    sb.querySelector("#sel-wreath-delete")?.addEventListener("click", deleteSelected);
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected bow(s)
  // ============================================================
  function renderSelectedBowSidebar(sb: HTMLElement, sel: BowItem[]) {
    const sharedSize = uniq(sel.map((b) => b.sizeIn));

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Bow" : `Edit ${sel.length} Bows`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag the body to move · drag corners to resize · drag rotation handle to rotate.
        </div>
      </section>
      ${(() => {
        const count = allBows().length;
        return `<section><button id="sel-select-all-bows" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Bows (${count})
        </button></section>`;
      })()}
      <section>
        <h3>Size${offPresetSizeSuffix(BOW_SIZES, sharedSize)}</h3>
        <div class="spacing-row" id="sel-bow-sizes">
          ${sizeButtons(BOW_SIZES, sharedSize, "data-s")}
        </div>
      </section>
      <section style="display:flex;gap:6px">
        <button id="sel-bow-duplicate">Duplicate</button>
        <button id="sel-bow-delete" class="danger">Delete</button>
      </section>
    `;

    const updateBows = (mut: (b: BowItem) => BowItem) => {
      scene = {
        ...scene,
        items: scene.items.map((i) => (isBow(i) && selectedIds.has(i.id) ? mut(i) : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };

    sb.querySelector("#sel-select-all-bows")?.addEventListener("click", () => {
      const ids = allBows().map((b) => b.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#sel-bow-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        const v = Number((b as HTMLElement).dataset.s);
        updateBows((bow) => ({ ...bow, sizeIn: v }));
      }),
    );
    sb.querySelector("#sel-bow-duplicate")?.addEventListener("click", () => {
      const newBows = sel.map((b) => ({ ...b, id: cryptoId(), x: b.x + 20, y: b.y + 20 }));
      scene = { ...scene, items: [...scene.items, ...newBows] };
      selectedIds = new Set(newBows.map((b) => b.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    sb.querySelector("#sel-bow-delete")?.addEventListener("click", deleteSelected);
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected garland(s)
  // ============================================================
  function renderSelectedGarlandSidebar(sb: HTMLElement, sel: GarlandItem[]) {
    const sharedSize = uniq(sel.map((g) => g.sizeIn ?? 12));
    const sharedWithLights = uniq(sel.map((g) => g.withLights));
    const sharedYsId = uniq(sel.map((g) => g.yardstickId ?? ""));
    const totalFt = sel.reduce((acc, g) => acc + garlandLengthPx(g) / ppfForGarland(g), 0);

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Garland" : `Edit ${sel.length} Garlands`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          ${totalFt.toFixed(1)} ft total · drag handles to resize/rotate · drag body to move
        </div>
      </section>
      ${(() => {
        const count = allGarlands().length;
        return `<section><button id="sel-select-all-garlands" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Garlands (${count})
        </button></section>`;
      })()}
      <section>
        <h3>Size${sharedSize.length > 1 ? " — mixed" : offPresetSizeSuffix(GARLAND_SIZES, sharedSize)}</h3>
        <div class="spacing-row" id="sel-garland-sizes">
          ${sizeButtons(GARLAND_SIZES, sharedSize, "data-s")}
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Thickness of the greenery rope.</div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-garland-with-lights" ${sharedWithLights.length === 1 && sharedWithLights[0] ? "checked" : ""} />
          <span>With lights${sharedWithLights.length > 1 ? " (mixed)" : ""}</span>
        </label>
      </section>
      ${scene.yardsticks.length > 0 ? `
      <section>
        <h3>Sized using${sharedYsId.length > 1 ? " (mixed)" : ""}</h3>
        <select id="sel-garland-yardstick" class="yardstick-select">
          ${sharedYsId.length > 1 ? `<option value="" disabled selected>— mixed —</option>` : ""}
          ${scene.yardsticks.map((y, i) => {
            const isSel = sharedYsId.length === 1 && (sharedYsId[0] === y.id || (sharedYsId[0] === "" && y.id === yardstickForGarland(sel[0])?.id));
            return `<option value="${y.id}" ${isSel ? "selected" : ""}>${yardstickLabel(i)} — ${y.realFeet} ft</option>`;
          }).join("")}
        </select>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Changes the px/ft used to scale the garland's stamp size.</div>
      </section>
      ` : ""}
      ${opts.showQuoteBinding ? (() => {
        const sQL = uniq(sel.map((g) => g.quoteLength ?? ""));
        const sSec = uniq(sel.map((g) => g.quoteSections ?? 1));
        const sTier = uniq(sel.map((g) => g.tier ?? ""));
        const sInc = uniq(sel.map((g) => g.included ?? true));
        return `
      <section>
        <h3>Quote binding</h3>
        <label style="display:block;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Section length</label>
        <select id="sel-garland-qlength" class="yardstick-select">
          <option value="">${sQL.length > 1 ? "— mixed —" : "— none —"}</option>
          <option value="4.5ft" ${sQL.length === 1 && sQL[0] === "4.5ft" ? "selected" : ""}>4.5 ft</option>
          <option value="9ft" ${sQL.length === 1 && sQL[0] === "9ft" ? "selected" : ""}>9 ft</option>
        </select>
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)"># sections</label>
        <input type="number" id="sel-garland-sections" class="yardstick-select" style="width:90px" min="1" step="1" value="${sSec.length === 1 ? sSec[0] : 1}" />
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Tier</label>
        <select id="sel-garland-tier" class="yardstick-select">
          <option value="">${sTier.length > 1 ? "— mixed —" : "— none —"}</option>
          <option value="bow" ${sTier.length === 1 && sTier[0] === "bow" ? "selected" : ""}>Non-decorated</option>
          <option value="fullDecor" ${sTier.length === 1 && sTier[0] === "fullDecor" ? "selected" : ""}>Decorated</option>
        </select>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px">
          <input type="checkbox" id="sel-garland-included" ${sInc.length === 1 && sInc[0] === false ? "" : "checked"} />
          <span>Included in quote</span>
        </label>
        ${sel.some((g) => g.quoteLength === undefined || g.tier === undefined)
          ? `<div style="margin-top:8px;font-size:11px;color:var(--warn,#c9831f)">⚠ No billed length/tier set — will default to 9 ft Decorated.</div>`
          : ""}
      </section>`;
      })() : ""}
      <section style="display:flex;gap:6px">
        <button id="sel-garland-duplicate">Duplicate</button>
        <button id="sel-garland-delete" class="danger">Delete</button>
      </section>
    `;

    const updateGarlands = (mut: (g: GarlandItem) => GarlandItem) => {
      scene = {
        ...scene,
        items: scene.items.map((i) => (isGarland(i) && selectedIds.has(i.id) ? mut(i) : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };

    sb.querySelector("#sel-select-all-garlands")?.addEventListener("click", () => {
      const ids = allGarlands().map((g) => g.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#sel-garland-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        const v = Number((b as HTMLElement).dataset.s);
        updateGarlands((g) => ({ ...g, sizeIn: v }));
      }),
    );

    const wl = sb.querySelector("#sel-garland-with-lights") as HTMLInputElement | null;
    wl?.addEventListener("change", () => {
      updateGarlands((g) => ({ ...g, withLights: wl.checked }));
    });

    const ysSel = sb.querySelector("#sel-garland-yardstick") as HTMLSelectElement | null;
    ysSel?.addEventListener("change", () => {
      const newYsId = ysSel.value;
      if (!newYsId) return;
      updateGarlands((g) => ({ ...g, yardstickId: newYsId }));
    });

    sb.querySelector("#sel-garland-duplicate")?.addEventListener("click", () => {
      const newGarlands = sel.map((g) => ({
        ...g,
        id: cryptoId(),
        points: g.points.map((p) => p + 20),
      }));
      scene = { ...scene, items: [...scene.items, ...newGarlands] };
      selectedIds = new Set(newGarlands.map((g) => g.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    if (opts.showQuoteBinding) {
      const ql = sb.querySelector("#sel-garland-qlength") as HTMLSelectElement | null;
      ql?.addEventListener("change", () => {
        const v = ql.value;
        updateGarlands((g) => ({ ...g, quoteLength: v ? (v as QuoteGarlandLength) : undefined }));
      });
      const sec = sb.querySelector("#sel-garland-sections") as HTMLInputElement | null;
      sec?.addEventListener("change", () => {
        const n = Math.max(1, Math.round(Number(sec.value) || 1));
        updateGarlands((g) => ({ ...g, quoteSections: n }));
      });
      const tr = sb.querySelector("#sel-garland-tier") as HTMLSelectElement | null;
      tr?.addEventListener("change", () => {
        const v = tr.value;
        updateGarlands((g) => ({ ...g, tier: v ? (v as Tier) : undefined }));
      });
      const inc = sb.querySelector("#sel-garland-included") as HTMLInputElement | null;
      inc?.addEventListener("change", () => {
        updateGarlands((g) => ({ ...g, included: inc.checked }));
      });
    }
    sb.querySelector("#sel-garland-delete")?.addEventListener("click", deleteSelected);
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected spritzer(s)
  // ============================================================
  function renderSelectedSpritzerSidebar(sb: HTMLElement, sel: SpritzerItem[]) {
    const sharedSize = uniq(sel.map((s) => s.sizeIn));
    const sharedPattern = uniq(sel.map((s) => s.colorPattern.join(",")));
    const firstPattern = sel[0].colorPattern;

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Spritzer" : `Edit ${sel.length} Spritzers`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag the body to move · drag corners to resize.
        </div>
      </section>
      ${(() => {
        const count = allSpritzers().length;
        return `<section><button id="sel-select-all-spritzers" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Spritzers (${count})
        </button></section>`;
      })()}
      <section>
        <h3>Size${sharedSize.length > 1 ? " — mixed" : offPresetSizeSuffix(SPRITZER_SIZES, sharedSize)}</h3>
        <div class="spacing-row" id="sel-spritzer-sizes">
          ${sizeButtons(SPRITZER_SIZES, sharedSize, "data-s")}
        </div>
      </section>
      <section>
        <h3>Color${sharedPattern.length > 1 ? " (mixed)" : ""}</h3>
        <div class="colors" id="sel-spritzer-colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}"></button>`).join("")}
        </div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button id="sel-spritzer-add-color" class="${spAddArmed ? "active" : ""}">${spAddArmed ? "Tap a color to add…" : "+ Add to pattern"}</button>
          <button id="sel-spritzer-clear-pattern">Clear</button>
          <button id="sel-spritzer-multi" title="Set the pattern to every color in the palette">Multi</button>
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">
          Tap a color to recolor everything · "+ Add to pattern" then a color to extend the pattern.
        </div>
        ${sharedPattern.length === 1 ? `
        <div class="pattern-row" id="sel-spritzer-pattern">
          ${firstPattern.map((id, i) => {
            const c = COLORS.find((cc) => cc.id === id);
            return `<div class="swatch" data-i="${i}" style="background:${c?.hex ?? "#333"}"><button>×</button></div>`;
          }).join("")}
        </div>` : `
        <div style="margin-top:8px;color:var(--text-dim);font-size:11px">
          Patterns differ across the selection. Tap a color to make them match, or use Multi for rainbow.
        </div>`}
      </section>
      ${opts.showQuoteBinding ? (() => {
        const sQS = uniq(sel.map((s) => s.quoteSize ?? ""));
        const sInc = uniq(sel.map((s) => s.included ?? true));
        return `
      <section>
        <h3>Quote binding</h3>
        <label style="display:block;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Quote size (billed)</label>
        <select id="sel-spritzer-qsize" class="yardstick-select">
          <option value="">${sQS.length > 1 ? "— mixed —" : "— none —"}</option>
          <option value="16" ${sQS.length === 1 && sQS[0] === "16" ? "selected" : ""}>16"</option>
          <option value="24" ${sQS.length === 1 && sQS[0] === "24" ? "selected" : ""}>24"</option>
          <option value="32" ${sQS.length === 1 && sQS[0] === "32" ? "selected" : ""}>32"</option>
        </select>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px">
          <input type="checkbox" id="sel-spritzer-included" ${sInc.length === 1 && sInc[0] === false ? "" : "checked"} />
          <span>Included in quote</span>
        </label>
        ${sel.some((s) => s.quoteSize === undefined)
          ? `<div style="margin-top:8px;font-size:11px;color:var(--warn,#c9831f)">⚠ No billed size set — will default to 24".</div>`
          : ""}
      </section>`;
      })() : ""}
      <section style="display:flex;gap:6px">
        <button id="sel-spritzer-duplicate">Duplicate</button>
        <button id="sel-spritzer-delete" class="danger">Delete</button>
      </section>
    `;

    const updateSpritzers = (mut: (s: SpritzerItem) => SpritzerItem) => {
      scene = {
        ...scene,
        items: scene.items.map((i) => (isSpritzer(i) && selectedIds.has(i.id) ? mut(i) : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };

    sb.querySelector("#sel-select-all-spritzers")?.addEventListener("click", () => {
      const ids = allSpritzers().map((s) => s.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#sel-spritzer-sizes button").forEach((b) =>
      b.addEventListener("click", () => {
        const v = Number((b as HTMLElement).dataset.s);
        updateSpritzers((s) => ({ ...s, sizeIn: v }));
      }),
    );
    // Color pattern — same gestures as the scattershot edit panel: a plain tap
    // recolors the whole pattern; "+ Add to pattern" ARMS the next tap to
    // append instead, so building red+green is: tap red → Add → tap green.
    sb.querySelectorAll("#sel-spritzer-colors button").forEach((b) =>
      b.addEventListener("click", () => {
        const id = (b as HTMLElement).dataset.c!;
        if (spAddArmed) {
          spAddArmed = false;
          updateSpritzers((s) => ({ ...s, colorPattern: [...s.colorPattern, id] }));
        } else {
          updateSpritzers((s) => ({ ...s, colorPattern: [id] }));
        }
      }),
    );
    sb.querySelector("#sel-spritzer-add-color")?.addEventListener("click", () => {
      spAddArmed = !spAddArmed;
      renderSidebar();
    });
    sb.querySelector("#sel-spritzer-clear-pattern")?.addEventListener("click", () => {
      spAddArmed = false;
      updateSpritzers((s) => ({ ...s, colorPattern: [s.colorPattern[0] ?? "warm-white"] }));
    });
    sb.querySelector("#sel-spritzer-multi")?.addEventListener("click", () => {
      spAddArmed = false;
      const all = COLORS.map((c) => c.id);
      updateSpritzers((s) => ({ ...s, colorPattern: all }));
    });
    sb.querySelectorAll("#sel-spritzer-pattern .swatch button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = Number(((btn as HTMLElement).parentElement as HTMLElement).dataset.i);
        updateSpritzers((s) => {
          const next = s.colorPattern.filter((_, idx) => idx !== i);
          return { ...s, colorPattern: next.length === 0 ? [s.colorPattern[0] ?? "warm-white"] : next };
        });
      });
    });

    sb.querySelector("#sel-spritzer-duplicate")?.addEventListener("click", () => {
      const newSpritzers = sel.map((s) => ({ ...s, id: cryptoId(), x: s.x + 20, y: s.y + 20 }));
      scene = { ...scene, items: [...scene.items, ...newSpritzers] };
      selectedIds = new Set(newSpritzers.map((s) => s.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    if (opts.showQuoteBinding) {
      const qs = sb.querySelector("#sel-spritzer-qsize") as HTMLSelectElement | null;
      qs?.addEventListener("change", () => {
        const v = qs.value;
        updateSpritzers((s) => ({ ...s, quoteSize: v ? (v as QuoteSpritzerSize) : undefined }));
      });
      const inc = sb.querySelector("#sel-spritzer-included") as HTMLInputElement | null;
      inc?.addEventListener("change", () => {
        updateSpritzers((s) => ({ ...s, included: inc.checked }));
      });
    }
    sb.querySelector("#sel-spritzer-delete")?.addEventListener("click", deleteSelected);
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected mini-area(s)
  // ============================================================
  function renderSelectedMiniAreaSidebar(sb: HTMLElement, sel: MiniAreaItem[]) {
    const sharedDensity = uniq(sel.map((a) => a.density ?? 0.5));
    const sSurface = uniq(sel.map((a) => a.surface ?? ""));
    const sWrap = uniq(sel.map((a) => a.wrapStyle ?? "canopy"));
    const sCount = uniq(sel.map((a) => a.stringCount ?? 1));
    const sInc = uniq(sel.map((a) => a.included ?? true));
    const densityVal = sharedDensity.length === 1 ? sharedDensity[0] : 0.5;
    const groupableMiniSelection = opts.showQuoteBinding && sel.length >= 2 && sel.every(isMiniGroupable);
    const canCreateMiniGroup = groupableMiniSelection && sharedMiniGroupColorPattern(sel) !== null;
    const selectableMiniAreas = allMiniAreas();

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Scattershot" : `Edit ${sel.length} Scattershots`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag the body to move · drag corners to resize the fill region.
        </div>
      </section>
      ${(() => {
        const count = selectableMiniAreas.length;
        return `<section><button id="sel-select-all-miniareas" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Scattershots (${count})
        </button></section>`;
      })()}
      <section>
        <h3>Fill density <span id="sel-ma-density-val" style="float:right;color:var(--text);font-weight:400">${Math.round(densityVal * 100)}%</span></h3>
        <input type="range" id="sel-ma-density" min="0" max="1" step="0.05" value="${densityVal}" />
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Visual only — how densely the area fills with mini-lights. Doesn't affect the quote.</div>
      </section>
      ${(() => {
        const sharedPattern = uniq(sel.map((a) => (a.colorPattern ?? []).join(",")));
        const firstPattern = sel[0].colorPattern ?? [];
        return `
      <section>
        <h3>Color${sharedPattern.length > 1 ? " (mixed)" : ""}</h3>
        <div class="colors" id="sel-ma-colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}"></button>`).join("")}
        </div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button id="sel-ma-add-color" class="${maAddArmed ? "active" : ""}">${maAddArmed ? "Tap a color to add…" : "+ Add to pattern"}</button>
          <button id="sel-ma-clear-pattern">Clear</button>
          <button id="sel-ma-multi" title="Set the pattern to every color in the palette">Multi</button>
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">
          Tap a color to recolor everything · "+ Add to pattern" then a color to extend the pattern.
        </div>
        ${sharedPattern.length === 1 ? `
        <div class="pattern-row" id="sel-ma-pattern">
          ${firstPattern.map((id, i) => {
            const c = COLORS.find((cc) => cc.id === id);
            return `<div class="swatch" data-i="${i}" style="background:${c?.hex ?? "#333"}"><button>×</button></div>`;
          }).join("")}
        </div>` : `
        <div style="margin-top:8px;color:var(--text-dim);font-size:11px">
          Patterns differ across the selection. Tap a color to make them match, or use Multi for rainbow.
        </div>`}
      </section>`;
      })()}
      ${groupableMiniSelection ? `
      <section>
        <button id="sel-group-mini-area" style="width:100%" ${canCreateMiniGroup ? "" : "disabled"}>Group as one quote unit</button>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">${canCreateMiniGroup ? `Bills these ${sel.length} scattershots as a single unit (e.g. a railing).` : "Match the scattershot color patterns before grouping."}</div>
      </section>
      ` : ""}
      ${opts.showQuoteBinding ? `
      <section>
        <h3>Quote binding</h3>
        <label style="display:block;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Surface</label>
        <select id="sel-ma-surface" class="yardstick-select">
          <option value="">${sSurface.length > 1 ? "— mixed —" : "— none (untagged) —"}</option>
          <option value="bush" ${sSurface.length === 1 && sSurface[0] === "bush" ? "selected" : ""}>Bush</option>
          <option value="tree" ${sSurface.length === 1 && sSurface[0] === "tree" ? "selected" : ""}>Tree</option>
          <option value="column" ${sSurface.length === 1 && sSurface[0] === "column" ? "selected" : ""}>Column</option>
          <option value="railing" ${sSurface.length === 1 && sSurface[0] === "railing" ? "selected" : ""}>Railing</option>
        </select>
        ${sSurface.length === 1 && (sSurface[0] === "railing" || sSurface[0] === "column") ? "" : `
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Wrap style</label>
        <select id="sel-ma-wrapstyle" class="yardstick-select">
          <option value="canopy" ${sWrap.length === 1 && sWrap[0] === "canopy" ? "selected" : ""}>Canopy</option>
          <option value="trunk" ${sWrap.length === 1 && sWrap[0] === "trunk" ? "selected" : ""}>Trunk</option>
        </select>
        `}
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">String count</label>
        <input type="number" id="sel-ma-stringcount" class="yardstick-select" style="width:90px" min="1" step="1" value="${sCount.length === 1 ? sCount[0] : 1}" />
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px">
          <input type="checkbox" id="sel-ma-included" ${sInc.length === 1 && sInc[0] === false ? "" : "checked"} />
          <span>Included in quote</span>
        </label>
      </section>
      ` : ""}
      <section style="display:flex;gap:6px">
        <button id="sel-ma-duplicate">Duplicate</button>
        <button id="sel-ma-delete" class="danger">Delete</button>
      </section>
    `;

    const updateMiniAreas = (mut: (a: MiniAreaItem) => MiniAreaItem) => {
      scene = { ...scene, items: scene.items.map((i) => (isMiniArea(i) && selectedIds.has(i.id) ? mut(i) : i)) };
      scheduleSave();
      commit();
      redrawScene();
    };
    const updateMiniAreaColors = (mut: (pattern: string[]) => string[]) => {
      const next = updateSelectedColorPatterns(scene, selectedIds, mut);
      if (next !== scene) {
        scene = next;
        scheduleSave();
        commit();
      }
      redrawScene();
    };

    sb.querySelector("#sel-select-all-miniareas")?.addEventListener("click", () => {
      const ids = selectableMiniAreas.map((area) => area.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });

    const dInput = sb.querySelector("#sel-ma-density") as HTMLInputElement | null;
    const dLabel = sb.querySelector("#sel-ma-density-val") as HTMLElement | null;
    dInput?.addEventListener("input", () => {
      const v = Number(dInput.value);
      if (dLabel) dLabel.textContent = `${Math.round(v * 100)}%`;
      scene = { ...scene, items: scene.items.map((i) => (isMiniArea(i) && selectedIds.has(i.id) ? { ...i, density: v } : i)) };
      scheduleSave();
      requestCanvasRedraw();
    });
    dInput?.addEventListener("change", () => commit());

    // Color pattern. A plain tap recolors the whole pattern (quick single-color
    // change). "+ Add to pattern" ARMS the next tap to append instead — so
    // building red+green is: tap red → Add → tap green.
    sb.querySelectorAll("#sel-ma-colors button").forEach((b) =>
      b.addEventListener("click", () => {
        const id = (b as HTMLElement).dataset.c!;
        if (maAddArmed) {
          maAddArmed = false;
          updateMiniAreaColors((pattern) => [...pattern, id]);
        } else {
          updateMiniAreaColors(() => [id]);
        }
      }),
    );
    sb.querySelector("#sel-ma-add-color")?.addEventListener("click", () => {
      maAddArmed = !maAddArmed;
      renderSidebar();
    });
    sb.querySelector("#sel-ma-clear-pattern")?.addEventListener("click", () => {
      maAddArmed = false;
      updateMiniAreaColors((pattern) => [pattern[0] ?? "warm-white"]);
    });
    sb.querySelector("#sel-ma-multi")?.addEventListener("click", () => {
      maAddArmed = false;
      const all = COLORS.map((c) => c.id);
      updateMiniAreaColors(() => all);
    });
    sb.querySelectorAll("#sel-ma-pattern .swatch button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const i = Number(((btn as HTMLElement).parentElement as HTMLElement).dataset.i);
        updateMiniAreaColors((pattern) => {
          const next = pattern.filter((_, idx) => idx !== i);
          return next.length > 0 ? next : ["warm-white"];
        });
      });
    });

    if (opts.showQuoteBinding) {
      const surf = sb.querySelector("#sel-ma-surface") as HTMLSelectElement | null;
      surf?.addEventListener("change", () => {
        const v = surf.value;
        updateMiniAreas((a) => ({ ...a, surface: v ? (v as Surface) : null }));
      });
      const wrap = sb.querySelector("#sel-ma-wrapstyle") as HTMLSelectElement | null;
      wrap?.addEventListener("change", () => {
        updateMiniAreas((a) => ({ ...a, wrapStyle: wrap.value as WrapStyle }));
      });
      const sc = sb.querySelector("#sel-ma-stringcount") as HTMLInputElement | null;
      sc?.addEventListener("change", () => {
        const n = Math.max(1, Math.round(Number(sc.value) || 1));
        updateMiniAreas((a) => ({ ...a, stringCount: n }));
      });
      const inc = sb.querySelector("#sel-ma-included") as HTMLInputElement | null;
      inc?.addEventListener("change", () => {
        updateMiniAreas((a) => ({ ...a, included: inc.checked }));
      });
    }

    sb.querySelector("#sel-group-mini-area")?.addEventListener("click", () => {
      groupSelectedMini(sel, sel[0].surface ?? "bush", seedGroupStringCount(sel, sel[0].stringCount ?? 1));
    });

    sb.querySelector("#sel-ma-duplicate")?.addEventListener("click", () => {
      const dupes = sel.map((a) => ({
        ...a,
        id: cryptoId(),
        // #240: a duplicate is a NEW item, not a member of the source's group
        // — mirrors the strand panel's duplicate handler. Without this, the
        // copy would inherit a stale groupId pointing at a group it isn't
        // actually a member of, and silently stop billing (projectScene skips
        // any grouped item).
        groupId: undefined,
        ...(a.shape === "polygon" && a.points
          ? { points: a.points.map((p) => p + 20) }
          : { x: (a.x ?? 0) + 20, y: (a.y ?? 0) + 20 }),
      }));
      scene = { ...scene, items: [...scene.items, ...dupes] };
      selectedIds = new Set(dupes.map((a) => a.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    sb.querySelector("#sel-ma-delete")?.addEventListener("click", deleteSelected);
  }

  // Group the selected (mini, ungrouped) strands and/or scattershots into ONE
  // billed unit: a MiniGroupItem owning the billed attrs; members get groupId
  // and are skipped by the quote's own per-item projection (#240: a group can
  // mix strand + miniArea members, not just strands). A `function` (not a
  // `const`) so it's hoisted — every sidebar panel that offers "Group as one
  // quote unit" (strand-only, scattershot-only, mixed) calls this same one.
  // #334: every call site seeds `stringCount` via miniGroupBilling's
  // seedGroupStringCount(members, fallback), passing ITS OWN pre-existing
  // fallback (members[0].stringCount for the three "Group as one quote unit"
  // buttons; sel.length for the railing/curtain dropdown above — these are
  // NOT harmonised on purpose). seedGroupStringCount sums the members' own
  // counts ONLY when at least one member carries an explicit count above 1;
  // otherwise it returns the caller's fallback unchanged. This is conditional,
  // not unconditional summing: a prod sweep found 84% of grouped members sit
  // at the untouched default of 1 (staff trace N segments, group them, then
  // type the true count on the GROUP), so summing every time would silently
  // OVER-bill the common case. The minority case this exists for is row 334's
  // actual bug — a member with a real explicit count (e.g. a 4-string
  // scattershot) grouped alongside members at the default, previously seeding
  // just the first member's count instead of preserving the explicit one.
  function groupSelectedMini(members: (StrandItem | MiniAreaItem)[], surface: Surface, stringCount: number) {
    // #227 FIX 2 belt-and-braces: every call site already filters to
    // isMiniGroupable (which excludes linkedToId), but guard here too
    // (mirrors the projectScene defensive re-guard for the same bug) so a
    // future caller can't reintroduce the stale-autosave resurrection bug
    // described above the surfSel handler.
    if (members.some((m) => m.linkedToId)) return;
    const memberIds = members.map((m) => m.id);
    const groupId = cryptoId();
    const grp: MiniGroupItem = {
      id: groupId,
      kind: "miniGroup",
      memberIds,
      yardstickId: null,
      surface,
      wrapStyle: members[0].wrapStyle ?? "canopy",
      stringCount,
      included: true,
    };
    const next = createMiniGroup(scene, stampPhoto(grp));
    if (next === scene) return;
    scene = next;
    scheduleSave();
    commit();
    redrawScene();
  }

  // ============================================================
  // Sidebar — edit panel for a mini-light GROUP (surfaced when the selection
  // represents one group, optionally plus eligible ungrouped minis to add).
  // The group is geometry-less; its members still render/move individually.
  // ============================================================
  function renderSelectedMiniGroupSidebar(
    sb: HTMLElement,
    group: MiniGroupItem,
    addableMembers: (StrandItem | MiniAreaItem)[] = [],
  ) {
    const sSurface = group.surface ?? "";
    const sWrap = group.wrapStyle ?? "canopy";
    const sCount = group.stringCount ?? 1;
    const inc = group.included ?? true;
    // #240: member-kind-accurate copy — a group can now hold strands,
    // scattershots, or a mix of both. Resolve the live members (not just the
    // id count) so the label always matches what's actually in the group.
    const liveMembers = scene.items.filter(
      (i): i is StrandItem | MiniAreaItem =>
        group.memberIds.includes(i.id) &&
        (isStrand(i) || isMiniArea(i)) &&
        i.groupId === group.id,
    );
    const strandMembers = liveMembers.filter(isStrand);
    const strandCount = strandMembers.length;
    const areaCount = liveMembers.filter(isMiniArea).length;
    const sharedSpacing = uniq(strandMembers.map((strand) => strand.spacingIn));
    const memberPattern = (member: StrandItem | MiniAreaItem) =>
      member.colorPattern?.length ? member.colorPattern : ["warm-white"];
    const sharedPattern = uniq(liveMembers.map((member) => memberPattern(member).join(",")));
    const firstPattern = liveMembers.length > 0 ? memberPattern(liveMembers[0]) : [];
    const canAddMembers = !!group.colorPattern?.length || sharedPattern.length === 1;
    const memberLabel = (() => {
      const parts: string[] = [];
      if (strandCount) parts.push(`${strandCount} strand${strandCount === 1 ? "" : "s"}`);
      if (areaCount) parts.push(`${areaCount} scattershot${areaCount === 1 ? "" : "s"}`);
      // A #227 fully/partially orphaned group can have fewer live members than
      // memberIds (or none at all) — fall back to the raw id count so the
      // copy never reads "0 strands billed as one mini-light unit".
      return parts.length > 0 ? parts.join(" + ") : `${group.memberIds.length} member${group.memberIds.length === 1 ? "" : "s"}`;
    })();

    sb.innerHTML = `
      <section>
        <h3>Mini-light group</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          ${memberLabel} billed as one mini-light unit. Edit its appearance and billed attributes here, or ungroup to bill the members separately.
        </div>
        ${liveMembers.length > 0 && liveMembers.length !== sCount ? `
        <div style="margin-bottom:4px;font-size:11px;color:var(--warn)">
          Billed as ${sCount} string${sCount === 1 ? "" : "s"} across ${liveMembers.length} drawn item${liveMembers.length === 1 ? "" : "s"}. Adding or removing members never changes the billed number — set it in String count below.
        </div>` : ""}
        ${opts.showQuoteBinding && addableMembers.length === 0 ? `
        <div style="margin-bottom:4px;font-size:11px;color:var(--text-dim)">
          To add more items to this group, select the group and the ungrouped mini items together.
        </div>` : ""}
      </section>
      ${opts.showQuoteBinding && addableMembers.length > 0 ? `
      <section>
        <button id="sel-mg-add-members" style="width:100%" ${canAddMembers ? "" : "disabled"}>Add ${addableMembers.length} selected to group</button>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">${canAddMembers ? `Added items use this group's pattern. The billed string count stays at ${sCount}.` : "Choose one group color or pattern before adding to this mixed-color group."}</div>
      </section>
      ` : ""}
      ${strandMembers.length > 0 ? `
      <section>
        ${spacingRowHtml(false, SPACINGS.mini, sharedSpacing, "sel-mg-spacings")}
        ${areaCount > 0 ? `<div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Spacing applies to the ${strandCount} strand${strandCount === 1 ? "" : "s"}, not scattershots.</div>` : ""}
      </section>
      ` : ""}
      ${liveMembers.length > 0 ? `
      <section>
        <h3>Color${sharedPattern.length > 1 ? " (mixed)" : ""}</h3>
        <div class="colors" id="sel-mg-colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}"></button>`).join("")}
        </div>
        <div style="margin-top:8px;display:flex;gap:6px">
          <button id="sel-mg-add-color" class="${mgAddArmed ? "active" : ""}">${mgAddArmed ? "Tap a color to add…" : "+ Add to pattern"}</button>
          <button id="sel-mg-clear-pattern">Clear</button>
          <button id="sel-mg-multi" title="Set the pattern to every color in the palette">Multi</button>
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">
          Tap a color to recolor the group · "+ Add to pattern" then a color to extend the group's pattern.
        </div>
        ${sharedPattern.length === 1 ? `
        <div class="pattern-row" id="sel-mg-pattern">
          ${firstPattern.map((id, i) => {
            const c = COLORS.find((cc) => cc.id === id);
            return `<div class="swatch" data-i="${i}" style="background:${c?.hex ?? "#333"}"><button>×</button></div>`;
          }).join("")}
        </div>` : `
        <div style="margin-top:8px;color:var(--text-dim);font-size:11px">
          Patterns differ across the group. Tap a color to make them match, or use Multi for rainbow.
        </div>`}
      </section>
      ` : ""}
      ${opts.showQuoteBinding ? `
      <section>
        <h3>Quote binding</h3>
        <label style="display:block;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Surface</label>
        <select id="sel-mg-surface" class="yardstick-select">
          <option value="" ${sSurface === "" ? "selected" : ""}>— none (untagged) —</option>
          <option value="bush" ${sSurface === "bush" ? "selected" : ""}>Bush</option>
          <option value="tree" ${sSurface === "tree" ? "selected" : ""}>Tree</option>
          <option value="column" ${sSurface === "column" ? "selected" : ""}>Column</option>
          <option value="railing" ${sSurface === "railing" ? "selected" : ""}>Railing</option>
          <option value="curtain" ${sSurface === "curtain" ? "selected" : ""}>Curtain</option>
        </select>
        ${sSurface === "railing" || sSurface === "column" || sSurface === "curtain" ? "" : `
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Wrap style</label>
        <select id="sel-mg-wrapstyle" class="yardstick-select">
          <option value="canopy" ${sWrap === "canopy" ? "selected" : ""}>Canopy</option>
          <option value="trunk" ${sWrap === "trunk" ? "selected" : ""}>Trunk</option>
        </select>
        `}
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">String count</label>
        <input type="number" id="sel-mg-stringcount" class="yardstick-select" style="width:90px" min="1" step="1" value="${sCount}" />
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px">
          <input type="checkbox" id="sel-mg-included" ${inc === false ? "" : "checked"} />
          <span>Included in quote</span>
        </label>
      </section>
      ` : ""}
      <section>
        <button id="sel-mg-ungroup" style="width:100%">Ungroup</button>
      </section>
    `;

    const applySceneEdit = (next: Scene) => {
      if (next === scene) {
        redrawScene();
        return;
      }
      scene = next;
      scheduleSave();
      commit();
      redrawScene();
    };
    const updateGroup = (mut: (g: MiniGroupItem) => MiniGroupItem) => {
      applySceneEdit({ ...scene, items: scene.items.map((i) => (i.id === group.id && isMiniGroup(i) ? mut(i) : i)) });
    };

    sb.querySelector("#sel-mg-add-members")?.addEventListener("click", () => {
      applySceneEdit(addMiniGroupMembers(scene, group.id, addableMembers.map((member) => member.id)));
    });
    sb.querySelectorAll("#sel-mg-spacings button").forEach((button) =>
      button.addEventListener("click", () => {
        const spacingIn = Number((button as HTMLElement).dataset.s);
        applySceneEdit(setMiniGroupMemberSpacing(scene, group.id, spacingIn));
      }),
    );
    sb.querySelectorAll("#sel-mg-colors button").forEach((button) =>
      button.addEventListener("click", () => {
        const colorId = (button as HTMLElement).dataset.c!;
        if (mgAddArmed) {
          mgAddArmed = false;
          applySceneEdit(updateMiniGroupMemberColorPatterns(scene, group.id, (pattern) => [...pattern, colorId]));
        } else {
          applySceneEdit(updateMiniGroupMemberColorPatterns(scene, group.id, () => [colorId]));
        }
      }),
    );
    sb.querySelector("#sel-mg-add-color")?.addEventListener("click", () => {
      mgAddArmed = !mgAddArmed;
      renderSidebar();
    });
    sb.querySelector("#sel-mg-clear-pattern")?.addEventListener("click", () => {
      mgAddArmed = false;
      applySceneEdit(updateMiniGroupMemberColorPatterns(scene, group.id, (pattern) => [pattern[0] ?? "warm-white"]));
    });
    sb.querySelector("#sel-mg-multi")?.addEventListener("click", () => {
      mgAddArmed = false;
      applySceneEdit(updateMiniGroupMemberColorPatterns(scene, group.id, () => COLORS.map((color) => color.id)));
    });
    sb.querySelectorAll("#sel-mg-pattern .swatch button").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const index = Number(((button as HTMLElement).parentElement as HTMLElement).dataset.i);
        applySceneEdit(updateMiniGroupMemberColorPatterns(scene, group.id, (pattern) => {
          const next = pattern.filter((_, patternIndex) => patternIndex !== index);
          return next.length > 0 ? next : [pattern[0] ?? "warm-white"];
        }));
      });
    });

    if (opts.showQuoteBinding) {
      const surf = sb.querySelector("#sel-mg-surface") as HTMLSelectElement | null;
      surf?.addEventListener("change", () => {
        const v = surf.value;
        updateGroup((g) => ({ ...g, surface: v ? (v as Surface) : null }));
      });
      const wrap = sb.querySelector("#sel-mg-wrapstyle") as HTMLSelectElement | null;
      wrap?.addEventListener("change", () => updateGroup((g) => ({ ...g, wrapStyle: wrap.value as WrapStyle })));
      const sc = sb.querySelector("#sel-mg-stringcount") as HTMLInputElement | null;
      sc?.addEventListener("change", () => {
        const n = Math.max(1, Math.round(Number(sc.value) || 1));
        updateGroup((g) => ({ ...g, stringCount: n }));
      });
      const incCb = sb.querySelector("#sel-mg-included") as HTMLInputElement | null;
      incCb?.addEventListener("change", () => updateGroup((g) => ({ ...g, included: incCb.checked })));
    }

    sb.querySelector("#sel-mg-ungroup")?.addEventListener("click", () => {
      const memberIds = group.memberIds;
      scene = {
        ...scene,
        items: scene.items
          .filter((i) => i.id !== group.id)
          // #240: a member can be a strand OR a scattershot — clear groupId on
          // either kind (mirrors groupSelectedMini's own kind check).
          .map((i) => ((isStrand(i) || isMiniArea(i)) && memberIds.includes(i.id) ? { ...i, groupId: undefined } : i)),
      };
      selectedIds = new Set(memberIds); // keep members selected → the right panel returns
      scheduleSave();
      commit();
      redrawScene();
    });
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected text item(s)
  // ============================================================
  function renderSelectedTextSidebar(sb: HTMLElement, sel: TextItem[]) {
    const sharedText = uniq(sel.map((t) => t.text));
    const sharedFont = uniq(sel.map((t) => t.fontFamily));
    const sharedColor = uniq(sel.map((t) => t.colorId));
    const sharedOutline = uniq(sel.map((t) => t.outline ?? false));

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Text" : `Edit ${sel.length} Texts`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag corners to resize · drag rotation handle to rotate · drag body to move.
        </div>
      </section>
      ${(() => {
        const count = allTexts().length;
        return `<section><button id="sel-select-all-texts" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Texts (${count})
        </button></section>`;
      })()}
      <section>
        <h3>Text${sharedText.length > 1 ? " (mixed)" : ""}</h3>
        <input
          type="text"
          id="sel-text-content"
          value="${sharedText.length === 1 ? escapeAttr(sharedText[0]) : ""}"
          placeholder="${sharedText.length > 1 ? "(differs across selection — type to set all)" : "Type your text..."}"
          style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);box-sizing:border-box"
        />
      </section>
      <section>
        <h3>Font${sharedFont.length > 1 ? " (mixed)" : ""}</h3>
        <div class="bulb-types" id="sel-text-fonts" style="flex-wrap:wrap">
          ${FONT_OPTIONS.map((f) => `<button data-font="${f}" class="${sharedFont.length === 1 && sharedFont[0] === f ? "active" : ""}" style="font-family:'${f}',sans-serif;font-size:14px">${f}</button>`).join("")}
        </div>
      </section>
      <section>
        <h3>Color${sharedColor.length > 1 ? " (mixed)" : ""}</h3>
        <div class="colors" id="sel-text-colors">
          ${COLORS.map((c) => `<button data-c="${c.id}" title="${c.label}" style="background:${c.hex}" class="${sharedColor.length === 1 && sharedColor[0] === c.id ? "active" : ""}"></button>`).join("")}
        </div>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-text-outline" ${sharedOutline.length === 1 && sharedOutline[0] ? "checked" : ""} />
          <span>Outline${sharedOutline.length > 1 ? " (mixed)" : ""}</span>
        </label>
      </section>
      <section style="display:flex;gap:6px">
        <button id="sel-text-duplicate">Duplicate</button>
        <button id="sel-text-delete" class="danger">Delete</button>
      </section>
    `;

    const updateTexts = (mut: (t: TextItem) => TextItem) => {
      scene = {
        ...scene,
        items: scene.items.map((i) => (isText(i) && selectedIds.has(i.id) ? mut(i) : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };

    sb.querySelector("#sel-select-all-texts")?.addEventListener("click", () => {
      const ids = allTexts().map((t) => t.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });

    const ti = sb.querySelector("#sel-text-content") as HTMLInputElement | null;
    // Live-update text content on every keystroke for instant feedback, but
    // snapshot history only when the input commits (blur / change) so a typing
    // burst is one Undo step instead of dozens.
    ti?.addEventListener("input", () => {
      const v = ti.value;
      scene = {
        ...scene,
        items: scene.items.map((i) => (isText(i) && selectedIds.has(i.id) ? { ...i, text: v } : i)),
      };
      scheduleSave();
      requestCanvasRedraw();
    });
    ti?.addEventListener("change", () => {
      commit();
    });

    sb.querySelectorAll("#sel-text-fonts button").forEach((b) =>
      b.addEventListener("click", () => {
        const f = (b as HTMLElement).dataset.font as FontFamily;
        updateTexts((t) => ({ ...t, fontFamily: f }));
      }),
    );
    sb.querySelectorAll("#sel-text-colors button").forEach((b) =>
      b.addEventListener("click", () => {
        const c = (b as HTMLElement).dataset.c!;
        updateTexts((t) => ({ ...t, colorId: c }));
      }),
    );
    const ol = sb.querySelector("#sel-text-outline") as HTMLInputElement | null;
    ol?.addEventListener("change", () => {
      updateTexts((t) => ({ ...t, outline: ol.checked }));
    });

    sb.querySelector("#sel-text-duplicate")?.addEventListener("click", () => {
      const newTexts = sel.map((t) => ({ ...t, id: cryptoId(), x: t.x + 20, y: t.y + 20 }));
      scene = { ...scene, items: [...scene.items, ...newTexts] };
      selectedIds = new Set(newTexts.map((t) => t.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    sb.querySelector("#sel-text-delete")?.addEventListener("click", deleteSelected);
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected custom upload(s)
  // ============================================================
  function renderSelectedCustomSidebar(sb: HTMLElement, sel: CustomItem[]) {
    const sharedFlipH = uniq(sel.map((c) => c.flipH ?? false));
    const sharedFlipV = uniq(sel.map((c) => c.flipV ?? false));
    const sharedHalo = uniq(sel.map((c) => c.autoHalo ?? false));

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Custom" : `Edit ${sel.length} Customs`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag corners to resize · drag rotation handle to rotate · drag body to move.
        </div>
      </section>
      ${(() => {
        const count = allCustoms().length;
        return `<section><button id="sel-select-all-customs" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Customs (${count})
        </button></section>`;
      })()}
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-custom-flip-h" ${sharedFlipH.length === 1 && sharedFlipH[0] ? "checked" : ""} />
          <span>Flip horizontally${sharedFlipH.length > 1 ? " (mixed)" : ""}</span>
        </label>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-custom-flip-v" ${sharedFlipV.length === 1 && sharedFlipV[0] ? "checked" : ""} />
          <span>Flip vertically${sharedFlipV.length > 1 ? " (mixed)" : ""}</span>
        </label>
      </section>
      <section>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="sel-custom-halo" ${sharedHalo.length === 1 && sharedHalo[0] ? "checked" : ""} />
          <span>Glow${sharedHalo.length > 1 ? " (mixed)" : ""}</span>
        </label>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Adds a soft halo around bright pixels.</div>
      </section>
      <section style="display:flex;gap:6px">
        <button id="sel-custom-duplicate">Duplicate</button>
        <button id="sel-custom-delete" class="danger">Delete</button>
      </section>
    `;

    const updateCustoms = (mut: (c: CustomItem) => CustomItem) => {
      scene = {
        ...scene,
        items: scene.items.map((i) => (isCustom(i) && selectedIds.has(i.id) ? mut(i) : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };

    sb.querySelector("#sel-select-all-customs")?.addEventListener("click", () => {
      const ids = allCustoms().map((c) => c.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    const fh = sb.querySelector("#sel-custom-flip-h") as HTMLInputElement | null;
    fh?.addEventListener("change", () => {
      updateCustoms((c) => ({ ...c, flipH: fh.checked }));
    });
    const fv = sb.querySelector("#sel-custom-flip-v") as HTMLInputElement | null;
    fv?.addEventListener("change", () => {
      updateCustoms((c) => ({ ...c, flipV: fv.checked }));
    });
    const halo = sb.querySelector("#sel-custom-halo") as HTMLInputElement | null;
    halo?.addEventListener("change", () => {
      updateCustoms((c) => ({ ...c, autoHalo: halo.checked }));
    });

    sb.querySelector("#sel-custom-duplicate")?.addEventListener("click", () => {
      const newCustoms = sel.map((c) => ({ ...c, id: cryptoId(), x: c.x + 20, y: c.y + 20 }));
      scene = { ...scene, items: [...scene.items, ...newCustoms] };
      selectedIds = new Set(newCustoms.map((c) => c.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    sb.querySelector("#sel-custom-delete")?.addEventListener("click", deleteSelected);
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected pole(s)
  // ============================================================
  function renderSelectedPoleSidebar(sb: HTMLElement, sel: PoleItem[]) {
    const sharedBase = uniq(sel.map((p) => p.baseType));
    const sharedHeight = uniq(sel.map((p) => p.heightIn));

    sb.innerHTML = `
      <section>
        <h3>${sel.length === 1 ? "Edit Pole" : `Edit ${sel.length} Poles`}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag body to move base · drag the top handle up/down to change height.
        </div>
      </section>
      ${(() => {
        const count = allPoles().length;
        return `<section><button id="sel-select-all-poles" style="width:100%" ${count === 0 ? "disabled" : ""}>
          Select All Poles (${count})
        </button></section>`;
      })()}
      <section>
        <h3>Base Type${sharedBase.length > 1 ? " (mixed)" : ""}</h3>
        <div class="bulb-types" id="sel-pole-base-types">
          <button data-base="none" class="${sharedBase.length === 1 && sharedBase[0] === "none" ? "active" : ""}">None</button>
          <button data-base="cube" class="${sharedBase.length === 1 && sharedBase[0] === "cube" ? "active" : ""}">Cube</button>
          <button data-base="barrel" class="${sharedBase.length === 1 && sharedBase[0] === "barrel" ? "active" : ""}">Barrel</button>
        </div>
      </section>
      <section>
        <h3>Height${sharedHeight.length > 1 ? " (mixed)" : offPresetSizeSuffix(POLE_HEIGHTS, sharedHeight, "ft")}</h3>
        <div class="spacing-row" id="sel-pole-heights">
          ${sizeButtons(POLE_HEIGHTS, sharedHeight, "data-h", "ft")}
        </div>
      </section>
      <section style="display:flex;gap:6px">
        <button id="sel-pole-duplicate">Duplicate</button>
        <button id="sel-pole-delete" class="danger">Delete</button>
      </section>
    `;

    const updatePoles = (mut: (p: PoleItem) => PoleItem) => {
      scene = {
        ...scene,
        items: scene.items.map((i) => (isPole(i) && selectedIds.has(i.id) ? mut(i) : i)),
      };
      scheduleSave();
      commit();
      redrawScene();
    };

    sb.querySelector("#sel-select-all-poles")?.addEventListener("click", () => {
      const ids = allPoles().map((p) => p.id);
      if (ids.length === 0) return;
      selectedIds = new Set(ids);
      selectedYardstickId = null;
      redrawScene();
    });
    sb.querySelectorAll("#sel-pole-base-types button").forEach((b) =>
      b.addEventListener("click", () => {
        const v = (b as HTMLElement).dataset.base as PoleBaseType;
        updatePoles((p) => ({ ...p, baseType: v }));
      }),
    );
    sb.querySelectorAll("#sel-pole-heights button").forEach((b) =>
      b.addEventListener("click", () => {
        const v = Number((b as HTMLElement).dataset.h);
        updatePoles((p) => ({ ...p, heightIn: v }));
      }),
    );
    sb.querySelector("#sel-pole-duplicate")?.addEventListener("click", () => {
      const newPoles = sel.map((p) => ({ ...p, id: cryptoId(), x: p.x + 20, y: p.y + 20 }));
      scene = { ...scene, items: [...scene.items, ...newPoles] };
      selectedIds = new Set(newPoles.map((p) => p.id));
      scheduleSave();
      commit();
      redrawScene();
    });
    sb.querySelector("#sel-pole-delete")?.addEventListener("click", deleteSelected);
  }

  function uniq<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
  }
  function avg(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  // ============================================================
  // Sidebar — edit panel for the currently selected yardstick
  // ============================================================
  function renderYardstickSidebar(sb: HTMLElement) {
    const ys = scene.yardsticks.find((y) => y.id === selectedYardstickId);
    if (!ys) {
      selectedYardstickId = null;
      renderSidebar();
      return;
    }
    const idx = scene.yardsticks.findIndex((y) => y.id === ys.id);
    const label = yardstickLabel(idx);
    const ppf = pxPerFoot(ys);
    const axis = ys.axis === "height" ? "height" : "width";
    const measuredPx = axis === "height" ? ys.height : ys.width;
    const otherAxis = axis === "height" ? "width" : "height";
    const otherPx = otherAxis === "height" ? ys.height : ys.width;
    const stranded = allStrands().filter((s) => (yardstickForStrand(s)?.id ?? null) === ys.id);
    const otherYardsticks = scene.yardsticks.filter((y) => y.id !== ys.id);

    sb.innerHTML = `
      <section>
        <h3>Edit ${label}</h3>
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:4px">
          Drag the rectangle to move it. Drag the handles to resize it. Or set the feet value below.
        </div>
      </section>
      <section>
        <h3>Real-world length <span style="float:right;color:var(--text);font-weight:400">${ys.realFeet} ft</span></h3>
        <input type="number" id="ys-feet" min="0.5" step="0.5" value="${ys.realFeet}" />
        <div style="margin-top:6px;font-size:12px;color:var(--text-dim)">
          Drag a real-world feature on the photo (door width, garage height, downspout) and enter its true length here.
        </div>
      </section>
      <section>
        <h3>Measured along <span style="float:right;color:var(--text);font-weight:400">${axis} · ${Math.round(measuredPx)} px</span></h3>
        <button id="ys-flip-axis" style="width:100%">Use ${otherAxis} instead (${Math.round(otherPx)} px)</button>
        <div style="margin-top:6px;font-size:12px;color:var(--text-dim)">
          The ${ys.realFeet} ft is mapped to the box's <strong>${axis}</strong>. If you measured the other side, flip this so the scale is right.
        </div>
      </section>
      <section>
        <h3>Scale</h3>
        <div style="font-family:monospace;font-size:13px">
          <strong>${ppf.toFixed(1)} px/ft</strong>
          <span style="color:var(--text-dim)"> · ${Math.round(ys.width)}×${Math.round(ys.height)} px</span>
        </div>
      </section>
      <section>
        <h3>Strands using this</h3>
        <div style="font-size:13px">
          <strong>${stranded.length}</strong> strand${stranded.length === 1 ? "" : "s"}
        </div>
      </section>
      <section style="display:flex;gap:6px">
        <button id="ys-delete" class="danger">Delete</button>
      </section>
    `;

    const feetInput = sb.querySelector("#ys-feet") as HTMLInputElement;
    feetInput.addEventListener("input", () => {
      const v = Number(feetInput.value);
      if (!v || v <= 0) return;
      scene = {
        ...scene,
        yardsticks: scene.yardsticks.map((y) => (y.id === ys.id ? { ...y, realFeet: v } : y)),
      };
      scheduleSave();
      requestCanvasRedraw();
    });
    feetInput.addEventListener("change", () => {
      commit();
      renderSidebar(); // update the panel header/labels
    });

    sb.querySelector("#ys-flip-axis")!.addEventListener("click", () => {
      // Swap which drawn side `realFeet` measures. Rescales everything tied to
      // this yardstick (strands/garlands read px/ft through pxPerFoot).
      scene = {
        ...scene,
        yardsticks: scene.yardsticks.map((y) =>
          y.id === ys.id ? { ...y, axis: otherAxis } : y,
        ),
      };
      scheduleSave();
      commit();
      requestCanvasRedraw();
      renderSidebar();
    });

    sb.querySelector("#ys-delete")!.addEventListener("click", () => {
      handleYardstickDelete(ys.id, stranded.map((s) => s.id), otherYardsticks);
    });
  }

  function handleYardstickDelete(
    ysId: string,
    strandIds: string[],
    otherYardsticks: Yardstick[],
  ) {
    if (strandIds.length === 0) {
      // No strands tied to it → just delete.
      scene = { ...scene, yardsticks: scene.yardsticks.filter((y) => y.id !== ysId) };
      selectedYardstickId = null;
      scheduleSave();
      commit();
      redrawScene();
      return;
    }
    if (otherYardsticks.length === 0) {
      // No other yardstick to reassign to → must confirm deleting strands too.
      const ok = confirm(
        `Deleting this yardstick will delete ${strandIds.length} strand${strandIds.length === 1 ? "" : "s"} too (no other yardstick to fall back to). Continue?`,
      );
      if (!ok) return;
      // #227: prune a miniGroup left with zero surviving members by this delete.
      scene = {
        ...scene,
        yardsticks: scene.yardsticks.filter((y) => y.id !== ysId),
        items: pruneOrphanedMiniGroupsNotify(scene.items.filter((s) => !strandIds.includes(s.id))),
      };
      selectedYardstickId = null;
      scheduleSave();
      commit();
      redrawScene();
      return;
    }
    // Other yardsticks exist → ask whether to reassign or delete the strands.
    openYardstickDeleteModal(ysId, strandIds, otherYardsticks);
  }

  function openYardstickDeleteModal(
    ysId: string,
    strandIds: string[],
    otherYardsticks: Yardstick[],
  ) {
    if (document.querySelector(".modal-bg")) return;
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    const ysIdx = scene.yardsticks.findIndex((y) => y.id === ysId);
    bg.innerHTML = `
      <div class="modal">
        <h2>Delete ${yardstickLabel(ysIdx)}?</h2>
        <div style="color:var(--text-dim);font-size:13px">
          ${strandIds.length} strand${strandIds.length === 1 ? "" : "s"} use this yardstick.
          What should happen to them?
        </div>
        <div>
          <label>Reassign to</label>
          <select id="ys-reassign">
            ${otherYardsticks.map((y) => {
              const i = scene.yardsticks.findIndex((yy) => yy.id === y.id);
              return `<option value="${y.id}">${yardstickLabel(i)} — ${y.realFeet} ft</option>`;
            }).join("")}
          </select>
        </div>
        <div class="actions" style="justify-content:space-between">
          <button id="ys-modal-delete-strands" class="danger">Delete strands too</button>
          <div style="display:flex;gap:8px">
            <button id="ys-modal-cancel">Cancel</button>
            <button id="ys-modal-reassign" class="primary">Reassign &amp; delete</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(bg);
    bg.addEventListener("click", (e) => { if (e.target === bg) bg.remove(); });
    bg.querySelector("#ys-modal-cancel")!.addEventListener("click", () => bg.remove());
    bg.querySelector("#ys-modal-reassign")!.addEventListener("click", () => {
      const newYsId = (bg.querySelector("#ys-reassign") as HTMLSelectElement).value;
      scene = {
        ...scene,
        yardsticks: scene.yardsticks.filter((y) => y.id !== ysId),
        items: scene.items.map((s) =>
          strandIds.includes(s.id) ? { ...s, yardstickId: newYsId } : s,
        ),
      };
      selectedYardstickId = null;
      scheduleSave();
      commit();
      bg.remove();
      redrawScene();
    });
    bg.querySelector("#ys-modal-delete-strands")!.addEventListener("click", () => {
      // #227: prune a miniGroup left with zero surviving members by this delete.
      scene = {
        ...scene,
        yardsticks: scene.yardsticks.filter((y) => y.id !== ysId),
        items: pruneOrphanedMiniGroupsNotify(scene.items.filter((s) => !strandIds.includes(s.id))),
      };
      selectedYardstickId = null;
      scheduleSave();
      commit();
      bg.remove();
      redrawScene();
    });
  }

  // --- Topbar ---
  (root.querySelector("#back") as HTMLElement).addEventListener("click", () => {
    if (opts.onBack) opts.onBack();
    else window.location.hash = "#/";
  });
  (root.querySelector("#undo-btn") as HTMLElement).addEventListener("click", undo);
  (root.querySelector("#redo-btn") as HTMLElement).addEventListener("click", redo);
  (root.querySelector("#settings-btn") as HTMLElement).addEventListener("click", () => {
    window.location.hash = "#/settings";
  });

  function setToolMode(m: ToolMode) {
    if (toolMode === m) return;
    toolMode = m;
    cancelInProgress();
    (root.querySelector("#tool-draw") as HTMLElement).classList.toggle("active", m === "draw");
    (root.querySelector("#tool-select") as HTMLElement).classList.toggle("active", m === "select");
    stage.container().style.cursor = m === "select" ? "crosshair" : "";
    // #63: the item draggable flag depends on draw-vs-select mode — refresh it so
    // it's current before the next canvas gesture.
    redrawScene();
  }
  (root.querySelector("#tool-draw") as HTMLElement).addEventListener("click", () => setToolMode("draw"));
  (root.querySelector("#tool-select") as HTMLElement).addEventListener("click", () => setToolMode("select"));
  const nameInput = root.querySelector("#name") as HTMLInputElement;
  nameInput.value = design.name;
  nameInput.addEventListener("input", () => {
    design.name = nameInput.value || "Untitled";
    scheduleSave();
  });

  (root.querySelector("#ys-btn") as HTMLElement).addEventListener("click", () => {
    // #13: measurement lives on the base photo — no yardsticks on extras.
    if (activePhotoId) {
      alert("Yardsticks live on the main photo — switch to Photo 1 to measure.");
      return;
    }
    if (!bgImageNode) {
      alert("Upload a photo first.");
      return;
    }
    const ftStr = prompt("How many real-world feet is the LONGER side of the rectangle you're about to draw? Drag it ALONG the feature you're measuring — wide for a door/garage width, tall for a downspout or garage-door height. (e.g. a door width = 3, a garage-door height = 7)");
    if (!ftStr) return;
    const ft = Number(ftStr);
    if (!ft || ft <= 0) return;
    cancelInProgress();
    creatingYardstick = true;
    pendingYsFeet = ft;
    stage.container().style.cursor = "crosshair";
  });

  (root.querySelector("#dl-btn") as HTMLElement).addEventListener("click", () => {
    if (!bgImageNode) {
      alert("Nothing to download yet.");
      return;
    }
    downloadStage(stage, bgImageNode, design.name);
  });

  // --- Zoom controls ---
  const zoomResetBtn = root.querySelector("#zoom-reset-btn") as HTMLElement;
  const updateZoomLabel = () => {
    zoomResetBtn.textContent = `${Math.round(userZoom * 100)}%`;
  };
  root.querySelector("#zoom-in-btn")!.addEventListener("click", () => {
    zoomAt(stageWrap.clientWidth / 2, stageWrap.clientHeight / 2, 1.25);
    updateZoomLabel();
  });
  root.querySelector("#zoom-out-btn")!.addEventListener("click", () => {
    zoomAt(stageWrap.clientWidth / 2, stageWrap.clientHeight / 2, 0.8);
    updateZoomLabel();
  });
  zoomResetBtn.addEventListener("click", () => {
    resetZoom();
    updateZoomLabel();
  });

  // ctrl+wheel zoom centered on cursor
  stageWrap.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = stageWrap.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      zoomAt(sx, sy, e.deltaY < 0 ? 1.15 : 0.87);
      updateZoomLabel();
    },
    { passive: false },
  );

  // Space + drag to pan. Named handlers so they can be removed in destroy()
  // — critical when the editor is embedded in the project page and torn
  // down/remounted on every design-tab switch (anonymous listeners would
  // stack and fire multiple times).
  let spaceDown = false;
  let panDragStart: { x: number; y: number; baseX: number; baseY: number } | null = null;
  const onWindowKeyDownPan = (e: KeyboardEvent) => {
    if (e.code === "Space" && !spaceDown && document.activeElement?.tagName !== "INPUT") {
      spaceDown = true;
      stage.container().style.cursor = "grab";
      e.preventDefault();
    }
  };
  const onWindowKeyUpPan = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      spaceDown = false;
      stage.container().style.cursor = "";
    }
  };
  const onWindowMouseMovePan = (e: MouseEvent) => {
    if (!panDragStart) return;
    panOffset.x = panDragStart.baseX + (e.clientX - panDragStart.x);
    panOffset.y = panDragStart.baseY + (e.clientY - panDragStart.y);
    applyTransform();
  };
  const onWindowMouseUpPan = () => {
    if (panDragStart) {
      panDragStart = null;
      stage.container().style.cursor = spaceDown ? "grab" : "";
    }
  };
  window.addEventListener("keydown", onWindowKeyDownPan);
  window.addEventListener("keyup", onWindowKeyUpPan);
  stage.on("mousedown", (e) => {
    // Middle-mouse-button OR space+left-button → pan
    if (e.evt.button === 1 || (spaceDown && e.evt.button === 0)) {
      panDragStart = {
        x: e.evt.clientX,
        y: e.evt.clientY,
        baseX: panOffset.x,
        baseY: panOffset.y,
      };
      stage.container().style.cursor = "grabbing";
      e.evt.preventDefault();
    }
  });
  window.addEventListener("mousemove", onWindowMouseMovePan);
  window.addEventListener("mouseup", onWindowMouseUpPan);

  // --- Brightness slider ---
  const brightnessEl = root.querySelector("#brightness") as HTMLInputElement;
  brightnessEl.value = String(brightnessForPhoto(scene, activePhotoId));
  brightnessEl.addEventListener("input", () => {
    scene = setBrightnessForPhoto(scene, extraPhotoIds, activePhotoId, Number(brightnessEl.value));
    drawTint();
    scheduleSave();
  });
  // Snapshot for undo only once the user releases the slider.
  brightnessEl.addEventListener("change", () => {
    commit();
  });
  // Double-click resets to neutral (50) — the original photo brightness.
  brightnessEl.addEventListener("dblclick", () => {
    brightnessEl.value = "50";
    scene = setBrightnessForPhoto(scene, extraPhotoIds, activePhotoId, 50);
    drawTint();
    scheduleSave();
    commit();
  });

  // --- Light-size slider ---
  // Same shape as brightness above, with one difference: brightness only
  // repaints the tint layer, while light size changes the drawn items, so
  // this redraws the canvas instead. requestCanvasRedraw is rAF-throttled, so
  // dragging costs one rebuild per frame rather than one per input event.
  const lightScaleEl = root.querySelector("#light-scale") as HTMLInputElement;
  const lightScaleValEl = root.querySelector("#light-scale-val") as HTMLElement;
  function showLightScale(v: number) {
    lightScaleEl.value = String(v);
    lightScaleValEl.textContent = `${v.toFixed(1)}x`;
  }
  function applyLightScale(value: number) {
    const v = normalizeLightScale(value);
    scene = { ...scene, lightScale: v };
    showLightScale(v);
    requestCanvasRedraw();
    scheduleSave();
  }
  // Seed the control from the saved scene WITHOUT saving or redrawing: this
  // runs on every open, and calling applyLightScale here would dirty the
  // design (and queue an autosave) just because someone looked at it.
  showLightScale(normalizeLightScale(scene.lightScale));
  lightScaleEl.addEventListener("input", () => {
    applyLightScale(Number(lightScaleEl.value));
  });
  // Snapshot for undo only once the user releases the slider, so a drag is one
  // undo step and not fifty.
  lightScaleEl.addEventListener("change", () => {
    commit();
  });
  // Double-click resets to 1.0x — lights drawn at their real-world size.
  lightScaleEl.addEventListener("dblclick", () => {
    applyLightScale(1);
    commit();
  });

  // --- Photo upload ---
  const upBtn = root.querySelector("#upload-btn") as HTMLElement;
  const upFile = root.querySelector("#upload-file") as HTMLInputElement;
  upBtn?.addEventListener("click", () => upFile.click());
  upFile?.addEventListener("change", async () => {
    const file = upFile.files?.[0];
    if (!file) return;
    const { path, url } = await api.uploadPhoto(file);
    const img = await loadHTMLImage(url);
    await api.updateDesign(design.id, { photoPath: path, photoW: img.naturalWidth, photoH: img.naturalHeight });
    design.photoUrl = url;
    design.photoW = img.naturalWidth;
    design.photoH = img.naturalHeight;
    (root.querySelector("#empty") as HTMLElement).style.display = "none";
    await loadPhoto(url, img.naturalWidth, img.naturalHeight);
    redrawScene();
  });

  // ============================================================
  // Drawing interaction
  // ============================================================

  function newPreview(pts: number[]) {
    drawPreview?.destroy();
    drawPreview = new Konva.Line({
      points: pts,
      stroke: previewColor(),
      strokeWidth: Math.max(1.5, 0.05 * pxPerFoot(activeYs())),
      lineCap: "round",
      lineJoin: "round",
      opacity: 0.65,
      dash: [6, 4],
      listening: false,
    });
    drawLayer.add(drawPreview);
  }

  function previewColor(): string {
    const c = COLORS.find((cc) => cc.id === tool.colorPattern[0]);
    return c?.hex ?? "#ffffff";
  }

  function commitWreath(p: { x: number; y: number }) {
    const wreath: WreathItem = {
      id: cryptoId(),
      kind: "wreath",
      x: p.x,
      y: p.y,
      sizeIn: tool.wreathSizeIn,
      withLights: tool.wreathWithLights,
      withBow: tool.wreathWithBow,
      yardstickId: activeYs()?.id ?? null,
      quoteSize: "36noble",
      tier: "bow",
      included: true,
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(wreath)] };
    scheduleSave();
    commit();
  }

  function commitBow(p: { x: number; y: number }) {
    const bow: BowItem = {
      id: cryptoId(),
      kind: "bow",
      x: p.x,
      y: p.y,
      sizeIn: tool.bowSizeIn,
      yardstickId: activeYs()?.id ?? null,
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(bow)] };
    scheduleSave();
    commit();
  }

  function commitSpritzer(p: { x: number; y: number }) {
    const spritzer: SpritzerItem = {
      id: cryptoId(),
      kind: "spritzer",
      x: p.x,
      y: p.y,
      sizeIn: tool.spritzerSizeIn,
      colorPattern: [...tool.spritzerColorPattern],
      yardstickId: activeYs()?.id ?? null,
      quoteSize: "24",
      included: true,
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(spritzer)] };
    scheduleSave();
    commit();
  }

  // Commit a scattershot box drawn via drag (Lights → Scattershot style).
  // #249: scattershot only exists for bulbType "mini" (see the Drawing Style
  // section), so tool.surface here is always either "" or a valid mini
  // surface — falls back to the pre-existing "bush" default when untagged.
  // #753 review fix: never "curtain" specifically — the pre-draw row filters
  // it out (and resets it) the moment Scattershot is active, because
  // #sel-ma-surface (this item's own edit panel, below) has no curtain
  // option to show/correct it with.
  function commitMiniArea(r: { x: number; y: number; width: number; height: number }) {
    const area: MiniAreaItem = {
      id: cryptoId(),
      kind: "miniArea",
      shape: "box",
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      density: 0.5,
      colorPattern: [...tool.colorPattern],
      yardstickId: activeYs()?.id ?? null,
      surface: tool.surface || "bush",
      wrapStyle: "canopy",
      stringCount: 1,
      included: true,
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(area)] };
    selectedIds = new Set([area.id]);
    scheduleSave();
    commit();
  }

  function commitText(p: { x: number; y: number }) {
    const item: TextItem = {
      id: cryptoId(),
      kind: "text",
      x: p.x,
      y: p.y,
      text: tool.textContent || "Text",
      fontFamily: tool.textFont,
      sizeIn: DEFAULT_TEXT_SIZE_IN,
      colorId: tool.textColorId,
      outline: tool.textOutline,
      yardstickId: activeYs()?.id ?? null,
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(item)] };
    scheduleSave();
    commit();
  }

  function commitCustom(p: { x: number; y: number }) {
    if (!tool.customActiveUploadPath) return; // no graphic armed
    const item: CustomItem = {
      id: cryptoId(),
      kind: "custom",
      x: p.x,
      y: p.y,
      imagePath: tool.customActiveUploadPath,
      widthIn: DEFAULT_CUSTOM_WIDTH_IN,
      autoHalo: tool.customAutoHalo,
      yardstickId: activeYs()?.id ?? null,
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(item)] };
    scheduleSave();
    commit();
  }

  function commitPole(p: { x: number; y: number }) {
    const pole: PoleItem = {
      id: cryptoId(),
      kind: "pole",
      x: p.x,
      y: p.y,
      heightIn: tool.poleHeightIn,
      baseType: tool.poleBaseType,
      yardstickId: activeYs()?.id ?? null,
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(pole)] };
    scheduleSave();
    commit();
  }

  function commitStrand(points: number[]) {
    if (points.length < 4) return; // need at least 2 distinct points
    const strand: StrandItem = {
      id: cryptoId(),
      kind: "strand",
      bulbType: tool.bulbType,
      spacingIn: tool.spacingIn,
      drawingStyle: tool.drawingStyle,
      colorPattern: [...tool.colorPattern],
      points: [...points],
      yardstickId: activeYs()?.id ?? null,
      ...permPropsForNewStrand(),
      ...quoteDefaultsForNewStrand(),
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(strand)] };
    scheduleSave();
    commit();
  }

  // Only include perm-specific props on perm-light strands so other types
  // don't carry meaningless data. Bistro adds its own sagFactor.
  function permPropsForNewStrand(): Partial<Strand> {
    if (tool.bulbType === "bistro") {
      return { sagFactor: tool.bistroSagFactor };
    }
    if (tool.bulbType !== "permanent") return {};
    return {
      beamLengthFt: tool.beamLengthFt,
      beamWidthFt: tool.beamWidthFt,
      distanceToSurfaceFt: tool.distanceToSurfaceFt,
      opacity: tool.opacity,
      showCoverage: tool.showCoverage,
      showBeam: tool.showBeam,
    };
  }

  // Quote-binding defaults baked onto newly-created items so the quote can
  // project them out of the box. #249: `surface` comes from the pre-draw
  // quick-tag (tool.surface) when the operator set one; otherwise the item is
  // untagged, same as before this feature (the operator sets `surface`
  // post-hoc via the #sel-surface dropdown). Harmless in the standalone tool —
  // ignored unless a quote reads them. `sideOfHouse` mirrors the same pattern,
  // permanent bulb type only (tool.sideOfHouse only ever holds a value while
  // tool.bulbType === "permanent" — see resetToolSideOfHouseIfInvalid).
  // #249 review fix (provenance): a strand tagged HERE (the sticky pre-draw
  // default) also gets `sideOfHouseAuto = true` — it bills/displays/toggles
  // exactly like a deliberate tag, but training-example capture
  // (trainingExamples.ts extractFinalStreetRuns) excludes auto tags from AI
  // ground truth until a human confirms them via the #sel-side-of-house
  // dropdown (which clears the flag). RELAY: mirror to the standalone design
  // tool alongside the sideOfHouseAuto field itself.
  function quoteDefaultsForNewStrand(): Partial<StrandItem> {
    const d: Partial<StrandItem> = { included: true };
    if (tool.bulbType === "mini") { d.stringCount = 1; d.wrapStyle = "canopy"; }
    if (tool.surface) d.surface = tool.surface;
    if (tool.bulbType === "permanent" && tool.sideOfHouse) {
      d.sideOfHouse = tool.sideOfHouse;
      d.sideOfHouseAuto = true;
    }
    return d;
  }
  function quoteDefaultsForNewGarland(): Partial<GarlandItem> {
    return { included: true, quoteLength: "9ft", quoteSections: 1, tier: "fullDecor" };
  }

  // Creates one strand per straight segment from a polyline (used by Trace mode so
  // each click→click line is its own editable strand). One history entry covers
  // all of them so a single Undo removes the whole trace.
  function commitTraceSegments(polyline: number[]) {
    const newStrands: StrandItem[] = [];
    for (let i = 0; i + 4 <= polyline.length; i += 2) {
      const seg = polyline.slice(i, i + 4);
      // Reject zero-length segments (consecutive clicks at the same spot).
      if (Math.hypot(seg[2] - seg[0], seg[3] - seg[1]) < 4) continue;
      newStrands.push({
        id: cryptoId(),
        kind: "strand",
        bulbType: tool.bulbType,
        spacingIn: tool.spacingIn,
        drawingStyle: "trace",
        colorPattern: [...tool.colorPattern],
        points: seg,
        yardstickId: activeYs()?.id ?? null,
        ...permPropsForNewStrand(),
        ...quoteDefaultsForNewStrand(),
      });
    }
    if (newStrands.length === 0) return;
    scene = { ...scene, items: [...scene.items, ...newStrands.map((s) => stampPhoto(s))] };
    scheduleSave();
    commit();
  }

  function commitSingle(p: { x: number; y: number }) {
    const strand: StrandItem = {
      id: cryptoId(),
      kind: "strand",
      bulbType: tool.bulbType,
      spacingIn: tool.spacingIn,
      drawingStyle: "single",
      colorPattern: [...tool.colorPattern],
      points: [p.x, p.y],
      yardstickId: activeYs()?.id ?? null,
      ...permPropsForNewStrand(),
      ...quoteDefaultsForNewStrand(),
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(strand)] };
    scheduleSave();
    commit();
  }

  // ===== Garland commits =====
  // Garland is a strand-like polyline. Same UX as strand drawing: Strand mode
  // makes a single straight piece, Trace splits into per-segment pieces (so
  // each click→click is independently editable), Single drops one stamp.
  function commitGarland(points: number[]) {
    if (points.length < 4) return;
    const g: GarlandItem = {
      id: cryptoId(),
      kind: "garland",
      drawingStyle: "strand",
      withLights: tool.garlandWithLights,
      sizeIn: tool.garlandSizeIn,
      points: [...points],
      yardstickId: activeYs()?.id ?? null,
      ...quoteDefaultsForNewGarland(),
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(g)] };
    scheduleSave();
    commit();
  }

  function commitGarlandSingle(p: { x: number; y: number }) {
    const g: GarlandItem = {
      id: cryptoId(),
      kind: "garland",
      drawingStyle: "single",
      withLights: tool.garlandWithLights,
      sizeIn: tool.garlandSizeIn,
      points: [p.x, p.y],
      yardstickId: activeYs()?.id ?? null,
      ...quoteDefaultsForNewGarland(),
    };
    scene = { ...scene, items: [...scene.items, stampPhoto(g)] };
    scheduleSave();
    commit();
  }

  // Split a Trace polyline into one GarlandItem per click→click segment so
  // each piece is independently selectable / movable / deletable — mirrors
  // strand commitTraceSegments. One commit() snapshot covers the whole batch
  // so a single Undo removes the entire trace.
  function commitGarlandTraceSegments(polyline: number[]) {
    const newGarlands: GarlandItem[] = [];
    for (let i = 0; i + 4 <= polyline.length; i += 2) {
      const seg = polyline.slice(i, i + 4);
      if (Math.hypot(seg[2] - seg[0], seg[3] - seg[1]) < 4) continue;
      newGarlands.push({
        id: cryptoId(),
        kind: "garland",
        drawingStyle: "trace",
        withLights: tool.garlandWithLights,
        sizeIn: tool.garlandSizeIn,
        points: seg,
        yardstickId: activeYs()?.id ?? null,
        ...quoteDefaultsForNewGarland(),
      });
    }
    if (newGarlands.length === 0) return;
    // #13 fix: trace-mode garland was the one commit path without the photo
    // stamp — drawn on an extra photo, the segments landed on the BASE photo.
    scene = { ...scene, items: [...scene.items, ...newGarlands.map((g) => stampPhoto(g))] };
    scheduleSave();
    commit();
  }

  // True when the current draw context is for garland. Garland lives under
  // Decor in the sidebar but draws like a strand (Strand/Trace/Single styles).
  function drawingGarland(): boolean {
    return tool.category === "decor" && tool.decorType === "garland";
  }

  // #63: true when the active gesture is a click-drag "strand" draw (lights
  // non-bistro, or garland). In this context a press that starts on an existing
  // item draws THROUGH it on a drag, or selects it on a click without a drag — so
  // items render non-draggable (no move, no drag ever arms) and the per-item
  // select-guards are bypassed. Read live; the tool-change handlers redrawScene()
  // so the draggable flag this gates stays fresh across tool switches.
  function isStrandDrawContext(): boolean {
    return isLineDrawContext(
      {
        toolMode,
        drawingStyle: tool.drawingStyle,
        scattershot: tool.scattershot,
        category: tool.category,
        bulbType: tool.bulbType,
        decorType: tool.decorType,
      },
      "strand",
    );
  }

  // #203: mirrors isStrandDrawContext() (#63) for the "trace" style, via the
  // same isLineDrawContext() gate (see drawContext.ts for why the two
  // deliberately share one function instead of two copies that could drift
  // apart again). Used ONLY at the mousedown per-item-guard site below, to
  // let the very FIRST click of a fresh trace fall through into the
  // trace-start pipeline when it lands on an existing strand/garland/
  // miniArea — trace's own pre-existing `!tracePts` exception already
  // covers every click AFTER the first (continuing an in-progress trace);
  // this closes the gap for the first one, where tracePts is still null.
  // Deliberately NOT wired into isStrandDrawContext()'s other call sites
  // (draggable(false), the item click-handler bypass, the drawOverItemId /
  // mouseup drag-distance decision) — those implement strand's click-vs-
  // drag disambiguation, which doesn't fit trace's multi-click accumulation
  // model (traced through: routing trace over drawOverItemId would fire
  // selectDrawOverItem() and an unconditional redrawScene() on mouseup,
  // destroying the live trace preview node and mis-selecting the traced-
  // over item mid-gesture).
  function isTraceDrawContext(): boolean {
    return isLineDrawContext(
      {
        toolMode,
        drawingStyle: tool.drawingStyle,
        scattershot: tool.scattershot,
        category: tool.category,
        bulbType: tool.bulbType,
        decorType: tool.decorType,
      },
      "trace",
    );
  }

  // #63: select the item a strand-draw click (no real drag) landed on — the
  // deferred half of the draw-vs-select decision. Mirrors the item click
  // handler's additive logic. Caller resets drawOverItemId + redraws.
  function selectDrawOverItem(native: MouseEvent) {
    if (!drawOverItemId) return;
    const additive = !!(native && (native.shiftKey || native.metaKey || native.ctrlKey));
    selectedYardstickId = null;
    if (!additive) selectedIds.clear();
    if (additive && selectedIds.has(drawOverItemId)) selectedIds.delete(drawOverItemId);
    else selectedIds.add(drawOverItemId);
  }

  function cancelInProgress() {
    dragPts = null;
    tracePts = null;
    drawOverItemId = null;
    drawPreview?.destroy();
    drawPreview = null;
    if (scattershotStart) {
      scattershotStart = null;
      drawLayer.find(".scattershot-preview").forEach((n) => n.destroy());
    }
    if (creatingYardstick) {
      drawLayer.find(".ys-preview").forEach((n) => n.destroy());
      ysDragStart = null;
      creatingYardstick = false;
      stage.container().style.cursor = toolMode === "select" ? "crosshair" : "";
    }
    // #13: disarm a pending stamp (Escape / tool change).
    if (stampSourceId) {
      stampSourceId = null;
      stage.container().style.cursor = toolMode === "select" ? "crosshair" : "";
    }
    if (marqueeStart) {
      marqueeStart = null;
      marqueePreview?.destroy();
      marqueePreview = null;
    }
    drawLayer.batchDraw();
  }

  function finishTrace() {
    if (!tracePts) return;
    // Drop the trailing cursor-tracking point (it's a duplicate of the last committed point
    // updated on mousemove). Keep all committed clicks.
    const committed = tracePts.slice(0, -2);
    if (drawingGarland()) {
      // Per-segment: each click→click becomes its own GarlandItem so they're
      // independently editable. One Undo still removes the whole trace.
      commitGarlandTraceSegments(committed);
    } else {
      // Split the polyline so each click→click segment becomes its own strand,
      // making them independently editable (move/resize/recolor/etc.).
      commitTraceSegments(committed);
    }
    tracePts = null;
    drawPreview?.destroy();
    drawPreview = null;
    redrawScene();
  }

  stage.on("mousedown touchstart", (e) => {
    if (!bgImageNode) return;
    if (panDragStart) return; // pan in progress
    if (spaceDown) return;

    // Yardstick creation mode: drag a rect.
    if (creatingYardstick) {
      const p = imagePoint();
      if (!p) return;
      ysDragStart = p;
      return;
    }

    // Click on an existing yardstick (to drag it) — don't start drawing.
    if (e.target.findAncestor(".yardstick", true)) return;

    // #63 Option A: in strand-draw mode, a gesture that starts on an existing item
    // draws THROUGH it (on a drag) or selects it (on a click without a drag). We
    // record the item under the cursor and fall through to the draw pipeline; the
    // select-vs-draw decision is deferred to mouseup. In every other mode the
    // per-item guards below bail so the item's own click handler selects it.
    drawOverItemId = null;
    if (isStrandDrawContext()) {
      const overItem =
        e.target.findAncestor(".strand", true) ||
        e.target.findAncestor(".garland", true) ||
        e.target.findAncestor(".miniArea", true) ||
        e.target.findAncestor(".wreath", true) ||
        e.target.findAncestor(".bow", true) ||
        e.target.findAncestor(".spritzer", true) ||
        e.target.findAncestor(".pole", true) ||
        e.target.findAncestor(".text", true) ||
        e.target.findAncestor(".custom", true);
      if (overItem) drawOverItemId = (overItem.getAttr("itemId") as string | undefined) ?? null;
      // fall through to the draw pipeline below (skip the per-item return-guards).
    } else {
      // Click on a strand group — selection handler runs; suppress draw. EXCEPT
      // when a trace polyline is in progress: that click must continue the
      // trace. #203: OR when a fresh trace is about to START on top of it —
      // mirrors the same exception for the very first click, which used to be
      // swallowed here because tracePts is still null at that instant (the
      // pre-existing !tracePts exception only ever covered clicks AFTER the
      // first one).
      if (e.target.findAncestor(".strand", true) && !tracePts && !isTraceDrawContext()) return;

      // Click on an existing wreath — let its click handler select it; don't draw.
      if (e.target.findAncestor(".wreath", true)) return;

      // Click on an existing bow — same deal.
      if (e.target.findAncestor(".bow", true)) return;

      // Click on an existing garland — let its click handler select it; don't draw.
      // (Exception while a trace is in progress, or about to start — #203 — same
      // as for strands.)
      if (e.target.findAncestor(".garland", true) && !tracePts && !isTraceDrawContext()) return;

      // Click on an existing spritzer — same deal as wreath/bow.
      if (e.target.findAncestor(".spritzer", true)) return;

      // Click on an existing mini-light area — let its click handler select it;
      // don't fall through to the place/draw pipeline (which would drop a
      // duplicate box and destroy the pressed group mid-gesture). Same trace
      // exception as strands/garlands (continuing OR about to start — #203):
      // mid-trace clicks continue the polyline.
      if (e.target.findAncestor(".miniArea", true) && !tracePts && !isTraceDrawContext()) return;

      // Click on an existing text item — same.
      if (e.target.findAncestor(".text", true)) return;

      // Click on an existing custom-upload item — same.
      if (e.target.findAncestor(".custom", true)) return;

      // Click on an existing pole — normally bails out so the pole gets
      // selected. EXCEPTION: in bistro draw mode the user is connecting
      // poles with light spans, so clicks on poles must fall through to the
      // strand-drawing pipeline (and the start point of the span will be
      // wherever they clicked on the pole).
      const drawingBistroNow =
        tool.category === "lights" && tool.bulbType === "bistro" && toolMode === "draw";
      if (e.target.findAncestor(".pole", true) && !drawingBistroNow) return;
    }

    // Click on either Transformer (anchor handles) — suppress draw.
    if (e.target.findAncestor("Transformer", true)) return;

    // #13: an armed "Place on this photo" stamp consumes this click — place a
    // linked twin of the source at the click point, select it, disarm.
    if (stampSourceId) {
      const p = imagePoint();
      if (!p || !inPhoto(p)) return;
      const src = scene.items.find((i) => i.id === stampSourceId);
      stampSourceId = null;
      stage.container().style.cursor = toolMode === "select" ? "crosshair" : "";
      if (src) {
        const twin = makeTwinAt(src, p);
        scene = { ...scene, items: [...scene.items, twin] };
        selectedIds = new Set([twin.id]);
        scheduleSave();
        commit();
        redrawScene();
      }
      return;
    }

    // Select-tool mode: drag a marquee rectangle, filtered by current bulb type.
    if (toolMode === "select") {
      const p = imagePoint();
      if (!p || !inPhoto(p)) return;
      marqueeStart = p;
      marqueePreview?.destroy();
      marqueePreview = new Konva.Rect({
        x: p.x, y: p.y, width: 0, height: 0,
        stroke: "#4f8cff", strokeWidth: 2, dash: [6, 4],
        fill: "rgba(79,140,255,0.12)",
        listening: false,
        name: "marquee",
      });
      drawLayer.add(marqueePreview);
      drawLayer.batchDraw();
      return;
    }

    // Click on the empty photo background → deselect any current selection.
    // (#63: but NOT when a strand-draw gesture started on top of an item — that
    // must begin the draw, not get swallowed by a deselect.)
    if ((selectedIds.size > 0 || selectedYardstickId) && !drawOverItemId) {
      clearSelection();
      return;
    }

    const p = imagePoint();
    if (!p || !inPhoto(p)) return;

    // Decor: wreath/bow/spritzer place on a single click. Garland falls
    // through to the strand-like drawing pipeline below (Strand/Trace/Single).
    if (tool.category === "decor" && tool.decorType !== "garland") {
      if (tool.decorType === "wreath") commitWreath(p);
      else if (tool.decorType === "bow") commitBow(p);
      else if (tool.decorType === "spritzer") commitSpritzer(p);
      redrawScene();
      return;
    }

    // Text: single click places a text item at the cursor.
    if (tool.category === "text") {
      commitText(p);
      redrawScene();
      return;
    }

    // Custom: single click places the currently-armed library graphic. If
    // no graphic is armed yet, do nothing — the sidebar hint already nudges
    // the user to pick one from the library first.
    if (tool.category === "custom") {
      if (!tool.customActiveUploadPath) return;
      commitCustom(p);
      redrawScene();
      return;
    }

    // Poles: single click places a pole at the cursor (base on the ground).
    if (tool.category === "poles") {
      commitPole(p);
      redrawScene();
      return;
    }

    // Scattershot (lights-only local style): drag a box that fills with
    // scattered mini-lights on release. Preview drawn on mousemove.
    if (tool.scattershot) {
      scattershotStart = p;
      return;
    }

    if (tool.drawingStyle === "single") {
      if (drawingGarland()) commitGarlandSingle(p);
      else commitSingle(p);
      redrawScene();
      return;
    }

    if (tool.drawingStyle === "trace") {
      if (!tracePts) {
        // First click: start the polyline. Last pair tracks the cursor.
        tracePts = [p.x, p.y, p.x, p.y];
        newPreview(tracePts);
      } else {
        // Subsequent click: lock the current cursor pair as a committed point,
        // then add a new cursor-tracking pair on top.
        tracePts[tracePts.length - 2] = p.x;
        tracePts[tracePts.length - 1] = p.y;
        tracePts.push(p.x, p.y);
        drawPreview?.points([...tracePts]);
      }
      drawLayer.batchDraw();
      return;
    }

    // "strand" mode — click-drag straight line.
    dragPts = [p.x, p.y, p.x, p.y];
    newPreview(dragPts);
  });

  stage.on("mousemove touchmove", () => {
    // Track the cursor in image-space so Ctrl+V can paste at "where the mouse is".
    const cursor = imagePoint();
    if (cursor && inPhoto(cursor)) lastImgPoint = cursor;

    if (marqueeStart && marqueePreview) {
      const p = imagePoint();
      if (!p) return;
      const x = Math.min(p.x, marqueeStart.x);
      const y = Math.min(p.y, marqueeStart.y);
      const w = Math.abs(p.x - marqueeStart.x);
      const h = Math.abs(p.y - marqueeStart.y);
      marqueePreview.setAttrs({ x, y, width: w, height: h });
      drawLayer.batchDraw();
      return;
    }
    if (creatingYardstick && ysDragStart) {
      const p = imagePoint();
      if (!p) return;
      const w = Math.abs(p.x - ysDragStart.x);
      const h = Math.abs(p.y - ysDragStart.y);
      const x = Math.min(p.x, ysDragStart.x);
      const y = Math.min(p.y, ysDragStart.y);
      drawLayer.find(".ys-preview").forEach((n) => n.destroy());
      const preview = new Konva.Rect({
        x, y, width: w, height: h,
        stroke: "#4f8cff", strokeWidth: 2, dash: [6, 4],
        fill: "rgba(79,140,255,0.1)",
        listening: false,
        name: "ys-preview",
      });
      drawLayer.add(preview);
      drawLayer.batchDraw();
      return;
    }
    if (scattershotStart) {
      const p = imagePoint();
      if (!p) return;
      drawLayer.find(".scattershot-preview").forEach((n) => n.destroy());
      const preview = new Konva.Rect({
        x: Math.min(p.x, scattershotStart.x),
        y: Math.min(p.y, scattershotStart.y),
        width: Math.abs(p.x - scattershotStart.x),
        height: Math.abs(p.y - scattershotStart.y),
        stroke: "#4f8cff", strokeWidth: 2, dash: [6, 4],
        fill: "rgba(79,140,255,0.08)",
        listening: false,
        name: "scattershot-preview",
      });
      drawLayer.add(preview);
      drawLayer.batchDraw();
      return;
    }

    const p = imagePoint();
    if (!p) return;

    if (tool.drawingStyle === "trace" && tracePts) {
      tracePts[tracePts.length - 2] = p.x;
      tracePts[tracePts.length - 1] = p.y;
      drawPreview?.points([...tracePts]);
      drawLayer.batchDraw();
      return;
    }

    if (tool.drawingStyle === "strand" && dragPts) {
      dragPts[dragPts.length - 2] = p.x;
      dragPts[dragPts.length - 1] = p.y;
      drawPreview?.points([...dragPts]);
      drawLayer.batchDraw();
    }
  });

  stage.on("mouseup touchend", (e) => {
    if (marqueeStart && marqueePreview) {
      const p = imagePoint();
      if (p) {
        const x1 = Math.min(p.x, marqueeStart.x);
        const y1 = Math.min(p.y, marqueeStart.y);
        const x2 = Math.max(p.x, marqueeStart.x);
        const y2 = Math.max(p.y, marqueeStart.y);
        if (x2 - x1 > 3 && y2 - y1 > 3) {
          selectMatchingInRect(x1, y1, x2, y2);
        } else {
          // Treat tiny marquee as a click on empty bg → deselect.
          clearSelection();
        }
      }
      marqueePreview.destroy();
      marqueePreview = null;
      marqueeStart = null;
      drawLayer.batchDraw();
      return;
    }
    if (creatingYardstick && ysDragStart) {
      const p = imagePoint();
      if (p) {
        const w = Math.abs(p.x - ysDragStart.x);
        const h = Math.abs(p.y - ysDragStart.y);
        if (w > 8 && h > 4) {
          const ys: Yardstick = {
            id: cryptoId(),
            realFeet: pendingYsFeet,
            x: Math.min(p.x, ysDragStart.x),
            y: Math.min(p.y, ysDragStart.y),
            width: w,
            height: h,
            // Measure along the LONGER drawn side — the operator drags the box
            // ALONG the feature they're measuring, so the long axis is the one
            // `realFeet` describes. Operator can flip this in the sidebar if the
            // reference was the shorter side (e.g. a wide-but-short box whose
            // entered width is the short side). Ties default to width.
            axis: h > w ? "height" : "width",
          };
          scene = { ...scene, yardsticks: [...scene.yardsticks, ys] };
          activeYardstickId = ys.id;
          scheduleSave();
          commit();
        }
      }
      drawLayer.find(".ys-preview").forEach((n) => n.destroy());
      ysDragStart = null;
      creatingYardstick = false;
      stage.container().style.cursor = "";
      redrawScene();
      return;
    }

    if (scattershotStart) {
      const p = imagePoint();
      if (p) {
        const x = Math.min(p.x, scattershotStart.x);
        const y = Math.min(p.y, scattershotStart.y);
        const w = Math.abs(p.x - scattershotStart.x);
        const h = Math.abs(p.y - scattershotStart.y);
        // Reject tiny boxes as accidental clicks (same spirit as strand's 6px).
        if (w > 8 && h > 8) commitMiniArea({ x, y, width: w, height: h });
      }
      drawLayer.find(".scattershot-preview").forEach((n) => n.destroy());
      scattershotStart = null;
      redrawScene();
      return;
    }

    if (tool.drawingStyle === "strand" && dragPts) {
      // Reject too-short drags as accidental clicks.
      const dx = dragPts[2] - dragPts[0];
      const dy = dragPts[3] - dragPts[1];
      if (Math.hypot(dx, dy) >= 6) {
        if (drawingGarland()) commitGarland(dragPts);
        else commitStrand(dragPts);
      } else if (drawOverItemId) {
        // #63 Option A: a click without a real drag that started on an existing
        // item selects that item (the deferred select-vs-draw decision), instead
        // of committing a zero-length strand.
        selectDrawOverItem(e.evt as MouseEvent);
      }
      dragPts = null;
      drawPreview?.destroy();
      drawPreview = null;
      drawOverItemId = null;
      redrawScene();
    } else if (drawOverItemId) {
      // #63: a strand-draw press started on an item but no drag ever armed — e.g.
      // the press landed on the item's overhang OUTSIDE the photo bounds, so the
      // mousedown inPhoto guard returned before dragPts was set. Still honor it as
      // a click-select of that item (it would have selected pre-#63).
      selectDrawOverItem(e.evt as MouseEvent);
      drawOverItemId = null;
      redrawScene();
    }
  });

  // Trace mode: leaving the photo finishes the polyline.
  stage.on("mouseleave", () => {
    if (tool.drawingStyle === "trace") finishTrace();
  });
  // Double-click also finishes (extra safety / convention).
  stage.on("dblclick", () => {
    if (tool.drawingStyle === "trace") finishTrace();
  });

  // Keyboard:
  //   Esc / Enter while tracing → commit the polyline.
  //   Esc otherwise → clear selection or cancel in-progress action.
  //   Delete / Backspace → delete selected strands.
  const keyHandler = (e: KeyboardEvent) => {
    // Ignore keystrokes that target form inputs (the design title field, etc).
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // Enter while tracing commits the polyline — a fixed contextual behavior,
    // NOT remappable. Everything else dispatches through the configurable keymap
    // (#98): pass no override and DEFAULT_KEYMAP reproduces the original
    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+C / Ctrl+V / Delete / Esc set.
    if (e.key === "Enter" && tool.drawingStyle === "trace" && tracePts) {
      finishTrace();
      return;
    }
    const action = resolveAction(e, opts.keymap ?? DEFAULT_KEYMAP, "core");
    if (!action) return;
    switch (action) {
      case "undo":
        e.preventDefault();
        undo();
        break;
      case "redo":
        e.preventDefault();
        redo();
        break;
      case "copy":
        if (selectedIds.size === 0) return; // let the browser handle (e.g. nothing to copy)
        copySelectedToClipboard();
        e.preventDefault();
        break;
      case "paste":
        if (clipboard.length === 0) return;
        pasteFromClipboard();
        e.preventDefault();
        break;
      case "duplicate": {
        if (selectedIds.size === 0) return;
        // Clone the selection in place without clobbering the user's clipboard.
        const savedClipboard = clipboard;
        copySelectedToClipboard();
        pasteFromClipboard();
        clipboard = savedClipboard;
        e.preventDefault();
        break;
      }
      case "delete":
        if (selectedIds.size === 0) return;
        deleteSelected();
        e.preventDefault();
        break;
      case "cancel":
        // Esc: finish an in-progress trace, else clear selection, else cancel.
        // (No preventDefault — matches the original Esc behavior.)
        if (tool.drawingStyle === "trace" && tracePts) {
          finishTrace();
        } else if (stampSourceId) {
          cancelInProgress();
        } else if (selectedIds.size > 0) {
          clearSelection();
        } else {
          cancelInProgress();
        }
        break;
      case "toggleDrawSelect":
        setToolMode(toolMode === "draw" ? "select" : "draw");
        e.preventDefault();
        break;
    }
  };
  window.addEventListener("keydown", keyHandler);

  // --- Resize ---
  function refit() {
    if (bgImageNode) fitStage(bgImageNode.width(), bgImageNode.height());
    else stage.size({ width: stageWrap.clientWidth, height: stageWrap.clientHeight });
    drawLayer.batchDraw();
    bgLayer.batchDraw();
    tintLayer.batchDraw();
  }
  const ro = new ResizeObserver(refit);
  ro.observe(stageWrap);
  // Some embed hosts (e.g. the quote tool's React shell full-screen toggle)
  // resize the editor without delivering ResizeObserver notifications, so also
  // refit on window resize. Removed in destroy().
  window.addEventListener("resize", refit);

  // --- Teardown ---
  // Standalone (#/editor/:id): self-destroys on hashchange, same as before.
  // Embedded (project page): the caller owns lifecycle and calls the returned
  // destroy() on tab switch / navigate-away. Every window listener, the
  // ResizeObserver, the save timer, and the Konva stage are released so
  // repeatedly mounting the editor (one mount per design tab) doesn't leak.
  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener("keydown", keyHandler);
    window.removeEventListener("hashchange", onHash);
    window.removeEventListener("keydown", onWindowKeyDownPan);
    window.removeEventListener("keyup", onWindowKeyUpPan);
    window.removeEventListener("mousemove", onWindowMouseMovePan);
    window.removeEventListener("mouseup", onWindowMouseUpPan);
    ro.disconnect();
    window.removeEventListener("resize", refit);
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    // AUDIT FIX (editor-autosave-honest-failure): destroy() runs on
    // hashchange/unmount (NOT beforeunload), so the flush can still complete
    // async — but if it rejects we must not drop it silently with an unhandled
    // rejection. Persist a marker so the next mount of this design warns the
    // user; the next successful save clears it.
    flushSave().catch(() => {
      try { localStorage.setItem("editorUnsavedDesign", design.id); } catch { /* storage unavailable */ }
    });
    if (redrawHandle) { cancelAnimationFrame(redrawHandle); redrawHandle = 0; }
    try { stage.destroy(); } catch { /* already gone */ }
  }
  function onHash() {
    if (!opts.embedded) destroy();
  }
  window.addEventListener("hashchange", onHash);

  // Re-apply the saved defaults for whatever item type is currently active.
  // Called at init and again every time the user picks a different category
  // or sub-type in the draw sidebar — so each type's "feel" follows Settings.
  function applyDefaultsForCurrentType() {
    if (tool.category === "decor" && tool.decorType === "garland") {
      const entry = savedDefaults?.["garland"];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.sizeIn === "number") tool.garlandSizeIn = entry.sizeIn;
      if (typeof entry.withLights === "boolean") tool.garlandWithLights = entry.withLights;
      if (typeof entry.drawingStyle === "string") {
        const ds = entry.drawingStyle;
        if (ds === "strand" || ds === "trace" || ds === "single") tool.drawingStyle = ds;
      }
      return;
    }
    if (tool.category === "lights") {
      const entry = savedDefaults?.[tool.bulbType];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.spacingIn === "number") tool.spacingIn = entry.spacingIn;
      // #88: a stale saved spacing (e.g. a legacy 6"/12" permanent default from
      // before the 8"-only lockdown) must not escape the type's allow-list —
      // clamp to SPACINGS, mirroring the bulb-type click handler. For permanent
      // (SPACINGS = [8]) this forces 8" on-center regardless of stored settings.
      const allowedSpacings = SPACINGS[tool.bulbType];
      if (!allowedSpacings.includes(tool.spacingIn)) {
        tool.spacingIn = allowedSpacings[Math.floor(allowedSpacings.length / 2)] ?? allowedSpacings[0];
      }
      if (typeof entry.drawingStyle === "string") {
        const ds = entry.drawingStyle;
        if (ds === "strand" || ds === "trace" || ds === "single") tool.drawingStyle = ds;
      }
      if (Array.isArray(entry.colorPattern) && entry.colorPattern.length > 0) {
        const cp = entry.colorPattern.filter((c): c is string => typeof c === "string");
        if (cp.length > 0) {
          tool.colorPattern = cp;
          tool.pickerColorId = cp[0];
        }
      }
      if (typeof entry.beamLengthFt === "number") tool.beamLengthFt = entry.beamLengthFt;
      if (typeof entry.beamWidthFt === "number") tool.beamWidthFt = entry.beamWidthFt;
      if (typeof entry.distanceToSurfaceFt === "number") tool.distanceToSurfaceFt = entry.distanceToSurfaceFt;
      if (typeof entry.opacity === "number") tool.opacity = entry.opacity;
      if (typeof entry.showCoverage === "boolean") tool.showCoverage = entry.showCoverage;
      if (typeof entry.showBeam === "boolean") tool.showBeam = entry.showBeam;
      if (typeof entry.sagFactor === "number") tool.bistroSagFactor = entry.sagFactor;
    } else if (tool.category === "decor" && tool.decorType === "wreath") {
      const entry = savedDefaults?.["wreath"];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.sizeIn === "number") tool.wreathSizeIn = entry.sizeIn;
      if (typeof entry.withLights === "boolean") tool.wreathWithLights = entry.withLights;
      if (typeof entry.withBow === "boolean") tool.wreathWithBow = entry.withBow;
      if (Array.isArray(entry.colorPattern) && entry.colorPattern.length > 0) {
        const first = entry.colorPattern[0];
        if (typeof first === "string") tool.wreathColorId = first;
      }
    } else if (tool.category === "decor" && tool.decorType === "bow") {
      const entry = savedDefaults?.["bow"];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.sizeIn === "number") tool.bowSizeIn = entry.sizeIn;
    } else if (tool.category === "decor" && tool.decorType === "spritzer") {
      const entry = savedDefaults?.["spritzer"];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.sizeIn === "number") tool.spritzerSizeIn = entry.sizeIn;
      if (Array.isArray(entry.colorPattern) && entry.colorPattern.length > 0) {
        const cp = entry.colorPattern.filter((c): c is string => typeof c === "string");
        if (cp.length > 0) {
          tool.spritzerColorPattern = cp;
          tool.spritzerPickerColorId = cp[0];
        }
      }
    } else if (tool.category === "text") {
      const entry = savedDefaults?.["text"];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.fontFamily === "string" && FONT_OPTIONS.includes(entry.fontFamily as FontFamily)) {
        tool.textFont = entry.fontFamily as FontFamily;
      }
      if (Array.isArray(entry.colorPattern) && entry.colorPattern.length > 0 && typeof entry.colorPattern[0] === "string") {
        tool.textColorId = entry.colorPattern[0];
      }
      if (typeof entry.outline === "boolean") tool.textOutline = entry.outline;
    } else if (tool.category === "custom") {
      const entry = savedDefaults?.["custom"];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.autoHalo === "boolean") tool.customAutoHalo = entry.autoHalo;
    } else if (tool.category === "poles") {
      const entry = savedDefaults?.["pole"];
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.heightIn === "number") tool.poleHeightIn = entry.heightIn;
      if (entry.baseType === "none" || entry.baseType === "cube" || entry.baseType === "barrel") {
        tool.poleBaseType = entry.baseType;
      }
    }
  }

  // --- Init ---
  // Load the live color palette + per-type defaults from the server.
  // Both fall back silently to the hard-coded factory values if the fetch fails.
  try {
    const [colors, defaultsRes] = await Promise.all([
      api.getColors(),
      api.getDefaults(),
    ]);
    if (Array.isArray(colors) && colors.length > 0) setPalette(colors);
    savedDefaults = defaultsRes ?? {};
    applyDefaultsForCurrentType();
  } catch {
    // Stay on the static defaults if the fetch fails.
  }
  // Kick off image-asset preload (wreath, etc). Doesn't block — the renderer
  // shows a placeholder if the user places one before the file finishes loading.
  preloadAssets().then(() => requestCanvasRedraw());
  // Same idea for the Google-Fonts-hosted text fonts: if a TextItem renders
  // before its font has arrived, it falls back to a serif. Once the browser
  // signals fonts ready, redraw so the right typeface shows up.
  fontsReady().then(() => requestCanvasRedraw());
  // #13: mount on the active photo's image — an extra when activePhotoId is
  // set, else the base photo as always.
  if (activeExtra?.url && activeExtra.w && activeExtra.h) {
    await loadPhoto(activeExtra.url, activeExtra.w, activeExtra.h);
  } else if (!activePhotoId && design.photoUrl && design.photoW && design.photoH) {
    await loadPhoto(design.photoUrl, design.photoW, design.photoH);
  }
  redrawScene();
  // AUDIT FIX (editor-autosave-honest-failure): warn if a prior teardown flush
  // for THIS design may not have persisted (marker set in destroy()).
  showUnsavedBannerIfNeeded();

  const handle = destroy as EditorHandle;
  handle.flushSave = flushSave;
  handle.discardPending = discardPending;
  handle.removePhotoItems = removePhotoItems;
  return handle;
}
export type EditorHandle = (() => void) & {
  flushSave?: () => Promise<void>;
  discardPending?: () => boolean;
  removePhotoItems?: (photoId: string, serverVersion?: number | null) => void;
};

function loadHTMLImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

function cryptoId(): string {
  return (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12);
}

// Escape a string for safe insertion into an HTML attribute value (handles
// quotes, ampersands, angle brackets). Used by the text item's input field.
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function downloadStage(stage: Konva.Stage, bgImg: Konva.Image, name: string) {
  // Hide yardsticks so they don't end up in the exported image — they're tool UI, not design.
  const yardsticks = stage.find(".yardstick");
  const wasVisible = yardsticks.map((n) => n.visible());
  yardsticks.forEach((n) => n.visible(false));

  try {
    const w = bgImg.width();
    const h = bgImg.height();
    const bgLayer = stage.getLayers()[0];
    const dataUrl = stage.toDataURL({
      x: bgLayer.x(),
      y: bgLayer.y(),
      width: w * bgLayer.scaleX(),
      height: h * bgLayer.scaleY(),
      pixelRatio: 1 / bgLayer.scaleX(),
      mimeType: "image/jpeg",
      quality: 0.92,
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${name.replace(/[^a-z0-9\- ]/gi, "_")}.jpg`;
    a.click();
  } finally {
    yardsticks.forEach((n, i) => n.visible(wasVisible[i]));
    stage.batchDraw();
  }
}

function moonSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
}
function sunSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>`;
}
