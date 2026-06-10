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
  santasFootage: 120,
  santasDifficulty: 'hard',
  gingerbreadFootage: 80,
  gingerbreadDifficulty: 'easy',
  winterWonderlandFootage: 40,
  winterWonderlandDifficulty: 'medium',
  rooflineChoice: 'gingerbread',
  miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 3 }],
  spritzers: [{ size: '24', quantity: 2 }],
  wreaths: [{ size: '30noble', tier: 'fullDecor', quantity: 1 }],
  garland: [{ length: '9ft', type: 'noble', tier: 'labor', quantity: 2 }],
  bows: [{ quantity: 2 }],
  customLineItems: [{ label: 'Flagpole wrap', amount: 95, quantity: 2 }],
  takedown: 'premium',
  rushFee: true,
  discountEnabled: true,
  discountType: 'percentage',
  discountAmount: 20,
};

describe('buildQuoteInputs', () => {
  it('builds the full payload, converting percentage to a fraction', () => {
    const inputs = buildQuoteInputs(fullForm);
    expect(inputs.santasFootage).toBe(120);
    expect(inputs.rooflineChoice).toBe('gingerbread');
    expect(inputs.discount).toEqual({ type: 'percentage', amount: 0.2 });
    expect(inputs.customLineItems).toEqual(fullForm.customLineItems);
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
});

describe('inputsToFormData', () => {
  it('round-trips a fully-populated form', () => {
    const inputs = buildQuoteInputs(fullForm);
    const hydrated = inputsToFormData(fullForm.customer, inputs);
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
    const hydrated = inputsToFormData(form.customer, buildQuoteInputs(form));
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
    } as QuoteInputs;
    const hydrated = inputsToFormData({ name: 'Bob' }, old);
    expect(hydrated.customLineItems).toEqual([]);
    expect(hydrated.bows).toEqual([]); // pre-#28 quotes have no bows field
    expect('rooflineChoice' in hydrated).toBe(false);
    expect(hydrated.discountEnabled).toBe(false);
    expect(hydrated.santasFootage).toBe(90);
  });

  it('survives null/garbage inputs with the blank form', () => {
    const hydrated = inputsToFormData(null, null);
    expect(hydrated).toEqual(initialFormData);
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
