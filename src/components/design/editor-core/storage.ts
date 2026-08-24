// Storage connector for the embedded editor (design-tool integration, Path B).
//
// Implements the subset of the design tool's `api` surface that the vendored
// editor controller calls, backed by our Supabase-backed /api/designs routes.
// This is the ONE app-specific seam — everything else in editor-core is a
// faithful copy of the design tool's editor, so re-syncing an upstream update
// means overwriting the other files and leaving this one alone.
//
// Scope: scene load/save + base-photo upload are wired; colors + per-type
// defaults come from the global app settings (#32, /api/settings); the
// custom-upload library is backed by /api/uploads + the public custom-uploads
// bucket (#32 Phase 3).

import type {
  Design,
  Scene,
  BulbColor,
  ToolDefaults,
  CustomUpload,
} from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from './colors';
import { fetchAppSettings } from '@/lib/clientSettings';
import {
  downscaleForUpload,
  exceedsMultipartSizeLimit,
  oversizeMessage,
  readUploadErrorMessage,
  MULTIPART_SIZE_LIMIT_BYTES,
} from '@/lib/clientImage';

type DesignPatch = Partial<{
  name: string;
  background: string | null;
  scene: Scene;
  photoPath: string | null;
  photoW: number | null;
  photoH: number | null;
  // Ledger row 260: the version this save's `scene` was read against — the
  // compare-and-swap precondition for the PUT below. null/undefined = unknown
  // (the design was never read, or came from a pre-#260 caller).
  version: number | null;
}>;

// Ledger row 260: thrown by updateDesign when the server's compare-and-swap
// rejects the write (409, a concurrent writer already moved the version) —
// distinguished from a generic save failure so the editor can block-and-
// offer-reload instead of its ordinary auto-retry (which would just resend
// the same stale overwrite forever).
export class SceneConflictError extends Error {
  constructor() {
    super('Design changed elsewhere — scene version conflict');
    this.name = 'SceneConflictError';
  }
}

export type EditorApi = {
  getDesign(id: string): Promise<Design>;
  updateDesign(id: string, patch: DesignPatch): Promise<Design>;
  uploadPhoto(file: File): Promise<{ path: string; url: string }>;
  getColors(): Promise<BulbColor[]>;
  getDefaults(): Promise<ToolDefaults>;
  listUploads(): Promise<CustomUpload[]>;
  createUpload(file: File): Promise<CustomUpload>;
  deleteUpload(id: string): Promise<{ ok: true }>;
};

const EMPTY_SCENE: Scene = { yardsticks: [], items: [] };

// Adapt our API's design shape into the editor's `Design` shape. `projectId`,
// `background`, `name`, and the timestamps are design-tool app-shell fields the
// editor reads but Path B doesn't use — filled with harmless placeholders.
function toEditorDesign(id: string, api: {
  scene?: Scene;
  photoUrl?: string | null;
  photoW?: number | null;
  photoH?: number | null;
  extraPhotos?: Design['extraPhotos'];
  version?: number | null;
}): Design {
  return {
    id,
    projectId: null,
    name: 'Design',
    photoUrl: api.photoUrl ?? null,
    photoW: api.photoW ?? null,
    photoH: api.photoH ?? null,
    background: null,
    scene: api.scene ?? EMPTY_SCENE,
    createdAt: 0,
    updatedAt: 0,
    // #13: extra street photos ride along so the editor can mount on one.
    extraPhotos: api.extraPhotos ?? [],
    // Ledger row 260: carried through so doSave() can round-trip it as the
    // CAS precondition on the next save.
    version: api.version ?? null,
  };
}

export function createEditorApi(designId: string): EditorApi {
  return {
    async getDesign(id) {
      const res = await fetch(`/api/designs/${id}`);
      if (!res.ok) throw new Error(`load design failed: ${res.status}`);
      const { design } = await res.json();
      return toEditorDesign(design.id ?? id, design);
    },

    async updateDesign(id, patch) {
      // Only the scene is persisted in Phase 1. Photo metadata is already
      // persisted by the photo route; name/background are unused.
      let newVersion: number | null | undefined = patch.version;
      if (patch.scene) {
        const res = await fetch(`/api/designs/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene: patch.scene, version: patch.version ?? null }),
        });
        // Ledger row 260: a 409 means the server's compare-and-swap rejected
        // this write (a concurrent writer already moved the version) — throw
        // a distinguishable error so doSave() can tell this apart from an
        // ordinary network/5xx failure and NOT auto-retry the same overwrite.
        if (res.status === 409) throw new SceneConflictError();
        if (!res.ok) throw new Error(`save scene failed: ${res.status}`);
        const data = await res.json().catch(() => ({}));
        if (typeof data.version === 'number') newVersion = data.version;
      }
      // The editor reads `version` off this return value (see doSave()); the
      // rest is ignored — hand back a minimal Design.
      return toEditorDesign(id, {
        scene: patch.scene,
        photoW: patch.photoW ?? null,
        photoH: patch.photoH ?? null,
        version: newVersion,
      });
    },

    async uploadPhoto(file) {
      // #186: downscale before base64-encoding — see clientImage.ts.
      const { dataUrl, mediaType } = await downscaleForUpload(file);
      const res = await fetch(`/api/designs/${designId}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoBase64: dataUrl, photoMediaType: mediaType }),
      });
      if (!res.ok) throw new Error(`upload photo failed: ${res.status}`);
      const { photoUrl } = await res.json();
      // The editor uses `url` to display the image; `path` is stored via a
      // follow-up updateDesign call that we intentionally ignore (the photo
      // route already persisted path + dimensions on the row).
      return { path: '(stored)', url: photoUrl };
    },

    async getColors() {
      const { colors } = await fetchAppSettings();
      return Array.isArray(colors) && colors.length > 0 ? colors : DEFAULT_COLORS;
    },

    async getDefaults() {
      const { defaults } = await fetchAppSettings();
      return defaults ?? {};
    },

    // Custom-upload library (#32 Phase 3) — backed by /api/uploads + the public
    // custom-uploads bucket. Shared across all designs.
    async listUploads() {
      const res = await fetch('/api/uploads');
      if (!res.ok) return [];
      return res.json();
    },
    async createUpload(file) {
      // #186 phase 2: precheck client-side rather than let an oversized
      // graphic 413 at Vercel's raw-body cap — /api/uploads is NOT downscaled
      // (these are decorative PNGs; JPEG flattening would destroy their
      // transparency).
      if (exceedsMultipartSizeLimit(file.size)) {
        throw new Error(oversizeMessage(file.size, MULTIPART_SIZE_LIMIT_BYTES, 'graphic'));
      }
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/uploads', { method: 'POST', body: fd });
      if (!res.ok) {
        throw new Error(
          await readUploadErrorMessage(res, `upload failed: ${res.status}`, 'This graphic is too large for the server — try a smaller graphic.'),
        );
      }
      return res.json();
    },
    async deleteUpload(id) {
      const res = await fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      return { ok: true as const };
    },
  };
}
