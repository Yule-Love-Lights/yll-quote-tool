import { calculateEventQuote } from './event/pricing';
import { moneyTimesRate } from './money';
import { calculatePermanentQuote } from './permanent/pricing';
import { makeDefaultPermanentFields } from './permanent/types';
import { calculatePermanentBistro } from './permanentBistro/pricing';
import {
  BUSINESS_RULES,
  MINI_LIGHT_TYPES,
  calculateQuote,
  type QuoteInputs,
  type QuoteResult,
  type RooflineDifficulty,
} from './pricing/pricingEngine';
import type { ServiceType } from './serviceType';

export type LaborEstimate = {
  budgetedHours: number;
  laborRevenueCents: number;
  ratesArePlaceholder: true;
  unmappedCategories: string[];
};

const MINI_LIGHT_TYPE_SET = new Set<string>(MINI_LIGHT_TYPES);
const SPRITZER_SIZE_SET = new Set<string>(Object.keys(BUSINESS_RULES.spritzerRates));
const WREATH_SIZE_SET = new Set<string>(Object.keys(BUSINESS_RULES.wreathPrices));
const GARLAND_TYPE_SET = new Set<string>(Object.keys(BUSINESS_RULES.garlandPrices));
const GARLAND_LENGTH_SET = new Set<string>(Object.keys(BUSINESS_RULES.garlandPrices.noble));
const DIFFICULTY_SET = new Set<string>(Object.keys(BUSINESS_RULES.rooflineRates));
const PLACEHOLDER = BUSINESS_RULES.laborPlanningPlaceholders;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function integerOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function difficultyOr(value: unknown, fallback: RooflineDifficulty): RooflineDifficulty {
  return typeof value === 'string' && DIFFICULTY_SET.has(value) ? (value as RooflineDifficulty) : fallback;
}

function customRatePatch(key: string, value: unknown): Record<string, number> {
  const rate = positiveNumberOrUndefined(value);
  return rate === undefined ? {} : { [key]: rate };
}

function sanitizeMiniLightItems(value: unknown): QuoteInputs['miniLightItems'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.type !== 'string' || !MINI_LIGHT_TYPE_SET.has(item.type)) return [];
    return [
      {
        type: item.type as (typeof MINI_LIGHT_TYPES)[number],
        wrapStyle: item.wrapStyle === 'trunk' ? 'trunk' : 'canopy',
        stringCount: numberOrZero(item.stringCount),
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(Array.isArray(item.sceneItemIds)
          ? { sceneItemIds: item.sceneItemIds.filter((id): id is string => typeof id === 'string') }
          : {}),
      },
    ];
  });
}

function sanitizeSpritzers(value: unknown): QuoteInputs['spritzers'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.size !== 'string' || !SPRITZER_SIZE_SET.has(item.size)) return [];
    return [
      {
        size: item.size as '16' | '24' | '32',
        quantity: integerOrZero(item.quantity),
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(Array.isArray(item.sceneItemIds)
          ? { sceneItemIds: item.sceneItemIds.filter((id): id is string => typeof id === 'string') }
          : {}),
      },
    ];
  });
}

function sanitizeWreaths(value: unknown): QuoteInputs['wreaths'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.size !== 'string' ||
      !WREATH_SIZE_SET.has(item.size) ||
      (item.tier !== 'bow' && item.tier !== 'fullDecor')
    ) {
      return [];
    }
    return [
      {
        size: item.size as keyof typeof BUSINESS_RULES.wreathPrices,
        tier: item.tier,
        quantity: integerOrZero(item.quantity),
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(Array.isArray(item.sceneItemIds)
          ? { sceneItemIds: item.sceneItemIds.filter((id): id is string => typeof id === 'string') }
          : {}),
      },
    ];
  });
}

function sanitizeGarland(value: unknown): QuoteInputs['garland'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.type !== 'string' ||
      !GARLAND_TYPE_SET.has(item.type) ||
      typeof item.length !== 'string' ||
      !GARLAND_LENGTH_SET.has(item.length) ||
      (item.tier !== 'bow' && item.tier !== 'fullDecor')
    ) {
      return [];
    }
    return [
      {
        type: item.type as keyof typeof BUSINESS_RULES.garlandPrices,
        length: item.length as keyof (typeof BUSINESS_RULES.garlandPrices)['noble'],
        tier: item.tier,
        quantity: integerOrZero(item.quantity),
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(Array.isArray(item.sceneItemIds)
          ? { sceneItemIds: item.sceneItemIds.filter((id): id is string => typeof id === 'string') }
          : {}),
      },
    ];
  });
}

