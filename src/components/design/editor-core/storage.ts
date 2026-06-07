// Storage connector for the embedded editor (design-tool integration, Path B).
//
// Implements the subset of the design tool's `api` surface that the vendored
// editor controller calls, backed by our Supabase-backed /api/designs routes.
// This is the ONE app-specific seam — everything else in editor-core is a
// faithful copy of the design tool's editor, so re-syncing an upstream update
// means overwriting the other files and leaving this one alone.
//
// Phase-1 scope: scene load/save + base-photo upload are wired; colors/defaults
// use built-in constants (no Settings page yet); the custom-upload library is
// deferred (listUploads → empty, createUpload → throws).

import type {
  Design,
  Scene,
  BulbColor,
  ToolDefaults,
  CustomUpload,
} from '@/lib/design/sceneTypes';
import { DEFAULT_COLORS } from './colors';

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
      return DEFAULT_COLORS;
    },

    async getDefaults() {
      return {};
    },

    // Custom-upload library is deferred in Phase 1.
    async listUploads() {
      return [];
    },
    async createUpload() {
      throw new Error('Custom uploads are not available yet');
    },
    async deleteUpload() {
      return { ok: true as const };
    },
  };
}
