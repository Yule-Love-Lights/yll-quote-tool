import { describe, it, expect } from 'vitest';
import {
  QuoteFormData,
  initialFormData,
  buildQuoteInputs,
  inputsToFormData,
} from './quoteForm';
import type { QuoteInputs } from './pricing/pricingEngine';

// A fully-populated form, exercising every mapped field.
const fullForm: QuoteFormData = {
  customer: { name: 'Jane Doe', address: '12 Elm St', phone: '555-0101', email: 'jane@x.com' },
  serviceType: 'event', // non-default, to exercise the field
  santasFootage: 120,
  santasDifficulty: 'hard',
  gingerbreadFootage: 80,
  gingerbreadDifficulty: 'easy',
  winterWonderlandFootage: 40,
  winterWonderlandDifficulty: 'medium',
  stakeLightingFootage: 60,
  stakeLightingDifficulty: 'hard',
  rooflineChoice: 'gingerbread',
  miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 3 }],
  spritzers: [{ size: '24', quantity: 2 }],
  wreaths: [{ size: '30noble', tier: 'fullDecor', quantity: 1 }],
  garland: [{ length: '9ft', type: 'noble', tier: 'bow', quantity: 2 }],
  bows: [{ quantity: 2 }],
  customLineItems: [{ label: 'Flagpole wrap', amount: 95, quantity: 2 }],
  takedown: 'premium',
  rushFee: true,
  discountEnabled: true,
  discountType: 'percentage',
  discountAmount: 20,
  waiveMinimum: true, // non-default, to exercise the field
  installTiming: 'none', // manual-discount path; early-install has its own tests
};

describe('buildQuoteInputs', () => {
  it('builds the full payload, converting percentage to a fraction', () => {
    const inputs = buildQuoteInputs(fullForm);
    expect(inputs.santasFootage).toBe(120);
    expect(inputs.rooflineChoice).toBe('gingerbread');
    expect(inputs.discount).toEqual({ type: 'percentage', amount: 0.2 });
    expect(inputs.customLineItems).toEqual(fullForm.customLineItems);
    expect(inputs.stakeLightingFootage).toBe(60);
    expect(inputs.stakeLightingDifficulty).toBe('hard');
  });

  it('round-trips Stake Lighting through inputs → form', () => {
    const restored = inputsToFormData(fullForm.customer, buildQuoteInputs(fullForm));
    expect(restored.stakeLightingFootage).toBe(60);
    expect(restored.stakeLightingDifficulty).toBe('hard');
  });

  it('omits rooflineChoice when staff has not recommended one', () => {
    const inputs = buildQuoteInputs({ ...fullForm, rooflineChoice: undefined });
    expect('rooflineChoice' in inputs).toBe(false);
  });

  it('applies the rooflineChoice override over the form value', () => {
    expect(buildQuoteInputs(fullForm, 'santas').rooflineChoice).toBe('santas');
    expect(buildQuoteInputs({ ...fullForm, rooflineChoice: undefined }, 'none').rooflineChoice).toBe('none');
  });

  it('omits discount when disabled and passes flat dollars through', () => {
    expect('discount' in buildQuoteInputs({ ...fullForm, discountEnabled: false })).toBe(false);
    const flat = buildQuoteInputs({ ...fullForm, discountType: 'flat', discountAmount: 150 });
    expect(flat.discount).toEqual({ type: 'flat', amount: 150 });
  });

  it('sends waiveMinimum only when set; omits it otherwise (#59)', () => {
    expect(buildQuoteInputs({ ...fullForm, waiveMinimum: true }).waiveMinimum).toBe(true);
    expect('waiveMinimum' in buildQuoteInputs({ ...fullForm, waiveMinimum: false })).toBe(false);
  });

  it('sends installTiming only when a month is picked; omits it for none (#40)', () => {
    expect(buildQuoteInputs({ ...fullForm, installTiming: 'october' }).installTiming).toBe('october');
    expect('installTiming' in buildQuoteInputs({ ...fullForm, installTiming: 'none' })).toBe(false);
  });

  it('drops the manual discount when an early-install month is picked (mutually exclusive #40)', () => {
    // discountEnabled is on, but picking a month must NOT also send a manual discount.
    const inputs = buildQuoteInputs({ ...fullForm, discountEnabled: true, installTiming: 'september' });
    expect(inputs.installTiming).toBe('september');
    expect('discount' in inputs).toBe(false);
  });
});

