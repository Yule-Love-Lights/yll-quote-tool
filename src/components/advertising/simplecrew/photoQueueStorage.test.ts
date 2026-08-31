// The durable photo queue (Naldo, 2026-08-31: offline durability for the
// field capture app). No real IndexedDB or browser in these tests: a small
// in-memory fake stands in for PhotoStoreBackend, the seam
// photoQueueStorage.ts hides its actual IndexedDB access behind. That seam
// is the whole point, so these tests can run in plain Node.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deletePhoto,
  generatePhotoId,
  loadPendingPhotosForRestore,
  setPhotoStoreBackendForTest,
  writePhoto,
  type PhotoStoreBackend,
  type StoredPhoto,
} from './photoQueueStorage';

const blob = (): Blob => new Blob(['x'], { type: 'image/jpeg' });

function makeRecord(over: Partial<StoredPhoto> = {}): StoredPhoto {
  return {
    id: 'p1',
    blob: blob(),
    campaignId: 'c1',
    campaignName: 'Fall Signs',
    note: '',
    capturedAt: 1000,
    status: 'uploading',
    attempts: 0,
    ...over,
  };
}

/** A plain Map-backed fake. Real enough to prove the read/write/delete
 * contract; nothing browser-specific about it. */
class FakeBackend implements PhotoStoreBackend {
  store = new Map<string, StoredPhoto>();
  putCalls: string[] = [];
  deleteCalls: string[] = [];

  async put(photo: StoredPhoto): Promise<void> {
    this.putCalls.push(photo.id);
    this.store.set(photo.id, photo);
  }
  async getAll(): Promise<StoredPhoto[]> {
    return [...this.store.values()];
  }
  async delete(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.store.delete(id);
  }
}

/** Simulates a backend that never resolves, the shape a stuck IndexedDB
 * request or a hostile private-mode implementation could take. */
class HangingBackend implements PhotoStoreBackend {
  put(_photo: StoredPhoto): Promise<void> {
    return new Promise(() => {});
  }
  getAll(): Promise<StoredPhoto[]> {
    return new Promise(() => {});
  }
  delete(_id: string): Promise<void> {
    return new Promise(() => {});
  }
}

/** Simulates a phone in private mode, or a full quota: every call throws
 * or rejects. */
class BrokenBackend implements PhotoStoreBackend {
  async put(_photo: StoredPhoto): Promise<void> {
    throw new Error('QuotaExceededError');
  }
  async getAll(): Promise<StoredPhoto[]> {
    throw new Error('storage unavailable');
  }
  async delete(_id: string): Promise<void> {
    throw new Error('storage unavailable');
  }
}

let fake: FakeBackend;

beforeEach(() => {
  fake = new FakeBackend();
  setPhotoStoreBackendForTest(fake);
});

afterEach(() => {
  setPhotoStoreBackendForTest(null);
  vi.useRealTimers();
});

describe('generatePhotoId', () => {
  it('never returns the same id twice in a row', () => {
    const a = generatePhotoId();
    const b = generatePhotoId();
    expect(a).not.toBe(b);
  });
});

