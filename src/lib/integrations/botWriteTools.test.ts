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
  syncFieldLeadToGhl: vi.fn(async (): Promise<unknown> => ({ status: 'synced', ghlContactId: 'contact-1' })),
}));

vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards: mocks.listFulfillmentCards }));
vi.mock('@/lib/inventory/materialActuals', () => ({ recordMaterialActuals: mocks.recordMaterialActuals }));
vi.mock('@/lib/designs', () => ({ addDesignExtraPhoto: mocks.addDesignExtraPhoto }));
vi.mock('./telegramMedia', () => ({ downloadTelegramFile: mocks.downloadTelegramFile }));
vi.mock('@/lib/leads/fieldLead', () => ({ syncFieldLeadToGhl: mocks.syncFieldLeadToGhl }));

import { runCompleteInstall, summarizeCompleteInstall, runCaptureLead, summarizeCaptureLead } from './botWriteTools';

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
  mocks.syncFieldLeadToGhl.mockResolvedValue({ status: 'synced', ghlContactId: 'contact-1' });
});

describe('summarizeCompleteInstall', () => {
  it('names the job, the customer, every material line, and the photo count', () => {
    const summary = summarizeCompleteInstall(
      {
        jobNumber: 142,
        materials: [
          { sku: 'C9-WARM', name: 'C9 Warm White', qty: 2 },
          { sku: 'CLIP-ALL', name: 'C9 Flex Clip White', qty: 30 },
        ],
        photoFileIds: ['a', 'b'],
      },
      'Alvarez',
    );
    expect(summary).toContain('#142');
    expect(summary).toContain('Alvarez');
    // Names, not codes: nobody on a ladder recognises '20009-SPK'.
    expect(summary).toContain('2× C9 Warm White');
    expect(summary).not.toContain('C9-WARM');
    expect(summary).toContain('30× C9 Flex Clip White');
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
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 2 }] },
      'user-1',
    );
    expect(reply).toContain('logged 1 material line');
    expect(reply).toContain('C9 Warm White +1');
  });

  it('says stock matched when there is nothing to true up', async () => {
    mocks.recordMaterialActuals.mockResolvedValue({
      ok: true,
      alreadyDone: false,
      trueUps: [],
      skipped: [],
    });
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 2 }] },
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
      { jobNumber: 142, materials: [{ sku: 'ODD-SKU', name: 'Odd Thing', qty: 1 }] },
      'user-1',
    );
    expect(reply).toContain('Odd Thing');
  });

  it('tells the crew stock was NOT touched again on a repeat submission', async () => {
    mocks.recordMaterialActuals.mockResolvedValue({ ok: true, alreadyDone: true });
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 2 }] },
      'user-1',
    );
    expect(reply).toContain('already had its materials recorded');
    expect(reply).toContain('not touched again');
  });

  it('asks for a retry instead of implying success when the write failed', async () => {
    mocks.recordMaterialActuals.mockResolvedValue(null);
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 2 }] },
      'user-1',
    );
    expect(reply).toContain("Couldn't record materials");
    expect(reply).toContain('try again');
  });

  it('attaches photos to the linked design, tagged crew, with the fileId dedupe key', async () => {
    await runCompleteInstall(
      { jobNumber: 142, materials: [], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(mocks.addDesignExtraPhoto).toHaveBeenCalledWith(
      'design-1',
      Buffer.from('img').toString('base64'),
      'image/jpeg',
      'Install photo — job #142',
      // Marks it INTERNAL so portalPhotos() keeps it out of the homeowner's
      // gallery — the portal renders every extra photo it is handed.
      'crew',
      // The Telegram fileId is the dedupe key: addDesignExtraPhoto no-ops on a
      // repeat, so a retry / redelivery can't append the same shot twice.
      'file-a',
    );
  });

  it('still attaches a follow-up photo when materials were already recorded (no claim gating)', async () => {
    // A genuine follow-up (new photo on an already-recorded job) must NOT be
    // dropped — dedup by fileId at the design layer, not by the material claim.
    mocks.recordMaterialActuals.mockResolvedValue({ ok: true, alreadyDone: true });
    await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 1 }], photoFileIds: ['file-new'] },
      'user-1',
    );
    expect(mocks.addDesignExtraPhoto).toHaveBeenCalledWith(
      'design-1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'crew',
      'file-new',
    );
  });

  it('still attaches photos even when the material record failed (dedup makes it safe to retry)', async () => {
    mocks.recordMaterialActuals.mockResolvedValue(null);
    await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 1 }], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(mocks.addDesignExtraPhoto).toHaveBeenCalledOnce();
  });

  it('attaches photos on a photos-only report (no material to gate on)', async () => {
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [], photoFileIds: ['file-a'] },
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
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 2 }], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(reply).toContain('logged 1 material line');
    expect(reply).toContain('1 photo failed');
  });

  it('keeps the material result when attaching a photo throws', async () => {
    mocks.addDesignExtraPhoto.mockRejectedValue(new Error('storage down'));
    const reply = await runCompleteInstall(
      { jobNumber: 142, materials: [{ sku: 'C9-WARM', name: 'C9 Warm White', qty: 2 }], photoFileIds: ['file-a'] },
      'user-1',
    );
    expect(reply).toContain('logged 1 material line');
    expect(reply).toContain('1 photo failed');
  });
});

