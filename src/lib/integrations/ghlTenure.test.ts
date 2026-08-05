// Tests for the #200 GHL "Years with YLL" tenure mirror.
//
// getCustomerTenure is mocked (its own math is covered by
// customerTenure.test.ts) but MIN_TENURE_YEAR is the REAL exported const
// (partial mock via importOriginal) so a future floor change is caught here
// too, mirroring leadService.test.ts's "not mocked, so a drift is caught"
// convention for ghlPipelineMap.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const hl = vi.hoisted(() => {
  class FakeHighLevelError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'HighLevelError';
      this.status = status;
    }
  }
  return {
    HighLevelError: FakeHighLevelError,
    configured: { value: true },
    listLocationCustomFields: vi.fn(async () => [] as Array<{ id: string; name: string }>),
    createLocationCustomField: vi.fn(async (_input: { name: string; dataType: string }) => ({
      id: 'created-field-1',
      name: 'Years with YLL',
    })),
    upsertContactCustomField: vi.fn(async (_contactId: string, _fieldId: string, _value: string | string[]) => {}),
  };
});

vi.mock('./highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  HighLevelError: hl.HighLevelError,
  listLocationCustomFields: hl.listLocationCustomFields,
  createLocationCustomField: hl.createLocationCustomField,
  upsertContactCustomField: hl.upsertContactCustomField,
}));

const customersMock = vi.hoisted(() => ({
  getCustomer: vi.fn(async (_id: string) => null as null | { id: string; hl_contact_id: string | null }),
}));
vi.mock('../customers', () => ({
  getCustomer: customersMock.getCustomer,
}));

const tenureMock = vi.hoisted(() => ({
  getCustomerTenure: vi.fn(async (_customerId: string | null, _hlContactId: string | null, _now: Date) => ({
    years: [] as number[],
    count: 0,
    manualYears: [] as number[],
    derivedYears: [] as number[],
  })),
}));
vi.mock('../customerTenure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customerTenure')>();
  return { ...actual, getCustomerTenure: tenureMock.getCustomerTenure };
});

import { formatTenureYearsForGhl, pushTenureYearsToGhl, resetTenureFieldCacheForTests, TENURE_FIELD_NAME } from './ghlTenure';
import { MIN_TENURE_YEAR } from '../customerTenure';

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = true;
  hl.listLocationCustomFields.mockResolvedValue([]);
  hl.createLocationCustomField.mockResolvedValue({ id: 'created-field-1', name: TENURE_FIELD_NAME });
  hl.upsertContactCustomField.mockResolvedValue(undefined);
  customersMock.getCustomer.mockResolvedValue(null);
  tenureMock.getCustomerTenure.mockResolvedValue({ years: [], count: 0, manualYears: [], derivedYears: [] });
  resetTenureFieldCacheForTests();
});

describe('formatTenureYearsForGhl', () => {
  it('sorts ascending', () => {
    expect(formatTenureYearsForGhl([2025, 2023, 2024])).toBe('2023, 2024, 2025');
  });

  it('dedupes', () => {
    expect(formatTenureYearsForGhl([2024, 2023, 2024, 2023])).toBe('2023, 2024');
  });

  it('floor-clamps years below MIN_TENURE_YEAR (real const, not hard-coded here)', () => {
    expect(formatTenureYearsForGhl([MIN_TENURE_YEAR - 1, MIN_TENURE_YEAR, MIN_TENURE_YEAR + 1])).toBe(
      `${MIN_TENURE_YEAR}, ${MIN_TENURE_YEAR + 1}`,
    );
  });

  it('empty input → empty string', () => {
    expect(formatTenureYearsForGhl([])).toBe('');
  });

  it('drops non-integer values (review fix batch, tech-lens LOW)', () => {
    expect(formatTenureYearsForGhl([2023, 2024.5, NaN, 2024])).toBe('2023, 2024');
  });
});