describe('inputsToFormData', () => {
  it('round-trips a fully-populated form', () => {
    const inputs = buildQuoteInputs(fullForm);
    // serviceType rides its own column, so it's passed separately (not via inputs).
    const hydrated = inputsToFormData(fullForm.customer, inputs, fullForm.serviceType);
    expect(hydrated).toEqual(fullForm);
  });

  it('round-trips with no discount and no roofline pick', () => {
    const form: QuoteFormData = {
      ...fullForm,
      rooflineChoice: undefined,
      discountEnabled: false,
      discountType: 'percentage',
      discountAmount: 0,
    };
    const hydrated = inputsToFormData(form.customer, buildQuoteInputs(form), form.serviceType);
    // rooflineChoice is omitted (not present as undefined) on both sides.
    expect('rooflineChoice' in hydrated).toBe(false);
    expect(hydrated).toEqual({ ...form, rooflineChoice: undefined });
  });

  it('inverts the discount fraction without float noise', () => {
    expect(
      inputsToFormData({}, { discount: { type: 'percentage', amount: 0.2 } }).discountAmount,
    ).toBe(20);
    expect(
      inputsToFormData({}, { discount: { type: 'percentage', amount: 0.075 } }).discountAmount,
    ).toBe(7.5);
    const flat = inputsToFormData({}, { discount: { type: 'flat', amount: 150 } });
    expect(flat.discountType).toBe('flat');
    expect(flat.discountAmount).toBe(150);
    expect(flat.discountEnabled).toBe(true);
  });

  it('hydrates old quotes missing newer fields with blank-form defaults', () => {
    // A pre-S5 quote: no customLineItems, no rooflineChoice, no discount.
    const old = {
      santasFootage: 90,
      santasDifficulty: 'medium',
      gingerbreadFootage: 0,
      gingerbreadDifficulty: 'medium',
      winterWonderlandFootage: 0,
      winterWonderlandDifficulty: 'medium',
      miniLightItems: [],
      spritzers: [],
      wreaths: [],
      garland: [],
      takedown: 'included',
      rushFee: false,
    } as unknown as QuoteInputs; // genuinely missing newer fields (stakeLighting, etc.)
    const hydrated = inputsToFormData({ name: 'Bob' }, old);
    expect(hydrated.customLineItems).toEqual([]);
    expect(hydrated.bows).toEqual([]); // pre-#28 quotes have no bows field
    expect('rooflineChoice' in hydrated).toBe(false);
    expect(hydrated.discountEnabled).toBe(false);
    expect(hydrated.santasFootage).toBe(90);
    expect(hydrated.stakeLightingFootage).toBe(0); // newer field → blank-form default
    expect(hydrated.stakeLightingDifficulty).toBe('easy'); // Stake Lighting defaults to Easy
  });

  it('survives null/garbage inputs with the blank form', () => {
    const hydrated = inputsToFormData(null, null);
    expect(hydrated).toEqual(initialFormData);
  });

  it('hydrates serviceType from the passed value, defaulting to holiday', () => {
    expect(inputsToFormData({}, {}, 'permanent').serviceType).toBe('permanent');
    expect(inputsToFormData({}, {}, 'event').serviceType).toBe('event');
    // legacy/uncategorized rows (null or omitted) → holiday
    expect(inputsToFormData({}, {}, null).serviceType).toBe('holiday');
    expect(inputsToFormData({}, {}).serviceType).toBe('holiday');
  });

  it('hydrates waiveMinimum, defaulting to false when absent (#59)', () => {
    expect(inputsToFormData({}, { waiveMinimum: true }).waiveMinimum).toBe(true);
    expect(inputsToFormData({}, { waiveMinimum: false }).waiveMinimum).toBe(false);
    expect(inputsToFormData({}, {}).waiveMinimum).toBe(false); // legacy row
  });

  it('hydrates installTiming and opens "Apply discount" for an early-install quote (#40)', () => {
    const sep = inputsToFormData({}, { installTiming: 'september' });
    expect(sep.installTiming).toBe('september');
    expect(sep.discountEnabled).toBe(true); // the toggle is open so the month shows
    expect(inputsToFormData({}, { installTiming: 'october' }).installTiming).toBe('october');
    const legacy = inputsToFormData({}, {});
    expect(legacy.installTiming).toBe('none');
    expect(legacy.discountEnabled).toBe(false);
  });

  it('round-trips an early-install quote (no manual discount)', () => {
    const form: QuoteFormData = {
      ...fullForm,
      rushFee: false, // early-install clears rush (mutually exclusive)
      discountEnabled: true,
      discountType: 'percentage',
      discountAmount: 0,
      installTiming: 'october',
    };
    const hydrated = inputsToFormData(form.customer, buildQuoteInputs(form), form.serviceType);
    expect(hydrated).toEqual(form);
  });

  it('strips the Anonymous / (no address) sentinels back to blank fields', () => {
    const hydrated = inputsToFormData(
      { name: 'Anonymous', address: '(no address)', phone: null, email: null },
      {},
    );
    expect(hydrated.customer).toEqual({ name: '', address: '', phone: '', email: '' });
    // …but a real customer who happens to have data keeps it.
    const real = inputsToFormData({ name: 'Ann O.', address: '4 Oak Ln' }, {});
    expect(real.customer.name).toBe('Ann O.');
    expect(real.customer.address).toBe('4 Oak Ln');
  });
});