function sanitizeBows(value: unknown): QuoteInputs['bows'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [
      {
        quantity: integerOrZero(item.quantity),
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(Array.isArray(item.sceneItemIds)
          ? { sceneItemIds: item.sceneItemIds.filter((id): id is string => typeof id === 'string') }
          : {}),
      },
    ];
  });
}

function sanitizeCustomLineItems(value: unknown): QuoteInputs['customLineItems'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== 'string' || item.label.trim().length === 0) return [];
    const amount =
      typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount >= 0
        ? item.amount
        : 0;
    return [
      {
        label: item.label.trim(),
        amount,
        ...(typeof item.quantity === 'number' && Number.isFinite(item.quantity) ? { quantity: item.quantity } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
      },
    ];
  });
}

function sanitizeEventBlock(value: unknown): QuoteInputs['event'] | undefined {
  if (!isRecord(value)) return undefined;
  const bistro = Array.isArray(value.bistro)
    ? value.bistro.flatMap((item) => {
        if (!isRecord(item) || numberOrZero(item.footage) === 0) return [];
        return [
          {
            footage: numberOrZero(item.footage),
            ...(typeof item.id === 'string' ? { id: item.id } : {}),
            ...(Array.isArray(item.sceneItemIds)
              ? { sceneItemIds: item.sceneItemIds.filter((id): id is string => typeof id === 'string') }
              : {}),
          },
        ];
      })
    : [];
  const event = {
    ...(integerOrZero(value.barrelBoxes) > 0 ? { barrelBoxes: integerOrZero(value.barrelBoxes) } : {}),
    ...(bistro.length > 0 ? { bistro } : {}),
    ...(typeof value.installDate === 'string' && value.installDate.length > 0 ? { installDate: value.installDate } : {}),
    ...(typeof value.eventDate === 'string' && value.eventDate.length > 0 ? { eventDate: value.eventDate } : {}),
    ...(typeof value.takedownDate === 'string' && value.takedownDate.length > 0 ? { takedownDate: value.takedownDate } : {}),
  };
  return Object.keys(event).length > 0 ? event : undefined;
}

function sanitizePermanentBlock(value: unknown): QuoteInputs['permanent'] | undefined {
  if (!isRecord(value)) return undefined;
  const base = makeDefaultPermanentFields();
  return {
    ...base,
    frontFootage: numberOrZero(value.frontFootage),
    leftFootage: numberOrZero(value.leftFootage),
    rightFootage: numberOrZero(value.rightFootage),
    backFootage: numberOrZero(value.backFootage),
    controllerToFirstLightFt: numberOrZero(value.controllerToFirstLightFt),
    frontCorners: integerOrZero(value.frontCorners),
    leftCorners: integerOrZero(value.leftCorners),
    rightCorners: integerOrZero(value.rightCorners),
    backCorners: integerOrZero(value.backCorners),
    trackStyle: value.trackStyle === 'parapet' ? 'parapet' : 'single',
    trackColor:
      value.trackColor === '9004' || value.trackColor === '9012' || value.trackColor === '8019'
        ? value.trackColor
        : '9003',
    blackHousing: value.blackHousing === true,
    maintenanceAddOn: value.maintenanceAddOn === true,
    ...customRatePatch('frontCustomRate', value.frontCustomRate),
    ...customRatePatch('sidesCustomRate', value.sidesCustomRate),
    ...customRatePatch('backCustomRate', value.backCustomRate),
  };
}

function sanitizePermanentBistroBlock(value: unknown): QuoteInputs['permanentBistro'] | undefined {
  if (!isRecord(value)) return undefined;
  const bistro = Array.isArray(value.bistro)
    ? value.bistro.flatMap((item) => {
        if (!isRecord(item) || numberOrZero(item.footage) === 0) return [];
        return [
          {
            footage: numberOrZero(item.footage),
            ...(typeof item.id === 'string' ? { id: item.id } : {}),
            ...(Array.isArray(item.sceneItemIds)
              ? { sceneItemIds: item.sceneItemIds.filter((id): id is string => typeof id === 'string') }
              : {}),
          },
        ];
      })
    : [];
  const permanentBistro = {
    ...(integerOrZero(value.poles) > 0 ? { poles: integerOrZero(value.poles) } : {}),
    ...(bistro.length > 0 ? { bistro } : {}),
  };
  // Matches sanitizeEventBlock's contract exactly: an empty block is "no
  // saved geometry", not "a real zero-quantity job" — undefined, not {}. `{}`
  // is truthy, so sanitizeQuoteInputs' `permanentBistro === undefined` guard
  // would otherwise let an empty block sail through as a confidently-priced
  // $0/0-hour estimate instead of the intended null (unknown, don't
  // estimate). Caught in the S57 wrap review.
  return Object.keys(permanentBistro).length > 0 ? permanentBistro : undefined;
}

