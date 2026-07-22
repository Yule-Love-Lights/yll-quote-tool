// Tests for the field-capture write execution. Two things matter most here:
// the CONFIRM SUMMARY must name every effect (it is the only thing the crew
// sees before saying yes), and photos must be attached before the idempotent
// material claim so a follow-up photo message isn't silently dropped.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
  recordMaterialActuals: vi.fn(async (): Promise<unknown> => null),
  addDesignExtraPhoto: vi.fn(async () => ({ id: 'p1' })),
  downloadTelegramFile: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards: mocks.listFulfillmentCards }));
vi.mock('@/lib/inventory/materialActuals', () => ({ recordMaterialActuals: mocks.recordMaterialActuals }));
vi.mock('@/lib/designs', () => ({ addDesignExtraPhoto: mocks.addDesignExtraPhoto }));
vi.mock('./telegramMedia', () => ({ downloadTelegramFile: mocks.downloadTelegramFile }));

import { runCompleteInstall, summarizeCompleteInstall } from './botWriteTools';

const CARD = { id: 'job-uuid', jobNumber: 142, customerName: 'Alvarez', designId: 'design-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listFulfillmentCards.mockResolvedValue([CARD]);
  mocks.recordMaterialActuals.mockResolvedValue({
    ok: true,
    alreadyDone: false,
    trueUps: [{ sku: 'C9-WARM', estimated: 3, actual: 2, delta: 1 }],
    skipped: [],
  });
  mocks.downloadTelegramFile.mockResolvedValue({
    buffer: Buffer.from('img'),
    contentType: 'image/jpeg',
  });
});

describe('summarizeCompleteInstall', () => {
  it('names the job, the customer, every material line, and the photo count', () => {
    const summary = summarizeCompleteInstall(
      {
        jobNumber: 142,
        materials: [
          { sku: 'C9-WARM', qty: 2 },
          { sku: 'CLIP-ALL', qty: 30 },
        ],
        photoFileIds: ['a', 'b'],
      },
      'Alvarez',
    );
    expect(summary).toContain('#142');
    expect(summary).toContain('Alvarez');
    expect(summary).toContain('2× C9-WARM');
    expect(summary).toContain('30× CLIP-ALL');
    expect(summary).toContain('2 photos');
    expect(summary).toContain('reply yes');
  });

  it('says so plainly when no material was reported', () => {
    expect(summarizeCompleteInstall({ jobNumber: 142, materials: [] })).toContain('log no material');
  });

  it('uses the singular for one photo', () => {
    expect(
      summarizeCompleteInstall({ jobNumber: 1, materials: [], photoFileIds: ['a'] }),
    ).toContain('1 photo ');
  });
});

describe('runCompleteInstall', () => {
  it('refuses an unknown job without recording anything', async () => {
    mocks.listFulfillmentCards.mockResolvedValue([]);
    const reply = await runCompleteInstall({ jobNumber: 999, materials: [] }, 'user-1');
    expect(reply).toBe('No active job #999.');
    expect(mocks.recordMaterialActuals).not.toHaveBeenCalled();
  });

  it('reports the stock adjustment it made', async () => {
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 2 }] },
      'user-1',
    );
    expect(reply).toContain('logged 1 material line');
    expect(reply).toContain('C9-WARM +1');
  });

  it('says stock matched when there is nothing to true up', async () => {
    mocks.recordMaterialActuals.mockResolvedValue({
      ok: true,
      alreadyDone: false,
      trueUps: [],
      skipped: [],
    });
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 2 }] },
      'user-1',
    );
    expect(reply).toContain('no adjustment');
  });

  it('names SKUs that were recorded but are not stocked', async () => {
    mocks.recordMaterialActuals.mockResolvedValue({
      ok: true,
      alreadyDone: false,
      trueUps: [],
      skipped: ['ODD-SKU'],
    });
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'ODD-SKU', qty: 1 }] },
      'user-1',
    );
    expect(reply).toContain('ODD-SKU');
  });

  it('tells the crew stock was NOT touched again on a repeat submission', async () => {
    mocks.recordMaterialActuals.mockResolvedValue({ ok: true, alreadyDone: true });
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 2 }] },
      'user-1',
    );
    expect(reply).toContain('already had its materials recorded');
    expect(reply).toContain('not touched again');
  });

  it('asks for a retry instead of implying success when the write failed', async () => {
    mocks.recordMaterialActuals.mockResolvedValue(null);
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 2 }] },
      'user-1',
    );
    expect(reply).toContain("Couldn't record materials");
    expect(reply).toContain('try again');
  });

  it('attaches photos to the linked design, titled with the job number', async () => {
    await runCompleteInstall(
      { jobNumber: 142, materials: [], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(mocks.addDesignExtraPhoto).toHaveBeenCalledWith(
      'design-1',
      Buffer.from('img').toString('base64'),
      'image/jpeg',
      'Install photo — job #142',
    );
  });

  it('saves photos even when the material claim was already used', async () => {
    mocks.recordMaterialActuals.mockResolvedValue({ ok: true, alreadyDone: true });
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 1 }], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(mocks.addDesignExtraPhoto).toHaveBeenCalledOnce();
    expect(reply).toContain('Saved 1 photo');
  });

  it('skips photos and says so when the job has no design', async () => {
    mocks.listFulfillmentCards.mockResolvedValue([{ ...CARD, designId: null }]);
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(mocks.addDesignExtraPhoto).not.toHaveBeenCalled();
    expect(reply).toContain('No design linked');
  });

  it('keeps the material result when a photo fails to download', async () => {
    mocks.downloadTelegramFile.mockResolvedValue(null);
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 2 }], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(reply).toContain('logged 1 material line');
    expect(reply).toContain('1 photo failed');
  });

  it('keeps the material result when attaching a photo throws', async () => {
    mocks.addDesignExtraPhoto.mockRejectedValue(new Error('storage down'));
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 2 }], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(reply).toContain('logged 1 material line');
    expect(reply).toContain('1 photo failed');
  });
});