describe('summarizeCaptureLead', () => {
  it('names every field and carries the consent affirmation (task #9, locked wording)', () => {
    const summary = summarizeCaptureLead({
      name: 'John Smith',
      phone: '631-555-0100',
      address: '12 Oak St',
      service: 'permanent',
    });
    expect(summary).toBe(
      'New field lead: John Smith · 631-555-0100 · 12 Oak St · Permanent. ' +
        "Reply YES only if they agreed to be contacted (they'll be enrolled in texts).",
    );
  });

  it('omits the address bullet when none was given', () => {
    const summary = summarizeCaptureLead({ name: 'John Smith', phone: '631-555-0100', service: 'christmas' });
    expect(summary).toBe(
      "New field lead: John Smith · 631-555-0100 · Christmas. Reply YES only if they agreed to be contacted (they'll be enrolled in texts).",
    );
  });

  it('echoes the note so the crew can catch a bad extraction before confirming', () => {
    const summary = summarizeCaptureLead({
      name: 'John Smith',
      phone: '631-555-0100',
      service: 'permanent',
      note: 'wants uplighting too',
    });
    expect(summary).toContain('note "wants uplighting too"');
  });

  it('omits the note segment when none was parsed', () => {
    const summary = summarizeCaptureLead({ name: 'John Smith', phone: '631-555-0100', service: 'permanent' });
    expect(summary).not.toContain('note "');
  });
});

describe('runCaptureLead', () => {
  it('syncs to GHL and reports success', async () => {
    const result = await runCaptureLead({
      name: 'John Smith',
      phone: '631-555-0100',
      address: '12 Oak St',
      service: 'permanent',
    });
    expect(mocks.syncFieldLeadToGhl).toHaveBeenCalledWith({
      name: 'John Smith',
      phone: '631-555-0100',
      address: '12 Oak St',
      note: null,
      service: 'permanent',
    });
    expect(result.synced).toBe(true);
    expect(result.reply).toContain('John Smith');
    expect(result.reply).toContain('enrolled in texts');
  });

  it('reports the contact as saved but flags a tag/note failure without claiming success', async () => {
    mocks.syncFieldLeadToGhl.mockResolvedValue({
      status: 'error',
      ghlContactId: 'contact-1',
      syncError: 'tag boom',
    });
    const result = await runCaptureLead({ name: 'John Smith', phone: '631-555-0100', service: 'permanent' });
    expect(result.synced).toBe(false);
    expect(result.reply).toContain('Saved');
    expect(result.reply).toContain('office');
  });

  it('never throws into the webhook when the GHL sync itself throws, and tells the crew to RESEND (not reply yes)', async () => {
    mocks.syncFieldLeadToGhl.mockRejectedValue(new Error('upsert boom'));
    const result = await runCaptureLead({ name: 'John Smith', phone: '631-555-0100', service: 'permanent' });
    expect(result.synced).toBe(false);
    // The pending confirm is already consumed by the time this runs (see
    // botDispatch), so a "reply yes" instruction here would dead-end on
    // "Nothing is waiting for a yes." and lose the lead. Must say RESEND.
    expect(result.reply).toContain('resend the whole lead');
    expect(result.reply).not.toContain('reply yes');
  });

  it('is honest when a household match kept the EXISTING contact name — reply names both names', async () => {
    mocks.syncFieldLeadToGhl.mockResolvedValue({
      status: 'synced',
      ghlContactId: 'contact-1',
      savedContactName: 'Bob Jones',
    });
    const result = await runCaptureLead({ name: 'Alice Jones', phone: '631-555-0100', service: 'permanent' });
    expect(result.synced).toBe(true);
    expect(result.savedContactName).toBe('Bob Jones');
    expect(result.reply).toContain('Bob Jones');
    expect(result.reply).toContain('Alice Jones');
    expect(result.reply).not.toContain('Got it —'); // must not use the ordinary success wording
  });

  it('uses the ordinary success reply when there was no household mismatch', async () => {
    mocks.syncFieldLeadToGhl.mockResolvedValue({ status: 'synced', ghlContactId: 'contact-1' });
    const result = await runCaptureLead({ name: 'John Smith', phone: '631-555-0100', service: 'permanent' });
    expect(result.synced).toBe(true);
    expect(result.savedContactName).toBeUndefined();
    expect(result.reply).toContain('Got it');
  });
});