describe('writePhoto + loadPendingPhotosForRestore: the round trip', () => {
  it('a freshly written pending photo comes back with its note and its campaign', async () => {
    await writePhoto(makeRecord({ status: 'waiting', note: '', campaignId: 'c9', campaignName: 'Door Hangers' }));
    const restored = await loadPendingPhotosForRestore();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: 'p1',
      campaignId: 'c9',
      campaignName: 'Door Hangers',
      note: '',
      status: 'waiting',
      autoResume: true,
    });
  });

  it('a mid-upload photo restores held, not resumed, and never silently vanishes', async () => {
    await writePhoto(makeRecord({ status: 'uploading' }));
    const restored = await loadPendingPhotosForRestore();
    expect(restored).toHaveLength(1);
    expect(restored[0].status).toBe('failed');
    expect(restored[0].autoResume).toBe(false);
  });

  it('a held (failed) photo restores held, keeping its worker-facing reason', async () => {
    await writePhoto(makeRecord({ status: 'failed', error: 'No connection.' }));
    const restored = await loadPendingPhotosForRestore();
    expect(restored[0]).toMatchObject({ status: 'failed', autoResume: false, error: 'No connection.' });
  });

  it('nothing stored means nothing restored', async () => {
    expect(await loadPendingPhotosForRestore()).toEqual([]);
  });

  it('several pending photos restore newest first', async () => {
    await writePhoto(makeRecord({ id: 'old', capturedAt: 100, status: 'waiting' }));
    await writePhoto(makeRecord({ id: 'new', capturedAt: 300, status: 'waiting' }));
    await writePhoto(makeRecord({ id: 'mid', capturedAt: 200, status: 'waiting' }));
    const restored = await loadPendingPhotosForRestore();
    expect(restored.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('a photo that already landed or was thrown away never resurrects', () => {
  it('an uploaded record is not returned as pending work', async () => {
    await writePhoto(makeRecord({ status: 'uploaded' }));
    expect(await loadPendingPhotosForRestore()).toEqual([]);
  });

  it('an uploaded record left behind is swept up (garbage-collected) on the next restore', async () => {
    await writePhoto(makeRecord({ status: 'uploaded' }));
    await loadPendingPhotosForRestore();
    // deletePhoto is fired but not awaited by the loader (never blocks a
    // restore on cleanup), so give the microtask queue one turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.store.has('p1')).toBe(false);
  });

  it('a discarded record is not returned as pending work either', async () => {
    await writePhoto(makeRecord({ status: 'discarded' }));
    expect(await loadPendingPhotosForRestore()).toEqual([]);
  });

  it('MUTATION PROBE: without the terminal-status filter, an uploaded record would come back as pending -- proving the filter is what protects a second pay claim', async () => {
    await writePhoto(makeRecord({ status: 'uploaded' }));
    // Read the raw backend directly, bypassing loadPendingPhotosForRestore's
    // filter, to show the record really is sitting there and really would
    // look like ordinary pending work if nothing excluded it.
    const raw = await fake.getAll();
    expect(raw).toHaveLength(1);
    expect(raw[0].status).toBe('uploaded');
    // The real function excludes it.
    expect(await loadPendingPhotosForRestore()).toEqual([]);
  });
});

describe('deletePhoto', () => {
  it('removes a record outright', async () => {
    await writePhoto(makeRecord());
    await deletePhoto('p1');
    expect(fake.store.has('p1')).toBe(false);
  });

  it('deleting something that was never there is a quiet no-op', async () => {
    await expect(deletePhoto('ghost')).resolves.toBeUndefined();
  });
});

describe('storage failures degrade instead of breaking the caller', () => {
  it('writePhoto never throws when the backend is broken', async () => {
    setPhotoStoreBackendForTest(new BrokenBackend());
    await expect(writePhoto(makeRecord())).resolves.toBeUndefined();
  });

  it('deletePhoto never throws when the backend is broken', async () => {
    setPhotoStoreBackendForTest(new BrokenBackend());
    await expect(deletePhoto('p1')).resolves.toBeUndefined();
  });

  it('loadPendingPhotosForRestore returns an empty list, not a rejection, when the backend is broken', async () => {
    setPhotoStoreBackendForTest(new BrokenBackend());
    await expect(loadPendingPhotosForRestore()).resolves.toEqual([]);
  });

  it('MUTATION PROBE: a plain pass-through with no guard WOULD reject here -- proving the try/catch layer is load-bearing, not decorative', async () => {
    const broken = new BrokenBackend();
    await expect(broken.put(makeRecord())).rejects.toThrow();
    setPhotoStoreBackendForTest(broken);
    await expect(writePhoto(makeRecord())).resolves.toBeUndefined();
  });

  it('a backend that never resolves does not hang writePhoto forever: it degrades on a timeout', async () => {
    vi.useFakeTimers();
    setPhotoStoreBackendForTest(new HangingBackend());
    const p = writePhoto(makeRecord());
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
  });

  it('a backend that never resolves does not hang loadPendingPhotosForRestore forever either', async () => {
    vi.useFakeTimers();
    setPhotoStoreBackendForTest(new HangingBackend());
    const p = loadPendingPhotosForRestore();
    let result: unknown = 'not yet';
    void p.then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result).toEqual([]);
  });
});
