import { describe, it, expect } from 'vitest';
import {
  QuoteFormData,
  initialFormData,
  buildQuoteInputs,
  inputsToFormData,
  applyPrefill,
  resolveTagPayload,
  resolveNceDepositPercent,
} from './quoteForm';
import type { QuoteInputs } from './pricing/pricingEngine';
import { makeDefaultPermanentFields } from './permanent/types';
import { calculatePermanentBistro } from './permanentBistro/pricing';

const VALID = ['easy', 'medium', 'hard'];

// A fully-populated form, exercising every mapped field.
const fullForm: QuoteFormData = {
  customer: { name: 'Jane Doe', address: '12 Elm St', phone: '555-0101', email: 'jane@x.com' },
  serviceType: 'event', // non-default, to exercise the field
  santasFootage: 120,
  santasDifficulty: 'hard',
  santasCustomRate: 0,
  gingerbreadFootage: 80,
  gingerbreadDifficulty: 'easy',
  gingerbreadCustomRate: 0,
  winterWonderlandFootage: 40,
  winterWonderlandDifficulty: 'medium',
  winterWonderlandCustomRate: 0,
  stakeLightingFootage: 60,
  stakeLightingDifficulty: 'hard',
  stakeLightingCustomRate: 0,
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
  depositPercent: 25, // non-default, to exercise the field (#177)
  installTiming: 'none', // manual-discount path; early-install has its own tests
  lineItemPriceOverrides: {},
  winterWonderlandRecommended: false,
  stakeLightingRecommended: false,
  event: { barrelBoxes: 3, installDate: '2026-07-11', eventDate: '2026-07-18', takedownDate: '2026-07-31' },
  permanent: makeDefaultPermanentFields(),
  referralCredit: null,
  // #117: permanentBistro grew a `bistro` array (satellite-derived footage) —
  // [] here so the pre-existing full-payload assertions are unaffected.
  permanentBistro: { poles: 0, bistro: [] },
  highlevelContactId: null,
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

  it('sends the permanent block ONLY for a permanent quote (#88)', () => {
    const perm = {
      ...fullForm,
      serviceType: 'permanent' as const,
      permanent: { ...makeDefaultPermanentFields(), frontFootage: 120, leftFootage: 40 },
    };
    expect(buildQuoteInputs(perm).permanent).toEqual(perm.permanent);
    // holiday / event never carry it
    expect('permanent' in buildQuoteInputs({ ...fullForm, serviceType: 'holiday' })).toBe(false);
    expect('permanent' in buildQuoteInputs({ ...fullForm, serviceType: 'event' })).toBe(false);
  });

  it('round-trips the permanent block through inputs → form (#88)', () => {
    const perm = {
      ...fullForm,
      serviceType: 'permanent' as const,
      permanent: {
        ...makeDefaultPermanentFields(),
        frontFootage: 120,
        rightFootage: 55,
        frontCorners: 6,
        trackStyle: 'parapet' as const,
        trackColor: '9004' as const,
        blackHousing: true,
      },
    };
    const restored = inputsToFormData(perm.customer, buildQuoteInputs(perm), 'permanent');
    expect(restored.permanent).toEqual(perm.permanent);
  });

  it('#192 — round-trips a SET trackStyleBySide map through inputs → form', () => {
    const perm = {
      ...fullForm,
      serviceType: 'permanent' as const,
      permanent: {
        ...makeDefaultPermanentFields(),
        frontFootage: 40,
        backFootage: 40,
        trackStyle: 'single' as const, // legacy scalar untouched
        trackStyleBySide: { front: 'parapet' as const, back: 'parapet' as const },
      },
    };
    const restored = inputsToFormData(perm.customer, buildQuoteInputs(perm), 'permanent');
    expect(restored.permanent).toEqual(perm.permanent);
    expect(restored.permanent.trackStyleBySide).toEqual({ front: 'parapet', back: 'parapet' });
    expect(restored.permanent.trackStyle).toBe('single');
  });

  it('hydrates a fresh blank permanent block for a holiday quote (factory, fresh gaps)', () => {
    const a = inputsToFormData(fullForm.customer, buildQuoteInputs(fullForm), 'holiday');
    const b = inputsToFormData(fullForm.customer, buildQuoteInputs(fullForm), 'holiday');
    expect(a.permanent).toEqual(makeDefaultPermanentFields());
    expect(a.permanent.gaps).not.toBe(b.permanent.gaps); // separate arrays, no sharing
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

  it('sends depositPercent only when set (> 0); omits it when blank (#177)', () => {
    expect(buildQuoteInputs({ ...fullForm, depositPercent: 25 }).depositPercent).toBe(25);
    expect('depositPercent' in buildQuoteInputs({ ...fullForm, depositPercent: 0 })).toBe(false);
  });

  it('sends a custom $/ft per item-type and a valid placeholder difficulty (#102)', () => {
    const inputs = buildQuoteInputs({
      ...fullForm,
      santasDifficulty: 'custom', santasCustomRate: 5,
      stakeLightingDifficulty: 'custom', stakeLightingCustomRate: 4,
    });
    expect(inputs.santasCustomRate).toBe(5);
    expect(VALID.includes(inputs.santasDifficulty)).toBe(true); // wire difficulty stays valid
    expect(inputs.stakeLightingCustomRate).toBe(4);
    // preset types send no custom rate key
    expect('gingerbreadCustomRate' in inputs).toBe(false);
    expect('winterWonderlandCustomRate' in inputs).toBe(false);
  });

  it('omits the custom rate key for preset difficulties (#102)', () => {
    const inputs = buildQuoteInputs(fullForm); // all four on presets, rates 0
    expect('santasCustomRate' in inputs).toBe(false);
    expect('stakeLightingCustomRate' in inputs).toBe(false);
  });

  it('degrades a custom choice with a non-positive rate to the preset (#102)', () => {
    const inputs = buildQuoteInputs({ ...fullForm, santasDifficulty: 'custom', santasCustomRate: 0 });
    expect('santasCustomRate' in inputs).toBe(false); // no rate sent
    expect(VALID.includes(inputs.santasDifficulty)).toBe(true); // a real preset, not 'custom'
  });

  it('is idempotent across the real edit loop: stored inputs → form → inputs → form (#102)', () => {
    // The PERSISTED wire shape (placeholder difficulty + customRate, NO 'custom').
    const stored = { ...buildQuoteInputs(fullForm), santasDifficulty: 'medium' as const, santasCustomRate: 5 };
    const form1 = inputsToFormData(fullForm.customer, stored, fullForm.serviceType);
    expect(form1.santasDifficulty).toBe('custom');
    expect(form1.santasCustomRate).toBe(5);
    // re-Calculate → re-open: the dropdown + rate must be stable.
    const form2 = inputsToFormData(fullForm.customer, buildQuoteInputs(form1), fullForm.serviceType);
    expect(form2.santasDifficulty).toBe('custom');
    expect(form2.santasCustomRate).toBe(5);
    // a non-positive raw rate hydrates back to the preset, never 'custom'.
    const lowForm = inputsToFormData({}, { santasDifficulty: 'hard', santasCustomRate: 0 });
    expect(lowForm.santasDifficulty).toBe('hard');
  });

  it('round-trips a custom $/ft through inputs → form (#102)', () => {
    const form = {
      ...fullForm,
      santasDifficulty: 'custom' as const, santasCustomRate: 5,
      winterWonderlandDifficulty: 'custom' as const, winterWonderlandCustomRate: 12,
    };
    const restored = inputsToFormData(form.customer, buildQuoteInputs(form), form.serviceType);
    expect(restored.santasDifficulty).toBe('custom');
    expect(restored.santasCustomRate).toBe(5);
    expect(restored.winterWonderlandDifficulty).toBe('custom');
    expect(restored.winterWonderlandCustomRate).toBe(12);
    // untouched types stay on their presets
    expect(restored.stakeLightingDifficulty).toBe('hard');
  });

  it('round-trips lineItemPriceOverrides; omits the key when empty (#104)', () => {
    const ov = { 'spritzer-a': { amount: 0, reason: 'comp' }, 'roofline-santas': { amount: 600 } };
    const inputs = buildQuoteInputs({ ...fullForm, lineItemPriceOverrides: ov });
    expect(inputs.lineItemPriceOverrides).toEqual(ov);
    expect('lineItemPriceOverrides' in buildQuoteInputs(fullForm)).toBe(false); // empty {} → omitted
    const restored = inputsToFormData(fullForm.customer, inputs, fullForm.serviceType);
    expect(restored.lineItemPriceOverrides).toEqual(ov);
  });

  it('sends WW/Stake recommend flags only when set; hydrates them back (#12)', () => {
    const on = buildQuoteInputs({ ...fullForm, winterWonderlandRecommended: true, stakeLightingRecommended: true });
    expect(on.winterWonderlandRecommended).toBe(true);
    expect(on.stakeLightingRecommended).toBe(true);
    const off = buildQuoteInputs(fullForm);
    expect('winterWonderlandRecommended' in off).toBe(false);
    expect('stakeLightingRecommended' in off).toBe(false);
    const restored = inputsToFormData(fullForm.customer, on, fullForm.serviceType);
    expect(restored.winterWonderlandRecommended).toBe(true);
    expect(inputsToFormData({}, {}).stakeLightingRecommended).toBe(false); // legacy default
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

  it('sends referralCredit provenance only when applied; round-trips it (#41 PR2)', () => {
    const withCredit = { ...fullForm, referralCredit: { amount: 125, consumedRowIds: ['r1', 'r2'] } };
    const inputs = buildQuoteInputs(withCredit);
    expect(inputs.referralCredit).toEqual({ amount: 125, consumedRowIds: ['r1', 'r2'] });
    expect('referralCredit' in buildQuoteInputs(fullForm)).toBe(false); // null → omitted
    const restored = inputsToFormData(withCredit.customer, inputs, withCredit.serviceType);
    expect(restored.referralCredit).toEqual({ amount: 125, consumedRowIds: ['r1', 'r2'] });
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

  it('hydrates depositPercent, defaulting to 0 (blank) when absent (#177)', () => {
    expect(inputsToFormData({}, { depositPercent: 25 }).depositPercent).toBe(25);
    expect(inputsToFormData({}, {}).depositPercent).toBe(0); // legacy row
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

describe('applyPrefill (#leads Create-quote link)', () => {
  it('returns base unchanged when no prefill is given', () => {
    expect(applyPrefill(initialFormData, undefined)).toEqual(initialFormData);
  });

  it('seeds customer fields and a valid serviceType', () => {
    const result = applyPrefill(initialFormData, {
      name: 'Ann O.',
      email: 'ann@example.com',
      phone: '555-0100',
      address: '4 Oak Ln',
      serviceType: 'permanent',
    });
    expect(result.customer).toEqual({
      name: 'Ann O.',
      email: 'ann@example.com',
      phone: '555-0100',
      address: '4 Oak Ln',
    });
    expect(result.serviceType).toBe('permanent');
  });

  it('ignores an unrecognized serviceType, keeping the base default', () => {
    const result = applyPrefill(initialFormData, { serviceType: 'not-a-real-type' });
    expect(result.serviceType).toBe(initialFormData.serviceType);
  });

  it('ignores blank/whitespace-only fields, keeping the base value', () => {
    const result = applyPrefill(initialFormData, { name: '   ', email: undefined });
    expect(result.customer.name).toBe(initialFormData.customer.name);
    expect(result.customer.email).toBe(initialFormData.customer.email);
  });

  it('only touches customer + serviceType, leaving every other field alone', () => {
    const result = applyPrefill(initialFormData, { name: 'Bob' });
    expect({ ...result, customer: initialFormData.customer }).toEqual(initialFormData);
  });

  it('seeds highlevelContactId from a prefill ghlContactId', () => {
    const result = applyPrefill(initialFormData, { ghlContactId: 'ghl-contact-123' });
    expect(result.highlevelContactId).toBe('ghl-contact-123');
  });

  it('trims a whitespace-padded ghlContactId', () => {
    const result = applyPrefill(initialFormData, { ghlContactId: '  ghl-contact-123  ' });
    expect(result.highlevelContactId).toBe('ghl-contact-123');
  });

  it('ignores a blank/whitespace-only ghlContactId, keeping highlevelContactId null', () => {
    const result = applyPrefill(initialFormData, { ghlContactId: '   ' });
    expect(result.highlevelContactId).toBeNull();
  });

  it('leaves highlevelContactId null when no ghlContactId is given', () => {
    const result = applyPrefill(initialFormData, { name: 'Bob' });
    expect(result.highlevelContactId).toBeNull();
  });
});

// Review fix (staff HIGH + tech MED, S34 #198 review; INSERT/UPDATE split
// added in round 2 — a coordinator-caught bug in round 1's own instruction):
// resolveTagPayload is the ONE shared mechanism both /api/quote call sites
// in QuoteBuilder use (the main Calculate/Save via runQuote, and the
// roofline-recommend re-price) — see its own doc comment for the full
// insert-vs-update rationale. Pure-function coverage here stands in for a
// full component render test (QuoteBuilder has no test harness — see
// AGENTS.md convention); grep confirms both call sites spread this same
// function's return value, each deriving mode fresh from its own quoteId.
describe('resolveTagPayload (#198 review — touched-ref tag chips)', () => {
  describe("mode: 'update' (a quoteId already exists)", () => {
    it('sends undefined for BOTH tags when neither chip was touched (untouched reopen save → no tag write, unchanged)', () => {
      expect(resolveTagPayload(true, false, true, false, 'update')).toEqual({
        legacyRebook: undefined,
        isNce: undefined,
      });
      expect(resolveTagPayload(false, false, false, false, 'update')).toEqual({
        legacyRebook: undefined,
        isNce: undefined,
      });
    });

    it('sends the current value for BOTH tags when both were touched (unchanged)', () => {
      expect(resolveTagPayload(true, true, true, true, 'update')).toEqual({ legacyRebook: true, isNce: true });
      expect(resolveTagPayload(false, true, false, true, 'update')).toEqual({ legacyRebook: false, isNce: false });
    });

    it('resolves each chip independently — touching one never sends the other', () => {
      // legacyRebook touched (now true), isNce untouched (stays whatever it is, unsent)
      expect(resolveTagPayload(true, true, true, false, 'update')).toEqual({ legacyRebook: true, isNce: undefined });
      // isNce touched (now false), legacyRebook untouched
      expect(resolveTagPayload(true, false, false, true, 'update')).toEqual({ legacyRebook: undefined, isNce: false });
    });

    it('a touched chip sends its value even when toggled back to its original/default state', () => {
      // Staff clicked NCE on then off again — still counts as touched, and the
      // explicit `false` must reach the server (matters for an already-tagged
      // customer/quote where "off" is a real, deliberate untag).
      expect(resolveTagPayload(false, false, false, true, 'update')).toEqual({ legacyRebook: undefined, isNce: false });
    });
  });

  describe("mode: 'insert' (no quoteId yet — this save creates the row)", () => {
    it('sends true for an UNTOUCHED but inherited true chip — it persists on the very first save', () => {
      // The whole point of the round-2 fix: a lead-prefilled or pick-inherited
      // tag the staff never manually clicked must still land on the brand-new
      // quote — inheriting the tag by default is the feature's core ask.
      expect(resolveTagPayload(true, false, true, false, 'insert')).toEqual({ legacyRebook: true, isNce: true });
    });

    it('sends false for an untouched, never-inherited chip — the ordinary untagged case', () => {
      expect(resolveTagPayload(false, false, false, false, 'insert')).toEqual({ legacyRebook: false, isNce: false });
    });

    it('sends the current value regardless of touched — there is no existing row to protect', () => {
      expect(resolveTagPayload(true, true, true, true, 'insert')).toEqual({ legacyRebook: true, isNce: true });
      expect(resolveTagPayload(false, true, false, true, 'insert')).toEqual({ legacyRebook: false, isNce: false });
    });

    it('resolves each chip independently on insert too', () => {
      expect(resolveTagPayload(true, false, false, false, 'insert')).toEqual({ legacyRebook: true, isNce: false });
    });
  });
});

// #199: resolveNceDepositPercent is the ONE rule the builder's applyIsNce
// helper (both the chip click and contact-pick inheritance) funnels through,
// mirroring resolveTagPayload's pure-function-stands-in-for-a-render-test
// convention above.
//
// wasRuleSet (wrap-review F4 fix): a bare `current === 40` can't tell "the 40
// THIS rule set" apart from "a 40 staff typed for an unrelated negotiated
// deposit" — the exact colliding value this rule itself writes. Every OFF
// case below is now parameterized on it.
describe('resolveNceDepositPercent (#199 NCE 40% deposit default)', () => {
  it('sets 40 when turning ON from blank (0)', () => {
    expect(resolveNceDepositPercent(0, true, false, false)).toBe(40);
  });

  it('sets 40 when turning ON, overwriting whatever was there before', () => {
    expect(resolveNceDepositPercent(25, true, false, false)).toBe(40);
    expect(resolveNceDepositPercent(50, true, false, false)).toBe(40);
  });

  it('reverts a 40 THIS RULE set (wasRuleSet=true) back to 0 (blank) when turning OFF', () => {
    expect(resolveNceDepositPercent(40, false, false, true)).toBe(0);
  });

  // #199 F4 (wrap-review): the exact colliding-value case a bare `current
  // === 40` check couldn't distinguish — a staff-typed 40 that has NOTHING
  // to do with the NCE rule (e.g. an unrelated negotiated deposit) must
  // survive turning the chip OFF (or a no-op contact-pick re-confirmation
  // upstream, which the caller now short-circuits before ever reaching here).
  it('leaves a HAND-TYPED 40 alone when turning OFF (wasRuleSet=false — the collision case)', () => {
    expect(resolveNceDepositPercent(40, false, false, false)).toBe(40);
  });

  it('leaves any other staff hand-set value alone when turning OFF, regardless of wasRuleSet', () => {
    expect(resolveNceDepositPercent(25, false, false, true)).toBe(25);
    expect(resolveNceDepositPercent(0, false, false, true)).toBe(0);
    expect(resolveNceDepositPercent(25, false, false, false)).toBe(25);
  });

  it('never changes anything once locked (#177 freeze), regardless of direction or wasRuleSet', () => {
    expect(resolveNceDepositPercent(0, true, true, false)).toBe(0);
    expect(resolveNceDepositPercent(40, false, true, true)).toBe(40);
    expect(resolveNceDepositPercent(25, true, true, false)).toBe(25);
  });
});

describe('event inputs (#96)', () => {
  it('builds inputs.event for an event quote', () => {
    expect(buildQuoteInputs(fullForm).event).toEqual({
      barrelBoxes: 3,
      installDate: '2026-07-11',
      eventDate: '2026-07-18',
      takedownDate: '2026-07-31',
    });
  });

  it('does NOT emit inputs.event for a holiday quote', () => {
    expect('event' in buildQuoteInputs({ ...fullForm, serviceType: 'holiday' })).toBe(false);
  });

  it('omits the event block entirely when every event field is empty', () => {
    const inputs = buildQuoteInputs({
      ...fullForm,
      event: { barrelBoxes: 0, installDate: '', eventDate: '', takedownDate: '' },
    });
    expect('event' in inputs).toBe(false);
  });

  it('round-trips the event block through inputsToFormData', () => {
    const restored = inputsToFormData(fullForm.customer, buildQuoteInputs(fullForm), 'event');
    expect(restored.event).toEqual(fullForm.event);
  });

  it('a legacy/non-event row hydrates a blank event block', () => {
    expect(inputsToFormData(null, {}).event).toEqual({
      barrelBoxes: 0,
      installDate: '',
      eventDate: '',
      takedownDate: '',
    });
  });
});

describe('permanentBistro inputs (#117)', () => {
  const bistroForm: QuoteFormData = {
    ...fullForm,
    serviceType: 'permanent_bistro',
    permanentBistro: { poles: 4, bistro: [] },
  };

  it('builds inputs.permanentBistro (poles only) for a permanent_bistro quote', () => {
    expect(buildQuoteInputs(bistroForm).permanentBistro).toEqual({ poles: 4 });
  });

  it('does NOT emit inputs.permanentBistro for a holiday quote', () => {
    expect('permanentBistro' in buildQuoteInputs({ ...fullForm, serviceType: 'holiday' })).toBe(false);
  });

  it('omits the permanentBistro block entirely when poles is 0 and no bistro runs', () => {
    const inputs = buildQuoteInputs({ ...bistroForm, permanentBistro: { poles: 0, bistro: [] } });
    expect('permanentBistro' in inputs).toBe(false);
  });

  it('round-trips the poles-only permanentBistro block through inputsToFormData', () => {
    const restored = inputsToFormData(bistroForm.customer, buildQuoteInputs(bistroForm), 'permanent_bistro');
    expect(restored.permanentBistro).toEqual(bistroForm.permanentBistro);
  });

  it('a legacy/non-bistro row hydrates a blank permanentBistro block', () => {
    expect(inputsToFormData(null, {}).permanentBistro).toEqual({ poles: 0, bistro: [] });
  });

  // #117: satellite-derived bistro runs (form.permanentBistro.bistro) — the
  // billing source, replacing the old design-projected footage.
  describe('bistro runs (satellite-derived footage, #117)', () => {
    const withRuns: QuoteFormData = {
      ...bistroForm,
      permanentBistro: { poles: 2, bistro: [{ footage: 45 }, { footage: 30 }] },
    };

    it('sends only positive-footage bistro entries', () => {
      const inputs = buildQuoteInputs(withRuns);
      expect(inputs.permanentBistro).toEqual({
        poles: 2,
        bistro: [{ footage: 45 }, { footage: 30 }],
      });
    });

    it('drops zero/negative-footage entries but keeps the block for the rest', () => {
      const form = {
        ...withRuns,
        permanentBistro: { poles: 0, bistro: [{ footage: 45 }, { footage: 0 }, { footage: -5 }] },
      };
      expect(buildQuoteInputs(form).permanentBistro).toEqual({ bistro: [{ footage: 45 }] });
    });

    it('omits the permanentBistro block when poles is 0 AND every run is 0-footage', () => {
      const form = { ...withRuns, permanentBistro: { poles: 0, bistro: [{ footage: 0 }] } };
      expect('permanentBistro' in buildQuoteInputs(form)).toBe(false);
    });

    it('round-trips bistro runs (footage only) through inputsToFormData', () => {
      const restored = inputsToFormData(withRuns.customer, buildQuoteInputs(withRuns), 'permanent_bistro');
      expect(restored.permanentBistro).toEqual({
        poles: 2,
        bistro: [{ footage: 45 }, { footage: 30 }],
      });
    });

    it('a stored bistro entry keeps its stable id on hydrate (drops only sceneItemIds)', () => {
      // #117 MED: the run id must survive reopen so a #104 per-line override
      // stays attached to the right run after a reopen+edit. sceneItemIds are
      // not form-relevant (bistro is off the design projection) so they drop.
      const restored = inputsToFormData(null, {
        permanentBistro: { poles: 1, bistro: [{ footage: 12, id: 'run-x1', sceneItemIds: ['x1'] }] },
      });
      expect(restored.permanentBistro).toEqual({ poles: 1, bistro: [{ footage: 12, id: 'run-x1' }] });
    });

    it('threads a run stable id through build -> engine so it survives a mid-list delete (#117 MED)', () => {
      // Two runs with stable ids; the engine keys the billed line on the id,
      // not position, so deleting the FIRST run leaves the survivor id intact.
      const twoRuns: QuoteFormData = {
        ...bistroForm,
        permanentBistro: { poles: 0, bistro: [{ footage: 45, id: 'A' }, { footage: 30, id: 'B' }] },
      };
      expect(buildQuoteInputs(twoRuns).permanentBistro).toEqual({
        bistro: [{ footage: 45, id: 'A' }, { footage: 30, id: 'B' }],
      });
      // After the operator deletes run A, only B remains — its id does NOT
      // re-index to a positional 'permanent-bistro-0'.
      const afterDelete: QuoteFormData = {
        ...bistroForm,
        permanentBistro: { poles: 0, bistro: [{ footage: 30, id: 'B' }] },
      };
      const inputs = buildQuoteInputs(afterDelete);
      const result = calculatePermanentBistro(inputs);
      const line = result.lineItems.find((l) => l.label.includes('Bistro'));
      expect(line?.id).toBe('B');
    });
  });
});