describe('pushTenureYearsToGhl — guards', () => {
  it('no customerId → skips entirely, touches nothing', async () => {
    const result = await pushTenureYearsToGhl(null);
    expect(result).toEqual({ pushed: false });
    expect(customersMock.getCustomer).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('undefined customerId (same guard) → skips', async () => {
    const result = await pushTenureYearsToGhl(undefined);
    expect(result).toEqual({ pushed: false });
    expect(customersMock.getCustomer).not.toHaveBeenCalled();
  });

  it('HighLevel not configured → skips before reading the customer', async () => {
    hl.configured.value = false;
    const result = await pushTenureYearsToGhl('cust-1');
    expect(result).toEqual({ pushed: false });
    expect(customersMock.getCustomer).not.toHaveBeenCalled();
  });

  it('customer not found → skips', async () => {
    customersMock.getCustomer.mockResolvedValue(null);
    const result = await pushTenureYearsToGhl('cust-missing');
    expect(result).toEqual({ pushed: false });
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('customer has no linked GHL contact → skips (never computes tenure or resolves a field)', async () => {
    customersMock.getCustomer.mockResolvedValue({ id: 'cust-1', hl_contact_id: null });
    const result = await pushTenureYearsToGhl('cust-1');
    expect(result).toEqual({ pushed: false });
    expect(tenureMock.getCustomerTenure).not.toHaveBeenCalled();
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('a GHL error on the final upsert fails soft — logs, returns pushed:false, never throws', async () => {
    customersMock.getCustomer.mockResolvedValue({ id: 'cust-1', hl_contact_id: 'hl-1' });
    tenureMock.getCustomerTenure.mockResolvedValue({ years: [2023], count: 1, manualYears: [], derivedYears: [2023] });
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'field-1', name: TENURE_FIELD_NAME }]);
    hl.upsertContactCustomField.mockRejectedValue(new hl.HighLevelError('GHL down', 502));

    await expect(pushTenureYearsToGhl('cust-1')).resolves.toEqual({ pushed: false });
  });

  // Review fix batch (#200 admin-lens HIGH): getTenureQuotes fails OPEN to []
  // on a transient DB read error, so an empty computed set must never be
  // treated as "report zero" — it skips entirely, before the field is even
  // resolved.
  it('skips when the computed year set is empty — zero API calls, field never resolved', async () => {
    customersMock.getCustomer.mockResolvedValue({ id: 'cust-1', hl_contact_id: 'hl-1' });
    tenureMock.getCustomerTenure.mockResolvedValue({ years: [], count: 0, manualYears: [], derivedYears: [] });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: false });
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('computed empty year set'));
    errSpy.mockRestore();
  });
});

describe('pushTenureYearsToGhl — deadline', () => {
  it('times out after PUSH_DEADLINE_MS and resolves pushed:false without throwing', async () => {
    vi.useFakeTimers();
    customersMock.getCustomer.mockResolvedValue({ id: 'cust-1', hl_contact_id: 'hl-1' });
    // Never resolves — simulates a hung downstream call so the deadline is
    // the only thing that can settle the outer promise.
    tenureMock.getCustomerTenure.mockImplementation(() => new Promise(() => {}));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resultPromise = pushTenureYearsToGhl('cust-1');
    await vi.advanceTimersByTimeAsync(6000);
    const result = await resultPromise;

    expect(result).toEqual({ pushed: false });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('push timed out'));

    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does NOT time out when the real work finishes well within the deadline', async () => {
    vi.useFakeTimers();
    customersMock.getCustomer.mockResolvedValue({ id: 'cust-1', hl_contact_id: 'hl-1' });
    tenureMock.getCustomerTenure.mockResolvedValue({ years: [2023], count: 1, manualYears: [], derivedYears: [2023] });
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'field-1', name: TENURE_FIELD_NAME }]);

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: true });
    vi.useRealTimers();
  });
});

describe('pushTenureYearsToGhl — happy path', () => {
  it('pushes the sorted/deduped year list to the field id resolved by name', async () => {
    customersMock.getCustomer.mockResolvedValue({ id: 'cust-1', hl_contact_id: 'hl-contact-1' });
    tenureMock.getCustomerTenure.mockResolvedValue({
      years: [2024, 2022, 2024], // out of order + a dupe, mirroring deriveTenureYears' shape
      count: 2,
      manualYears: [],
      derivedYears: [2022, 2024],
    });
    hl.listLocationCustomFields.mockResolvedValue([
      { id: 'other-field', name: 'Some Other Field' },
      { id: 'field-42', name: TENURE_FIELD_NAME },
    ]);

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: true });
    expect(tenureMock.getCustomerTenure).toHaveBeenCalledWith('cust-1', 'hl-contact-1', expect.any(Date));
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-contact-1', 'field-42', '2022, 2024');
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
  });
});

