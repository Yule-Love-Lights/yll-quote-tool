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

type DesignPatch = Partial<{
  name: string;
  background: string | null;
  scene: Scene;
  photoPath: string | null;
  photoW: number | null;
  photoH: number | null;
}>;

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const EMPTY_SCENE: Scene = { yardsticks: [], items: [] };

// Adapt our API's design shape into the editor's `Design` shape. `projectId`,
// `background`, `name`, and the timestamps are design-tool app-shell fields the
// editor reads but Path B doesn't use — filled with harmless placeholders.
function toEditorDesign(id: string, api: {
  scene?: Scene;
  photoUrl?: string | null;
  photoW?: number | null;
  photoH?: number | null;
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
      if (patch.scene) {
        const res = await fetch(`/api/designs/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene: patch.scene }),
        });
        if (!res.ok) throw new Error(`save scene failed: ${res.status}`);
      }
      // The editor ignores this return value; hand back a minimal Design.
      return toEditorDesign(id, {
        scene: patch.scene,
        photoW: patch.photoW ?? null,
        photoH: patch.photoH ?? null,
      });
    },

    async uploadPhoto(file) {
      const base64 = await readFileAsDataUrl(file);
      const res = await fetch(`/api/designs/${designId}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoBase64: base64, photoMediaType: file.type || 'image/jpeg' }),
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
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/uploads', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `upload failed: ${res.status}`);
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
