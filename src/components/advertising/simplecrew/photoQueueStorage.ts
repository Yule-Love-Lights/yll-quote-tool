// IndexedDB-backed durability for the capture queue (Naldo, 2026-08-31:
// offline durability for the field capture app). A photo is written here
// the moment the shutter fires, before any upload is attempted, and
// removed only once the server has confirmed it or the worker has thrown
// it away. If the app is force-quit, the tab is killed to reclaim memory,
// or the page just reloads, whatever is still in here on reopening is not
// lost.
//
// The actual IndexedDB access is hidden behind PhotoStoreBackend so the
// functions below are testable with a plain in-memory fake and no browser
// at all (see photoQueueStorage.test.ts). Every call is also capped by a
// timeout and wrapped so a stuck or broken backend can never make the
// caller hang or throw: a phone in private mode, or one that refuses the
// quota, must still let the worker shoot and upload normally.

import {
  isTerminalStoredStatus,
  reconcileStoredPhoto,
  sortRestoredNewestFirst,
  type PendingStoredPhotoStatus,
  type StoredPhotoStatus,
} from './photoQueueRestore';

export type StoredPhoto = {
  id: string;
  blob: Blob;
  campaignId: string;
  campaignName: string;
  note: string;
  capturedAt: number;
  status: StoredPhotoStatus;
  attempts: number;
  error?: string;
};

export type RestoredQueueEntry = {
  id: string;
  blob: Blob;
  campaignId: string;
  campaignName: string;
  note: string;
  capturedAt: number;
  attempts: number;
  status: 'waiting' | 'failed';
  autoResume: boolean;
  error?: string;
};

export interface PhotoStoreBackend {
  put(photo: StoredPhoto): Promise<void>;
  getAll(): Promise<StoredPhoto[]>;
  delete(id: string): Promise<void>;
}

const DB_NAME = 'yll-advertising-photo-queue';
const DB_VERSION = 1;
const STORE_NAME = 'photos';

class IndexedDbPhotoStore implements PhotoStoreBackend {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async put(photo: StoredPhoto): Promise<void> {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(photo);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async getAll(): Promise<StoredPhoto[]> {
    const db = await this.open();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve((req.result as StoredPhoto[] | undefined) ?? []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

let backend: PhotoStoreBackend | null = null;
function getBackend(): PhotoStoreBackend {
  if (!backend) backend = new IndexedDbPhotoStore();
  return backend;
}

/** Test-only seam: inject a fake backend instead of touching indexedDB.
 * Pass null to go back to the real one. */
export function setPhotoStoreBackendForTest(fake: PhotoStoreBackend | null): void {
  backend = fake;
}

export function generatePhotoId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Storage must never block or break the shutter. Every call below is
// capped so a stuck request (a wedged IndexedDB transaction, a hostile
// backend) resolves to a safe default instead of hanging the caller, and
// a thrown or rejected call resolves the same way instead of breaking it.
const BACKEND_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, BACKEND_TIMEOUT_MS);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Runs one backend call, guarded against both a synchronous throw and an
 * async rejection or hang, degrading to `fallback` either way. This is the
 * one place the "never blocks, never breaks" guarantee lives, so it
 * applies no matter which backend (real or a test fake) is installed. */
function callBackend<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return withTimeout(fn(), fallback);
  } catch {
    return Promise.resolve(fallback);
  }
}

/** Upsert one photo's full record. Used both for the very first write at
 * capture time and for every status change after that, so a kill mid-retry
 * still restores accurately. */
export async function writePhoto(record: StoredPhoto): Promise<void> {
  await callBackend(() => getBackend().put(record), undefined);
}

export async function deletePhoto(id: string): Promise<void> {
  await callBackend(() => getBackend().delete(id), undefined);
}

async function readAllStoredPhotos(): Promise<StoredPhoto[]> {
  return callBackend(() => getBackend().getAll(), []);
}

/** Read everything left over from a previous session. Anything already
 * landed or discarded is swept away here rather than shown (best effort,
 * never awaited by the caller, so a slow cleanup never delays a restore):
 * a storage failure earlier in the write-then-delete sequence can leave a
 * finished record behind, and it must never be offered back as pending
 * work. */
export async function loadPendingPhotosForRestore(): Promise<RestoredQueueEntry[]> {
  const stored = await readAllStoredPhotos();
  const pending: RestoredQueueEntry[] = [];
  for (const record of stored) {
    if (isTerminalStoredStatus(record.status)) {
      void deletePhoto(record.id);
      continue;
    }
    const status: PendingStoredPhotoStatus = record.status;
    const decision = reconcileStoredPhoto({ status, error: record.error });
    pending.push({
      id: record.id,
      blob: record.blob,
      campaignId: record.campaignId,
      campaignName: record.campaignName,
      note: record.note,
      capturedAt: record.capturedAt,
      attempts: record.attempts,
      status: decision.status,
      autoResume: decision.autoResume,
      error: decision.error,
    });
  }
  return sortRestoredNewestFirst(pending);
}
