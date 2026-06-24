import type {
  QuoteInputs,
  RooflineChoice,
  RooflineDifficulty,
  MiniLightItem,
  Spritzer,
  Wreath,
  GarlandItem,
  BowLineInput,
  CustomLineItem,
  Takedown,
} from './pricing/pricingEngine';
import { ServiceType, DEFAULT_SERVICE_TYPE } from './serviceType';

// Mapping between the quote builder's form state and the pricing engine's
// QuoteInputs (task #31). Two directions:
//   buildQuoteInputs  — form → API payload (what Calculate Quote sends)
//   inputsToFormData  — saved quote row → form (hydrating /quote/[id])
// Keeping both in one tested module means the round-trip can't silently drift.

export type FormCustomer = { name: string; address: string; phone: string; email: string };

export type QuoteFormData = {
  customer: FormCustomer;
  // Service line this quote belongs to (#58 Phase 2b). Holiday by default;
  // rides the quotes.service_type column, NOT the pricing inputs jsonb.
  serviceType: ServiceType;
  santasFootage: number;
  santasDifficulty: RooflineDifficulty;
  gingerbreadFootage: number;
  gingerbreadDifficulty: RooflineDifficulty;
  winterWonderlandFootage: number;
  winterWonderlandDifficulty: RooflineDifficulty;
  // Staff's recommended roofline (the portal default). Undefined → the engine
  // auto-picks the option closest to the $1,000 minimum (#17). Set via the
  // breakdown's recommend radios.
  rooflineChoice?: RooflineChoice;
  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];
  // Standalone bows (#28) — flat per-bow price (TBD by Naldo, $0 today).
  bows: BowLineInput[];
  // Custom / manual line items (#27 escape hatch) — off-design items.
  customLineItems: CustomLineItem[];
  takedown: Takedown;
  rushFee: boolean;
  discountEnabled: boolean;
  discountType: 'percentage' | 'flat';
  discountAmount: number;
  // Staff override (#59): waive the $1,000 portal approval gate for this quote
  // (lets the customer approve a selection under $1,000). Rides the inputs jsonb.
  waiveMinimum: boolean;
};

export const initialFormData: QuoteFormData = {
  customer: { name: '', address: '', phone: '', email: '' },
  serviceType: DEFAULT_SERVICE_TYPE,
  santasFootage: 0,
  santasDifficulty: 'medium',
  gingerbreadFootage: 0,
  gingerbreadDifficulty: 'medium',
  winterWonderlandFootage: 0,
  winterWonderlandDifficulty: 'medium',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  bows: [],
  customLineItems: [],
  takedown: 'included',
  rushFee: false,
  discountEnabled: false,
  discountType: 'percentage',
  discountAmount: 0,
  waiveMinimum: false,
};

// Form → engine inputs. `rooflineChoiceOverride` lets the breakdown's staff-pick
// radios re-quote with a specific choice without waiting on the async form-state
// update (#17 Phase 1b).
export function buildQuoteInputs(
  form: QuoteFormData,
  rooflineChoiceOverride?: RooflineChoice,
): QuoteInputs {
  const effectiveRooflineChoice = rooflineChoiceOverride ?? form.rooflineChoice;
  return {
    santasFootage: form.santasFootage,
    santasDifficulty: form.santasDifficulty,
    gingerbreadFootage: form.gingerbreadFootage,
    gingerbreadDifficulty: form.gingerbreadDifficulty,
    winterWonderlandFootage: form.winterWonderlandFootage,
    winterWonderlandDifficulty: form.winterWonderlandDifficulty,
    // Only sent when staff has explicitly recommended one — otherwise the
    // engine auto-picks (closest to the $1,000 minimum).
    ...(effectiveRooflineChoice ? { rooflineChoice: effectiveRooflineChoice } : {}),
    miniLightItems: form.miniLightItems,
    spritzers: form.spritzers,
    wreaths: form.wreaths,
    garland: form.garland,
    bows: form.bows,
    customLineItems: form.customLineItems,
    takedown: form.takedown,
    rushFee: form.rushFee,
    // Only stored when set (#59) — absent in the inputs jsonb means not waived.
    ...(form.waiveMinimum ? { waiveMinimum: true } : {}),
    ...(form.discountEnabled && {
      discount: {
        type: form.discountType,
        // Percentage is entered as a whole number (20 = 20%); the pricing
        // engine wants a fraction. Flat dollars pass through unchanged.
        amount:
          form.discountType === 'percentage'
            ? form.discountAmount / 100
            : form.discountAmount,
      },
    }),
  };
}

// What the quotes table stores for the customer. saveQuote writes sentinel
// placeholders when fields were left blank — strip them back out so editing
// doesn't turn "Anonymous" into a real customer name.
export type StoredCustomer = {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
};

const NAME_SENTINEL = 'Anonymous';
const ADDRESS_SENTINEL = '(no address)';

function customerField(v: string | null | undefined, sentinel?: string): string {
  if (!v) return '';
  return sentinel !== undefined && v === sentinel ? '' : v;
}

// Engine fractions come back with float noise (0.2 stored → ×100 = 20.000…04);
// round to a displayable whole-ish number without losing entered precision.
function fractionToWholePercent(fraction: number): number {
  return Math.round(fraction * 100 * 1e6) / 1e6;
}

// Saved quote row → form state. Defensive about shape: quotes saved before a
// field existed (e.g. customLineItems pre-S5, rooflineChoice pre-#17) hydrate
// with the blank-form default instead of crashing.
export function inputsToFormData(
  customer: StoredCustomer | null | undefined,
  inputs: Partial<QuoteInputs> | null | undefined,
  // service_type rides its own quotes column (not the inputs jsonb), so the
  // edit page passes it separately. Undefined/legacy rows default to holiday.
  serviceType?: ServiceType | null,
): QuoteFormData {
  const i = inputs ?? {};
  const d = i.discount;
  return {
    customer: {
      name: customerField(customer?.name, NAME_SENTINEL),
      address: customerField(customer?.address, ADDRESS_SENTINEL),
      phone: customerField(customer?.phone),
      email: customerField(customer?.email),
    },
    serviceType: serviceType ?? DEFAULT_SERVICE_TYPE,
    santasFootage: i.santasFootage ?? 0,
    santasDifficulty: i.santasDifficulty ?? 'medium',
    gingerbreadFootage: i.gingerbreadFootage ?? 0,
    gingerbreadDifficulty: i.gingerbreadDifficulty ?? 'medium',
    winterWonderlandFootage: i.winterWonderlandFootage ?? 0,
    winterWonderlandDifficulty: i.winterWonderlandDifficulty ?? 'medium',
    ...(i.rooflineChoice ? { rooflineChoice: i.rooflineChoice } : {}),
    miniLightItems: i.miniLightItems ?? [],
    spritzers: i.spritzers ?? [],
    wreaths: i.wreaths ?? [],
    garland: i.garland ?? [],
    bows: i.bows ?? [],
    customLineItems: i.customLineItems ?? [],
    takedown: i.takedown ?? 'included',
    rushFee: i.rushFee ?? false,
    discountEnabled: d != null,
    discountType: d?.type ?? 'percentage',
    discountAmount:
      d == null ? 0 : d.type === 'percentage' ? fractionToWholePercent(d.amount) : d.amount,
    waiveMinimum: i.waiveMinimum ?? false,
  };
}