function sanitizeQuoteInputs(serviceType: ServiceType, value: unknown): QuoteInputs | null {
  if (!isRecord(value)) return null;
  const permanent = sanitizePermanentBlock(value.permanent);
  const permanentBistro = sanitizePermanentBistroBlock(value.permanentBistro);
  if (serviceType === 'permanent' && permanent === undefined) return null;
  if (serviceType === 'permanent_bistro' && permanentBistro === undefined) return null;

  const discount =
    isRecord(value.discount) &&
    (value.discount.type === 'percentage' || value.discount.type === 'flat') &&
    typeof value.discount.amount === 'number' &&
    Number.isFinite(value.discount.amount)
      ? { type: value.discount.type as 'percentage' | 'flat', amount: value.discount.amount }
      : undefined;

  return {
    santasFootage: numberOrZero(value.santasFootage),
    santasDifficulty: difficultyOr(value.santasDifficulty, 'medium'),
    ...customRatePatch('santasCustomRate', value.santasCustomRate),
    gingerbreadFootage: numberOrZero(value.gingerbreadFootage),
    gingerbreadDifficulty: difficultyOr(value.gingerbreadDifficulty, 'medium'),
    ...customRatePatch('gingerbreadCustomRate', value.gingerbreadCustomRate),
    winterWonderlandFootage: numberOrZero(value.winterWonderlandFootage),
    winterWonderlandDifficulty: difficultyOr(value.winterWonderlandDifficulty, 'medium'),
    ...customRatePatch('winterWonderlandCustomRate', value.winterWonderlandCustomRate),
    stakeLightingFootage: numberOrZero(value.stakeLightingFootage),
    stakeLightingDifficulty: difficultyOr(value.stakeLightingDifficulty, 'easy'),
    ...customRatePatch('stakeLightingCustomRate', value.stakeLightingCustomRate),
    ...(value.rooflineChoice === 'santas' || value.rooflineChoice === 'gingerbread' || value.rooflineChoice === 'none'
      ? { rooflineChoice: value.rooflineChoice }
      : {}),
    miniLightItems: sanitizeMiniLightItems(value.miniLightItems),
    spritzers: sanitizeSpritzers(value.spritzers),
    wreaths: sanitizeWreaths(value.wreaths),
    garland: sanitizeGarland(value.garland),
    bows: sanitizeBows(value.bows),
    customLineItems: sanitizeCustomLineItems(value.customLineItems),
    takedown: value.takedown === 'premium' ? 'premium' : 'included',
    rushFee: value.rushFee === true,
    ...(discount ? { discount } : {}),
    ...(value.installTiming === 'september' || value.installTiming === 'october'
      ? { installTiming: value.installTiming }
      : {}),
    ...(Number.isInteger(value.depositPercent) ? { depositPercent: value.depositPercent as number } : {}),
    ...(sanitizeEventBlock(value.event) ? { event: sanitizeEventBlock(value.event) } : {}),
    ...(permanent ? { permanent } : {}),
    ...(permanentBistro ? { permanentBistro } : {}),
  };
}

function calculateQuoteResult(serviceType: ServiceType, inputs: QuoteInputs): QuoteResult {
  switch (serviceType) {
    case 'holiday':
      return calculateQuote(inputs);
    case 'event':
      return calculateEventQuote(inputs);
    case 'permanent':
      return calculatePermanentQuote(inputs);
    case 'permanent_bistro':
      return calculatePermanentBistro(inputs);
  }
}

function hoursFromFootage(
  footage: number,
  difficulty: RooflineDifficulty,
  rates: Record<RooflineDifficulty, number>,
): number {
  const safeFootage = numberOrZero(footage);
  return safeFootage > 0 ? safeFootage / rates[difficulty] : 0;
}

function hoursFromQuantity(quantity: number, minutesPerItem: number): number {
  return integerOrZero(quantity) * (minutesPerItem / 60);
}

function roundHours(hours: number): number {
  return Math.round(hours * 100) / 100;
}

function selectedRooflineHours(inputs: QuoteInputs, result: QuoteResult): number {
  if (result.rooflineChoice === 'santas') {
    return hoursFromFootage(
      inputs.santasFootage,
      inputs.santasDifficulty,
      PLACEHOLDER.rooflineFeetPerHour,
    );
  }
  if (result.rooflineChoice === 'gingerbread') {
    return (
      hoursFromFootage(inputs.santasFootage, inputs.santasDifficulty, PLACEHOLDER.rooflineFeetPerHour) +
      hoursFromFootage(
        inputs.gingerbreadFootage,
        inputs.gingerbreadDifficulty,
        PLACEHOLDER.rooflineFeetPerHour,
      )
    );
  }
  return 0;
}