describe('pushTenureYearsToGhl — field resolution (create-if-missing + cache)', () => {
  function linkedCustomer() {
    customersMock.getCustomer.mockResolvedValue({ id: 'cust-1', hl_contact_id: 'hl-1' });
    tenureMock.getCustomerTenure.mockResolvedValue({ years: [2023], count: 1, manualYears: [], derivedYears: [2023] });
  }

  it('creates the field when no existing field matches the name, then uses the created id', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'unrelated', name: 'Not It' }]);
    hl.createLocationCustomField.mockResolvedValue({ id: 'brand-new-field', name: TENURE_FIELD_NAME });

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: true });
    expect(hl.createLocationCustomField).toHaveBeenCalledWith({ name: TENURE_FIELD_NAME, dataType: 'TEXT' });
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-1', 'brand-new-field', '2023');
  });

  // Review fix batch (tech-lens MED): the hand-create dashboard fallback
  // (named in resolveTenureFieldId's docstring) must survive a casing or
  // whitespace slip.
  it('matches an existing field by name with different casing + surrounding whitespace, without creating a duplicate', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'hand-created', name: '  years WITH yll  ' }]);

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: true });
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-1', 'hand-created', '2023');
  });

  // Review fix batch (#200 tech-lens HIGH): this location provably has other
  // contact custom fields (quote-link/referral fields), so a genuinely empty
  // list is treated as a probable response-wrapper parse bug — refuse rather
  // than risk creating a duplicate field on every future booking.
  it('refuses to create when the list comes back EMPTY (probable parse bug), never auto-creates', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockResolvedValue([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: false });
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('came back EMPTY'));
    errSpy.mockRestore();
  });

  // Review fix batch (admin-lens MED): a stray duplicate field in GHL must
  // not make different process instances write to different fields.
  it('when multiple fields match the name, warns with the count + ids and deterministically picks the lowest id', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockResolvedValue([
      { id: 'field-z', name: TENURE_FIELD_NAME },
      { id: 'field-a', name: TENURE_FIELD_NAME },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: true });
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-1', 'field-a', '2023');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2 custom fields match'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('field-a'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('field-z'));
    warnSpy.mockRestore();
  });

  // Review fix batch (tech-lens MED): a human deleting/renaming the field in
  // GHL must not silently no-op every push from a warm instance forever.
  it('clears the cached field id when the upsert fails, so the next push re-resolves', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockResolvedValueOnce([{ id: 'field-old', name: TENURE_FIELD_NAME }]);
    hl.upsertContactCustomField.mockRejectedValueOnce(new Error('contact custom field not found'));

    const first = await pushTenureYearsToGhl('cust-1');
    expect(first).toEqual({ pushed: false });

    // Second push: field id was cleared, so it must re-list rather than
    // silently reuse the dead 'field-old' id.
    hl.listLocationCustomFields.mockResolvedValueOnce([{ id: 'field-new', name: TENURE_FIELD_NAME }]);
    const second = await pushTenureYearsToGhl('cust-1');

    expect(second).toEqual({ pushed: true });
    expect(hl.listLocationCustomFields).toHaveBeenCalledTimes(2);
    expect(hl.upsertContactCustomField).toHaveBeenLastCalledWith('hl-1', 'field-new', '2023');
  });

  it('caches the resolved field id in-process — a second push does not re-list or re-create', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'field-cached', name: TENURE_FIELD_NAME }]);

    await pushTenureYearsToGhl('cust-1');
    await pushTenureYearsToGhl('cust-1');

    expect(hl.listLocationCustomFields).toHaveBeenCalledTimes(1);
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).toHaveBeenCalledTimes(2);
  });

  it('a missing-scope error (401) logs the scope by name and skips the push without throwing', async () => {
    linkedCustomer();
    const scopeErr = new hl.HighLevelError('Forbidden', 401);
    hl.listLocationCustomFields.mockRejectedValue(scopeErr);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: false });
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('customFields scope'));
    errSpy.mockRestore();
  });

  it('a 403 is treated the same as a 401 (scope failure)', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockRejectedValue(new hl.HighLevelError('Forbidden', 403));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pushTenureYearsToGhl('cust-1');

    expect(result).toEqual({ pushed: false });
    errSpy.mockRestore();
  });

  it('a non-scope resolution failure is NOT cached — the next push retries resolution', async () => {
    linkedCustomer();
    hl.listLocationCustomFields.mockRejectedValueOnce(new Error('transient network blip'));
    hl.listLocationCustomFields.mockResolvedValueOnce([{ id: 'field-recovered', name: TENURE_FIELD_NAME }]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await pushTenureYearsToGhl('cust-1');
    expect(first).toEqual({ pushed: false });

    const second = await pushTenureYearsToGhl('cust-1');
    expect(second).toEqual({ pushed: true });
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-1', 'field-recovered', '2023');
    expect(hl.listLocationCustomFields).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});