export function estimateLaborForQuote(
  serviceType: ServiceType,
  rawInputs: unknown,
): LaborEstimate | null {
  const inputs = sanitizeQuoteInputs(serviceType, rawInputs);
  if (!inputs) return null;

  try {
    const result = calculateQuoteResult(serviceType, inputs);
    const unmappedCategories = new Set<string>();
    let budgetedHours = 0;

    budgetedHours += selectedRooflineHours(inputs, result);
    budgetedHours += hoursFromFootage(
      inputs.winterWonderlandFootage,
      inputs.winterWonderlandDifficulty,
      PLACEHOLDER.rooflineFeetPerHour,
    );
    budgetedHours += hoursFromFootage(
      inputs.stakeLightingFootage,
      inputs.stakeLightingDifficulty,
      PLACEHOLDER.stakeLightingFeetPerHour,
    );

    budgetedHours += inputs.miniLightItems.length * (PLACEHOLDER.perItemMinutes.miniLights / 60);
    budgetedHours += hoursFromQuantity(
      inputs.spritzers.reduce((sum, item) => sum + integerOrZero(item.quantity), 0),
      PLACEHOLDER.perItemMinutes.spritzers,
    );
    budgetedHours += hoursFromQuantity(
      inputs.wreaths.reduce((sum, item) => sum + integerOrZero(item.quantity), 0),
      PLACEHOLDER.perItemMinutes.wreaths,
    );
    budgetedHours += hoursFromQuantity(
      inputs.garland.reduce((sum, item) => sum + integerOrZero(item.quantity), 0),
      PLACEHOLDER.perItemMinutes.garland,
    );

    if (serviceType === 'event') {
      budgetedHours += (inputs.event?.bistro?.length ?? 0) * (PLACEHOLDER.perItemMinutes.bistroRuns / 60);
      const barrelBoxes = integerOrZero(inputs.event?.barrelBoxes);
      if (barrelBoxes > 0) {
        unmappedCategories.add('event.barrelBoxes');
        budgetedHours += hoursFromQuantity(barrelBoxes, PLACEHOLDER.defaultUnmappedMinutes);
      }
    }

    if (serviceType === 'permanent') {
      const permanent = inputs.permanent!;
      budgetedHours +=
        (numberOrZero(permanent.frontFootage) +
          numberOrZero(permanent.leftFootage) +
          numberOrZero(permanent.rightFootage) +
          numberOrZero(permanent.backFootage)) /
        PLACEHOLDER.permanentLightingFeetPerHour;
    }

    if (serviceType === 'permanent_bistro') {
      budgetedHours +=
        (inputs.permanentBistro?.bistro?.length ?? 0) * (PLACEHOLDER.perItemMinutes.bistroRuns / 60);
      const poles = integerOrZero(inputs.permanentBistro?.poles);
      if (poles > 0) {
        unmappedCategories.add('permanentBistro.poles');
        budgetedHours += hoursFromQuantity(poles, PLACEHOLDER.defaultUnmappedMinutes);
      }
    }

    const bows = (inputs.bows ?? []).reduce((sum, item) => sum + integerOrZero(item.quantity), 0);
    if (bows > 0) {
      unmappedCategories.add('bows');
      budgetedHours += hoursFromQuantity(bows, PLACEHOLDER.defaultUnmappedMinutes);
    }

    const customLineItems = (inputs.customLineItems ?? []).reduce((sum, item) => {
      const quantity =
        typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity >= 1
          ? Math.floor(item.quantity)
          : 1;
      return sum + quantity;
    }, 0);
    if (customLineItems > 0) {
      unmappedCategories.add('customLineItems');
      budgetedHours += hoursFromQuantity(customLineItems, PLACEHOLDER.defaultUnmappedMinutes);
    }

    // moneyTimesRate is this repo's one shared amount-times-rate helper (used by
    // pricingEngine.ts itself) — it converts to integer cents/millionths before
    // multiplying so a binary-float rounding edge can't move an exact half-cent
    // below the boundary. Reusing it here keeps labor_revenue_cents on the same
    // rounding rule as every other money figure in this codebase, rather than a
    // third slightly-different inline variant.
    const laborRevenueUsd = moneyTimesRate(result.taxableAmount, PLACEHOLDER.laborRevenuePercentage);

    return {
      budgetedHours: roundHours(budgetedHours),
      laborRevenueCents: Math.round(laborRevenueUsd * 100),
      ratesArePlaceholder: true,
      unmappedCategories: [...unmappedCategories],
    };
  } catch {
    return null;
  }
}
