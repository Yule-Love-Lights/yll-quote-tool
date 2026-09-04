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
  EarlyInstallTiming,
} from './pricing/pricingEngine';
import { ServiceType, DEFAULT_SERVICE_TYPE, asServiceType, canCarryNceOrYllNeighborTag } from './serviceType';
import type { EventInputFields } from './event/types';
import { type PermanentQuoteFields, makeDefaultPermanentFields } from './permanent/types';
import type { PermanentBistroInputFields } from './permanentBistro/types';
import { NCE_DEPOSIT_PERCENT, BUSINESS_RULES } from '@/lib/pricing/pricingEngine';

// Mapping between the quote builder's form state and the pricing engine's
// QuoteInputs (task #31). Two directions:
//   buildQuoteInputs  — form → API payload (what Calculate Quote sends)
//   inputsToFormData  — saved quote row → form (hydrating /quote/[id])
// Keeping both in one tested module means the round-trip can't silently drift.

export type FormCustomer = { name: string; address: string; phone: string; email: string };

// #102: the difficulty dropdown gains a 4th choice, 'custom', which reveals a
// numeric $/ft field (the *CustomRate fields below). On the wire the difficulty
// stays a valid RooflineDifficulty (engine ignores it once a positive custom
// rate is present) — see buildQuoteInputs/toWireRate. Form-state only.
export type DifficultyChoice = RooflineDifficulty | 'custom';

export type QuoteFormData = {
  customer: FormCustomer;
  // Service line this quote belongs to (#58 Phase 2b). Holiday by default;
  // rides the quotes.service_type column, NOT the pricing inputs jsonb.
  serviceType: ServiceType;
  santasFootage: number;
  santasDifficulty: DifficultyChoice;
  // Per-quote custom $/ft (#102), used only when the matching difficulty is
  // 'custom'. 0 = none (the dropdown sits on a preset). Per item-type.
  santasCustomRate: number;
  gingerbreadFootage: number;
  gingerbreadDifficulty: DifficultyChoice;
  gingerbreadCustomRate: number;
  winterWonderlandFootage: number;
  winterWonderlandDifficulty: DifficultyChoice;
  winterWonderlandCustomRate: number;
  stakeLightingFootage: number;
  stakeLightingDifficulty: DifficultyChoice;
  stakeLightingCustomRate: number;
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
  // Staff switch: hide the portal's free-spritzer thank you on this quote,
  // whatever the line-item labels say (set from the admin quote page, POST
  // /api/quotes/[id]/spritzer-notice). Carried here for the SAME reason
  // waiveMinimum is: buildQuoteInputs below rebuilds the inputs jsonb from
  // this form and REPLACES the stored object, so a flag the form does not
  // carry is silently dropped by the next Calculate. There is no builder
  // control for it — the field exists purely so the round trip preserves it.
  suppressFreeSpritzerNotice: boolean;
  // Per-quote deposit override (#177): staff-set integer percent (1-100) of the
  // total, due at approval. 0 = blank/unset (the input's placeholder shows 50);
  // only sent to the engine when > 0 (see buildQuoteInputs). Rides inputs jsonb.
  depositPercent: number;
  // Early-install promo (#40) staff pick: 'none' | 'september' (15%) | 'october'
  // (10%). Drives the engine discount + seeds the customer's portal timing.
  installTiming: EarlyInstallTiming;
  // #104: per-quote line-item TOTAL overrides, keyed by stable line id. Edited via
  // the breakdown's click-to-edit price; `{}` = none. Rides the inputs jsonb.
  lineItemPriceOverrides: Record<string, { amount: number; reason?: string }>;
  // item-numbering-rename: per-quote staff RENAME of a mini/spritzer/wreath/
  // garland/bow line's default (auto-numbered) label, keyed by the SAME
  // stable line id as lineItemPriceOverrides above. Edited via the
  // breakdown's inline rename control; `{}` = none. Rides the inputs jsonb.
  labelOverrides: Record<string, string>;
  // Staff "recommend" flags (#12) for the manual-footage Winter Wonderland + Stake
  // lines (no scene item to hold the flag). Toggled on the breakdown; ride inputs.
  winterWonderlandRecommended: boolean;
  stakeLightingRecommended: boolean;
  // Event Lighting (#96) — event-only inputs, edited only when serviceType==='event'.
  // Barrel/box supports + the 3 staff-entered dates; maps to inputs.event. Bistro
  // footage is design-driven (projected from the drawn scene), not typed here.
  event: {
    barrelBoxes: number;
    installDate: string;
    eventDate: string;
    takedownDate: string;
  };
  // Permanent Lighting (#88). Populated by PermanentSection when serviceType is
  // 'permanent'; only sent to the engine (via buildQuoteInputs) for permanent
  // quotes. Always present in the form so the picker can switch to it cleanly.
  permanent: PermanentQuoteFields;
  // Referral program redemption (#41 PR 2): provenance for a referral-credit
  // discount application — set when staff clicks "Apply as discount" on the
  // credit banner (which ALSO sets discountEnabled/discountType/discountAmount
  // above). null = no referral credit applied. Purely additive/display —
  // ridden through to inputs.referralCredit so the snapshot freeze remembers
  // which rows were spent (see pricingEngine.ts QuoteInputs.referralCredit).
  referralCredit: { amount: number; consumedRowIds: string[] } | null;
  // Permanent Bistro Lighting (#117) — permanent_bistro-only inputs, edited
  // only when serviceType === 'permanent_bistro'. Bistro footage is derived
  // from the freeform runs the operator draws on the Satellite tab (true-scale
  // feet-per-pixel, no yardstick) — the builder writes it here directly, it is
  // NOT projected from the design's street-photo scene (that stays visual-only
  // for bistro, mirroring permanent's split). Only the pole count is
  // hand-entered.
  // Each run carries a STABLE id (#117 MED) so a #104 per-line override keyed
  // on its billed line item id survives a mid-list run delete (a run's id must
  // not re-index like the old positional permanent-bistro-<index> fallback).
  permanentBistro: { poles: number; bistro: { footage: number; id?: string }[] };
  // HighLevel contact carried from the #leads "Create quote" link (operator
  // feedback: the created quote should link to the lead's KNOWN contact from
  // birth). Seeded ONLY by applyPrefill on the blank-slate builder's initial
  // state; null on every other quote. Sent on save (see buildQuoteInputs'
  // sibling, the /api/quote payload in QuoteBuilder) so saveQuote can set
  // quotes.highlevel_contact_id on the FIRST insert only — mirrors the
  // rebook flow's buildRebookInsert, which carries this same column forward
  // on a direct insert (no live HighLevel opportunity call at save time; the
  // "attach" flow / send flow reconcile the opportunity id later).
  highlevelContactId: string | null;
};

export const initialFormData: QuoteFormData = {
  customer: { name: '', address: '', phone: '', email: '' },
  serviceType: DEFAULT_SERVICE_TYPE,
  santasFootage: 0,
  // Roofline difficulty starts at Easy ($8/ft) and only ever moves when a staff
  // member picks a different value — see BUSINESS_RULES.rooflineDefaultDifficulty
  // for why (Jason, 2026-08-27).
  santasDifficulty: BUSINESS_RULES.rooflineDefaultDifficulty,
  santasCustomRate: 0,
  gingerbreadFootage: 0,
  gingerbreadDifficulty: BUSINESS_RULES.rooflineDefaultDifficulty,
  gingerbreadCustomRate: 0,
  winterWonderlandFootage: 0,
  winterWonderlandDifficulty: 'medium',
  winterWonderlandCustomRate: 0,
  stakeLightingFootage: 0,
  stakeLightingDifficulty: 'easy', // Stake Lighting defaults to Easy / $6/ft (Naldo)
  stakeLightingCustomRate: 0,
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
  suppressFreeSpritzerNotice: false,
  depositPercent: 0,
  installTiming: 'none',
  lineItemPriceOverrides: {},
  labelOverrides: {},
  winterWonderlandRecommended: false,
  stakeLightingRecommended: false,
  event: { barrelBoxes: 0, installDate: '', eventDate: '', takedownDate: '' },
  permanent: makeDefaultPermanentFields(),
  referralCredit: null,
  permanentBistro: { poles: 0, bistro: [] },
  highlevelContactId: null,
};

// Quote-builder prefill (#leads "Create quote" link, src/app/admin/leads). Raw
// strings read straight off the /quote/new URL query params — untyped and
// unvalidated by the caller (src/app/quote/new/page.tsx just forwards them).
export type QuoteBuilderPrefill = {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  serviceType?: string;
  // The lead's HighLevel contact id (src/app/admin/leads' quoteNewHref), when
  // known. Raw/untyped here too — validated at the /api/quote boundary.
  ghlContactId?: string;
  // NCE + YLL Neighbor tag inheritance (#198): UNLIKE the raw string fields
  // above, these are resolved SERVER-SIDE (src/app/quote/new/page.tsx looks
  // up ghlContactId's customers row before rendering) — real booleans, not
  // URL strings. QuoteBuilder reads them directly (not through
  // applyPrefill/QuoteFormData — tags are quote-row metadata, not pricing
  // inputs, same posture as isTest/highlevelContactId).
  isNce?: boolean;
  legacyRebook?: boolean;
};

/**
 * NCE + YLL Neighbor tag chips (#198 review fix — staff HIGH + tech MED;
 * INSERT/UPDATE split — S34 #198 review round 2, coordinator correction):
 * resolves what the /api/quote body should send for each tag. Pure + shared
 * by BOTH /api/quote call sites in QuoteBuilder (the main Calculate/Save and
 * the roofline-recommend re-price), so a toggle followed by either still
 * persists identically.
 *
 * mode is derived by the CALLER from whether a quoteId exists YET at the
 * moment of that specific call (both call sites re-derive it fresh — a
 * brand-new quote's savedQuoteId flips from null to a real id after its
 * first successful save, so the SAME function call site is 'insert' once
 * and 'update' on every call after):
 *
 * - 'insert' (no existing DB row — this save WILL create one): sends the
 *   chip's CURRENT DISPLAYED value for both tags, regardless of touched.
 *   There is nothing to clobber yet, and the displayed value (which may be
 *   an inherited tag from a lead prefill or an in-builder HL-contact pick
 *   the staff never manually clicked) IS the intended state — inheriting
 *   the tag by default, with no click required, is the actual feature this
 *   ticket asked for. (Round-1 fix wrongly applied touched-gating here too,
 *   silently dropping an untouched inherited tag back to false at the exact
 *   moment it needed to land — see git history; this corrects it.)
 * - 'update' (a quoteId already exists — this save updates that row): a
 *   TOUCHED chip (staff explicitly clicked it this session) sends its
 *   current value; an UNTOUCHED chip sends `undefined`, which updateQuote
 *   treats as "leave the stored value alone" — so a Calculate on a tab left
 *   open can never silently revert a tag an admin toggled concurrently on
 *   the quote detail page.
 */
export function resolveTagPayload(
  legacyRebook: boolean,
  legacyRebookTouched: boolean,
  isNce: boolean,
  isNceTouched: boolean,
  mode: 'insert' | 'update',
): { legacyRebook: boolean | undefined; isNce: boolean | undefined } {
  if (mode === 'insert') {
    return { legacyRebook, isNce };
  }
  return {
    legacyRebook: legacyRebookTouched ? legacyRebook : undefined,
    isNce: isNceTouched ? isNce : undefined,
  };
}

/**
 * NCE 40% deposit default (#199): the depositPercent a quote's Deposit %
 * field should carry when the NCE chip flips, given the CURRENT depositPercent
 * and whether the quote is locked post-approval (the #177 freeze). Pure so
 * every place the builder flips isNce (the chip click, contact-pick tag
 * inheritance) funnels through identical logic — and it's unit-testable
 * without a React render harness (QuoteBuilder has none; see resolveTagPayload
 * above for the same convention).
 *
 * - locked: never changes here — the #177 freeze (server 409 on a changed
 *   depositPercent post-approval) owns an approved/booked quote's deposit.
 * - turning ON: 40 (NCE's contractual deposit rate vs the 50% default).
 * - turning OFF: reverts to 0 (blank = 50%) ONLY when BOTH `current === 40`
 *   AND `wasRuleSet` — i.e. THIS rule's own prior turn-ON is what put the 40
 *   there. A bare `current === 40` can't tell that apart from a value staff
 *   hand-typed for an unrelated reason (a coincidentally-40% negotiated
 *   deposit) — wrap-review F4: without `wasRuleSet`, turning the chip OFF (or
 *   even a same-tick contact-pick re-confirmation that never actually
 *   changes isNce — see the caller's own no-op-flip guard) would silently
 *   wipe a hand-typed 40 the chip never touched. Any other value is always
 *   left alone regardless of `wasRuleSet`.
 *
 * Returns `current` unchanged when no rule applies (including the locked
 * case), so callers can always assign the result unconditionally. Callers
 * are expected to skip calling this entirely when nextIsNce hasn't actually
 * changed from the current isNce (this function has no way to know that on
 * its own — it only sees the NEXT value).
 */
export function resolveNceDepositPercent(
  current: number,
  nextIsNce: boolean,
  locked: boolean,
  wasRuleSet: boolean,
): number {
  if (locked) return current;
  if (nextIsNce) return NCE_DEPOSIT_PERCENT;
  return wasRuleSet && current === NCE_DEPOSIT_PERCENT ? 0 : current;
}

/**
 * Row 328(b): may the NCE rule claim the deposit value now sitting in the form
 * as ITS OWN?
 *
 * Provenance decides what a later turn-OFF does: a 40 the rule wrote reverts to
 * blank, a 40 a staffer negotiated must survive. The old code claimed ownership
 * on every turn-ON, unconditionally — so turning the chip ON while a hand-typed
 * 40 already sat in the field adopted that number, and the next OFF wiped it.
 * The staffer never saw the rule touch anything, because the value it "wrote"
 * was the one already there.
 *
 * The rule may claim only what it actually WROTE, which is exactly the case
 * where the resolved value differs from what was there. Turning OFF never
 * claims (there is no rule-owned value afterwards, whether a revert fired or a
 * hand-edit was left alone), and a locked quote never claims because
 * resolveNceDepositPercent wrote nothing.
 */
export function shouldClaimNceDepositProvenance(args: {
  nextIsNce: boolean;
  locked: boolean;
  current: number;
  resolved: number;
}): boolean {
  if (args.locked) return false;
  if (!args.nextIsNce) return false;
  return args.resolved !== args.current;
}

/**
 * Row 328(a): the contact-pick tag inheritance (#198) runs in an async `.then`
 * after a customers lookup, and routes through the same applyIsNce as a chip
 * click (#199) — so on a quote that has ALREADY LEFT DRAFT, re-picking a
 * contact could move the deposit percentage seconds after the click, with no
 * prompt and nothing on screen saying so. The customer may already be looking
 * at a portal link quoting the old figure.
 *
 * `nceDepositLocked` (approved/booked) already refuses to move it. This covers
 * the gap underneath: sent or viewed, not yet approved.
 *
 * The chip still inherits — that is a fact about the contact, and staff need to
 * see it. Only the MONEY is held back, and only on this async path: a staffer
 * clicking the chip themselves is making a deliberate choice in the moment and
 * keeps the 40% default. Returns true when the deposit was left alone but WOULD
 * have moved, which is the only case worth telling anyone about.
 */
export function nceTagDepositWasSuppressed(args: {
  /** Whether the inherited tag actually MOVES the chip. applyIsNce no-ops on an
   *  unchanged value, so without this the notice fired on a re-pick of the same
   *  tagged contact — a warning about nothing, which teaches staff to ignore
   *  the warning about something. It is a parameter of the rule rather than a
   *  check at the call site because a delta-verify proved the call-site version
   *  could be deleted with every test still passing. */
  chipWouldChange: boolean;
  quoteLeftDraft: boolean;
  locked: boolean;
  current: number;
  resolved: number;
}): boolean {
  if (!args.chipWouldChange) return false;
  if (!args.quoteLeftDraft || args.locked) return false;
  return args.resolved !== args.current;
}

/**
 * #212 fix round (finding 1): what to clear on the form when staff switch the
 * service type away from holiday. installTiming (Sep/Oct early-install) is
 * holiday-only — none of the other engines read it, so the builder's own
 * switch handler already clears it back to 'none'. But that clear alone left
 * an INCOHERENT rest-state reachable today: pick September (installTiming
 * set, discountEnabled true, discountAmount untouched/blank because the
 * amount input is hidden while an early-install month is picked), then
 * switch to event/permanent/bistro — the new Discount section rendered with
 * "Apply discount" still checked and an empty amount, with nothing telling
 * the staffer their September pick had vanished.
 *
 * Resting position chosen: clear discountEnabled/discountAmount too, but
 * ONLY when installTiming was actually driving them (i.e. it wasn't already
 * 'none'). A genuine manual discount is entered with installTiming left at
 * 'none' (the Percentage/Flat radios each force it back to 'none' — see the
 * JSX) — so whenever installTiming is already 'none', this is a no-op and a
 * hand-typed discount survives the switch untouched. Whenever installTiming
 * is NOT 'none', discountAmount/discountEnabled were only ever in that state
 * BECAUSE of the early-install pick (the amount field was hidden the whole
 * time an install month was selected, so nothing typed there could be a
 * deliberate value the staffer means to keep) — discarding the whole block
 * gives a clean, coherent unchecked "Apply discount" on the new vertical,
 * matching what a staffer switching type would expect to see.
 *
 * Pure so the reset is unit-testable without a React render harness
 * (QuoteBuilder has none — see resolveNceDepositPercent above for the same
 * convention). No-op (returns {}) when switching INTO holiday, or when
 * installTiming was already 'none' — callers can always spread the result.
 */
export function clearHolidayOnlyDiscountState(
  newServiceType: ServiceType,
  form: Pick<QuoteFormData, 'installTiming' | 'discountEnabled' | 'discountAmount'>,
): Partial<QuoteFormData> {
  if (newServiceType === 'holiday' || form.installTiming === 'none') return {};
  return { installTiming: 'none', discountEnabled: false, discountAmount: 0 };
}

/**
 * #243 (domain rule locked 2026-08-11): what to clear when staff switch the
 * service type AWAY from one that can carry the NCE/YLL Neighbor tag — same
 * call site, same "what needs clearing on this switch" question as
 * clearHolidayOnlyDiscountState above, kept as its own function (not folded
 * in) because the two clear DIFFERENT state — this one drives applyIsNce/
 * applyLegacyRebook calls (which live outside `form`, as their own useState
 * pair — see QuoteBuilder's own comment on why), not a form-field patch.
 *
 * Pure so it's unit-testable without a React render harness (QuoteBuilder
 * has none — same convention as every other function in this file). Only
 * reports a clear for a chip that's ACTUALLY true and would become
 * ineligible — switching into an eligible type, or a chip that's already
 * false, is always a no-op; the caller is expected to skip the corresponding
 * apply call entirely when its flag here is false (mirrors
 * resolveNceDepositPercent's own "callers skip calling on a no-op" contract).
 */
export function clearNceOrNeighborOnServiceTypeSwitch(
  newServiceType: ServiceType,
  isNce: boolean,
  legacyRebook: boolean,
): { clearIsNce: boolean; clearLegacyRebook: boolean } {
  const eligible = canCarryNceOrYllNeighborTag(newServiceType);
  return {
    clearIsNce: !eligible && isNce,
    clearLegacyRebook: !eligible && legacyRebook,
  };
}

/**
 * Builder tag-chip confirm gate (#215): whether a MANUAL click on the YLL
 * Neighbor chip should window.confirm before the tag flips, and what it says
 * if so. Full consequence parity with LegacyRebookToggle's (the admin
 * quote-detail sibling) confirm text — same bullets, same voice, same
 * "already left draft" caveats — the builder chip flipped silently before
 * this, the asymmetry this ticket closes. The ON-path consequences are real
 * regardless of which UI set the flag: the portal render
 * (src/lib/portal/adapter.ts + derivePackages.ts), the operator-inbox
 * exclusion (EXCLUDE_LEGACY_REBOOK_FROM_INBOX,
 * src/lib/dashboard/inbox/store.ts), and the GHL pipeline routing
 * (resolvePipelineStages, ghlPipelineMap.ts) all read quotes.legacy_rebook
 * directly, not "which control toggled it" — and turning OFF reverses every
 * one of them, which is exactly as real a set of consequences, so #215 fix
 * round F2 gives OFF the same disclosure (pre-F2 it silently returned null
 * unconditionally). Pure so the "should this click prompt, and with what
 * copy" decision is unit-testable without a React render harness
 * (QuoteBuilder has none — see resolveTagPayload/resolveNceDepositPercent
 * above for the same convention). Only the chip's own onClick calls this —
 * automatic paths (contact-pick tag inheritance, mount hydration) call
 * applyLegacyRebook directly and must never prompt.
 *
 * Fix round F5: resolvePipelineStages does NOT "only fire at /send" (an
 * earlier version of this comment overstated that) — it's also called from
 * decline/route.ts, staff-decline/route.ts, convert-to-job/route.ts, the
 * highlevel/attach route's contact-pick auto-attach (reachable BEFORE
 * /send), the Valor webhook, and ghlQuoteCard.ts — see ghlPipelineMap.ts's
 * own callers for the current list. The user-facing copy below never
 * claimed a timing, so only this internal comment needed correcting.
 *
 * alreadyLeftDraft mirrors the admin control's own `status !== 'draft'`
 * check exactly (both ultimately read deriveStatus's output) — true once the
 * quote has been sent/viewed/approved/etc.:
 *   - ON: gates the "won't move any existing GHL card" caveat — a
 *     still-draft quote has nothing synced yet either way, so the caveat
 *     would be noise there.
 *   - OFF (fix round F2): gates the one-way-propagation caveat —
 *     propagateQuoteTagsToCustomer (send/route.ts's tagPropagation) only
 *     ever runs off a FRESH /send stamp, so a still-draft quote has never
 *     propagated anything to a customer profile to un-tag either.
 *     LegacyRebookToggle's own OFF copy states this caveat unconditionally
 *     (no code-level gate) — this function is intentionally tighter and
 *     only shows it when it can actually be true.
 */
export function legacyRebookConfirmMessage(
  turningOn: boolean,
  alreadyLeftDraft: boolean,
): string | null {
  if (turningOn) {
    const lines = [
      'Mark this quote as a YLL Neighbor?',
      '',
      '- The customer portal will show the "Last Year\'s Design" rebook variant (rebook copy; the item list is read-only while the quote has a single bundled line, toggleable with 2+ lines).',
      '- The quote will be hidden from the operator inbox.',
      '- Any GHL sync will route to the Yule Love Lights Neighbors pipeline instead of Christmas Lights.',
    ];
    if (alreadyLeftDraft) {
      lines.push('', 'This only affects future renders and syncs — it will NOT move any existing GHL card.');
    }
    return lines.join('\n');
  }
  const lines = [
    'Remove YLL Neighbor from this quote?',
    '',
    '- The customer portal will go back to the normal quote view.',
    '- The quote will show up in the operator inbox again.',
    '- Any GHL sync will route to the normal service-type pipeline instead of Neighbors.',
  ];
  if (alreadyLeftDraft) {
    lines.push(
      '',
      "- If this already propagated to the customer's profile (the quote was sent while tagged), the customer stays tagged YLL Neighbor — propagation is one-way. Remove it on the customer's profile directly if that's also wrong.",
    );
  }
  return lines.join('\n');
}

/**
 * Same gate as legacyRebookConfirmMessage, for the NCE chip (#199 money
 * behaviors; #215 fix round F3/F4 brought it to full consequence parity with
 * NceToggle). BOTH directions can warrant a prompt, for two independent
 * reasons layered on top of each other:
 * - The deposit-percent side effect (money): ON always force-sets it to 40%
 *   unless it's already there; OFF reverts an untouched 40 back to blank,
 *   but only when THIS rule (not a staff hand-edit) set it — see
 *   resolveNceDepositPercent's own doc for the provenance rule.
 * - The one-way-propagation caveat (fix round F3): once a tagged quote has
 *   been sent, propagateQuoteTagsToCustomer (send/route.ts) has already
 *   stamped the customer's profile — flipping the CHIP here can't undo that
 *   stamp. NceToggle's own OFF copy states this unconditionally; this
 *   function gates it on alreadyLeftDraft, same signal/reasoning as
 *   legacyRebookConfirmMessage (a still-draft quote has never propagated
 *   anything).
 *
 * So: ON always prompts (the balance-collection block is unconditional —
 * there's always something to disclose). OFF now prompts when EITHER the
 * deposit will actually revert OR the propagation caveat applies (fix round
 * F3) — pre-F3, OFF stayed silent whenever the deposit wasn't reverting,
 * even on a sent+tagged quote whose customer profile had already been
 * stamped (a sent+tagged quote with a staff hand-typed, non-reverting
 * deposit is exactly that case).
 *
 * depositPercent/locked/wasRuleSet are the same inputs applyIsNce's caller
 * already has (form.depositPercent, the #177 approved/booked freeze, and
 * nceDepositSetByRuleRef — #199's provenance flag, true only while the
 * current 40 is one THIS rule wrote). This calls resolveNceDepositPercent
 * itself rather than taking a precomputed "will it change" boolean, so the
 * copy can never drift from what applyIsNce actually does — including
 * staying silent about the deposit once locked (resolveNceDepositPercent is
 * a no-op there too), and, post-#199, staying silent about an OFF-revert
 * that will NOT happen because the 40 was hand-typed by staff rather than
 * set by this rule. Without threading provenance through, the OFF prompt
 * would promise "reverts your deposit to blank" and then correctly leave a
 * staff-typed 40 alone — warning about a change that never comes.
 *
 * The ON path's booked-lock bullet (fix round F4): NceToggle warns that an
 * already-BOOKED quote's "Charge saved card" button locks immediately too
 * (the invoice page hides that button behind `!isNce` — see
 * admin/invoices/[id]/page.tsx). Reachable here too — neither builder chip
 * is disabled once the quote is locked/booked. Gated on the SAME `locked`
 * signal the deposit line above already uses (savedStatus 'approved' OR
 * 'booked'), not a booked-only re-check, so it can't drift from the deposit
 * freeze's own definition of "locked."
 */
export function nceConfirmMessage(
  turningOn: boolean,
  depositPercent: number,
  locked: boolean,
  wasRuleSet: boolean,
  alreadyLeftDraft: boolean,
): string | null {
  const nextDepositPercent = resolveNceDepositPercent(depositPercent, turningOn, locked, wasRuleSet);
  const depositChanges = nextDepositPercent !== depositPercent;

  if (turningOn) {
    return [
      'Mark this quote as NCE?',
      '',
      'NCE = the barter/trade network YLL belongs to.',
      ...(depositChanges ? [`- Sets this quote's deposit to ${nextDepositPercent}%.`] : []),
      "- The balance won't be collectable by card or pay-link — it settles through NCE instead.",
      ...(locked
        ? ['- The "Charge saved card" button on this quote locks immediately too (an explicit staff override remains available).']
        : []),
    ].join('\n');
  }

  if (!depositChanges && !alreadyLeftDraft) return null;
  return [
    'Remove the NCE tag from this quote?',
    '',
    ...(depositChanges ? [`- Reverts this quote's deposit from ${depositPercent}% back to blank (defaults to 50%).`] : []),
    ...(alreadyLeftDraft
      ? ["- If this already propagated to the customer's profile, the customer stays tagged NCE — propagation is one-way. Remove it on the customer's profile directly if that's also wrong."]
      : []),
  ].join('\n');
}

/**
 * #251 (live incident, 2026-08-11): window.confirm copy for pickHighLevelContact
 * re-linking a quote that's already linked to a HighLevel contact — mirrors
 * legacyRebookConfirmMessage/nceConfirmMessage's shape (a pure, unit-testable
 * message builder, since QuoteBuilder has no render harness — see
 * initialNceDepositProvenance's doc below for that same convention).
 *
 * Returns null when no confirm is warranted:
 *   - nothing is linked yet (currentContactId is null — a genuine first-time
 *     pick), or
 *   - the newly-picked contact IS the one already linked (a same-contact
 *     no-op re-pick) — mirrors the server-side #251 freeze's own rule that a
 *     same-id re-pick is never blocked (quotes.ts's identityChanged/hlChanged
 *     compare, ~line 564).
 *
 * currentContactId is the CALLER's job to resolve with the right precedence:
 * the session's own live pick (highlevelContact?.id) when one exists, else
 * the persisted DB link (dbLinked ? initialQuote?.highlevelContactId : null).
 * That fallback matters — a REOPENED quote can have dbLinked true with NO
 * highlevelContact object ever hydrated (#172: the autocomplete chip isn't
 * refetched on open), which is exactly the live incident's starting state
 * (Sharon McDonough's approved #1173 was already HL-linked when a stale pick
 * on a different quote's tab re-pointed it, invisible on every screen).
 *
 * #839 fix-round re-check (staff lens LOW): the isApproved branch's copy is
 * now DIFFERENT from the unapproved branch, not just stronger — once BOTH
 * the quotes.ts and attach/route.ts freezes ship (same fix round), a
 * confirmed re-pick on an approved-but-unpaid quote no longer moves
 * customer_id at all (frozen). The old copy ("risks attributing their
 * approved price and signed terms to the wrong person") described exactly
 * the customer_id repoint that's now blocked — claiming it here would
 * overstate what a decline-and-proceed actually does. What's still true and
 * still worth disclosing: the HighLevel contact/card link DOES still move
 * unconditionally (see the write-site comment in attach/route.ts for why
 * that's left unfrozen) — so the copy now names that residual precisely
 * instead of the no-longer-real billing risk.
 */
export function contactRelinkConfirmMessage(
  newContactId: string,
  newContactLabel: string,
  currentContactId: string | null,
  isApproved: boolean,
): string | null {
  if (!currentContactId || currentContactId === newContactId) return null;
  const lines = [`Link this quote to ${newContactLabel}?`, ''];
  if (isApproved) {
    lines.push(
      'This quote has already been approved by the customer, so its customer record (billing, jobs, invoices, tenure) is frozen and will NOT move. Confirming will still move this quote\'s HighLevel contact/card link to the new contact — if this pick is a mistake, HighLevel ends up pointing at the wrong contact until it\'s corrected.',
    );
  } else {
    lines.push(
      'This quote is currently linked to a DIFFERENT HighLevel contact — re-linking it changes which customer this quote (and its billing/GHL history) belongs to.',
    );
  }
  return lines.join('\n');
}

/**
 * #839 fix-round (BYPASS 3, customer+technical lenses): window.confirm copy
 * for clearHighLevelContact (the contact chip's "Change"/clear button) on a
 * quote whose identity has EVER been frozen (deposit_paid_at ||
 * customer_approved_at || wasEverApproved — pass the sticky signal, not the
 * bare current customer_approved_at; row 338 fixed a caller that passed the
 * non-sticky one, which let a revived previously-approved quote skip this
 * confirm entirely). Detach itself never touches quotes.customer_id —
 * route.ts's `detach:true` branch is a bare two-column null-out
 * (highlevel_contact_id/highlevel_opportunity_id), no attachQuoteToCustomer
 * call — so this is a narrower risk than contactRelinkConfirmMessage above:
 * clearing never changes who the quote BELONGS to (billing/jobs/invoices
 * read customer_id, untouched here). The real, honest consequence is losing
 * the HighLevel card/stage/date sync for this contact until a new pick.
 * Returns null when the identity was never frozen — an everyday draft/sent
 * correction needs no prompt, matching contactRelinkConfirmMessage's own
 * posture.
 *
 * Row 338 correction: an earlier version of this comment said a
 * server-side block was "considered and rejected" for detach and that
 * detach "structurally cannot cause" the #251/#839 freezes' harm class.
 * That's no longer the whole story — route.ts's `detach:true` branch DOES
 * refuse under the same sticky CAS as the attach write (closing the exact
 * decline-revive hole this doc used to wave off). This confirm is still the
 * right FIRST line of defense (instant, no round trip); the server refusal
 * is the real backstop, and clearHighLevelContact's response read now
 * restores the UI on that refusal instead of trusting the optimistic clear.
 * See the write-site comment in attach/route.ts for the sibling design note
 * on the (deliberately unfrozen pre-freeze) GHL-link write itself.
 */
export function clearContactConfirmMessage(isApproved: boolean): string | null {
  if (!isApproved) return null;
  return [
    "Clear this quote's HighLevel contact link?",
    '',
    'This quote has already been approved. Clearing the link does NOT change which customer this quote belongs to — billing, jobs, and invoices are unaffected. It only stops HighLevel card/stage/date syncs for this contact until you pick a new one.',
  ].join('\n');
}

/**
 * #199 delta-verify (MED): seeds nceDepositSetByRuleRef's value on MOUNT —
 * whether QuoteBuilder's CURRENT depositPercent is a value the NCE rule
 * itself would have written, so a chip turn-OFF later knows whether it's
 * allowed to revert it. Pure + exported so it's unit-testable without a
 * render harness (QuoteBuilder has none — mirrors resolveTagPayload's own
 * convention above, and sits next to resolveNceDepositPercent, the live-flip
 * rule it seeds the provenance ref FOR).
 *
 * Reopened quote (`initial` non-null): rule-owned only when the saved row is
 * BOTH tagged is_nce AND sitting at EXACTLY 40 — every path that can produce
 * that combination (the builder chip, the admin "Mark as NCE" toggle route,
 * the rebook clone) writes it via this same 40%-on-turn-on rule. The
 * residual is deliberate: staff who hand-typed exactly 40 on an NCE quote,
 * closed it, and reopened it will see a later chip OFF revert that 40 to
 * blank — recoverable in one keystroke, versus the bug this replaces
 * (silently billing an untagged customer at the NCE rate).
 *
 * Brand-new quote (`initial` null): rule-owned exactly when prefilled from
 * an already-NCE-tagged lead (mirrors the mount seed that force-writes 40 in
 * that case — see QuoteBuilder's form initializer, the `prefill?.isNce`
 * branch).
 */
export function initialNceDepositProvenance(
  initial: { isNce?: boolean; depositPercent?: number } | null,
  prefillIsNce?: boolean,
): boolean {
  return initial ? initial.isNce === true && initial.depositPercent === 40 : prefillIsNce === true;
}

/**
 * Merge a lead's prefill values onto a blank QuoteFormData. Applied ONLY as
 * the blank-slate builder's INITIAL state (QuoteBuilder's lazy useState
 * initializer) — never re-applied after mount, so a reopened quote
 * (/quote/[id], initialQuote present) never calls this. Blank/whitespace-only
 * strings and an unrecognized serviceType are ignored (base value kept).
 */
export function applyPrefill(base: QuoteFormData, prefill?: QuoteBuilderPrefill): QuoteFormData {
  if (!prefill) return base;
  const pick = (v: string | undefined, fallback: string) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : fallback;
  };
  const ghlContactId = prefill.ghlContactId?.trim();
  return {
    ...base,
    customer: {
      name: pick(prefill.name, base.customer.name),
      email: pick(prefill.email, base.customer.email),
      phone: pick(prefill.phone, base.customer.phone),
      address: pick(prefill.address, base.customer.address),
    },
    serviceType: asServiceType(prefill.serviceType) ?? base.serviceType,
    highlevelContactId: ghlContactId ? ghlContactId : base.highlevelContactId,
  };
}

// #102: translate a difficulty dropdown choice into the wire shape. A 'custom'
// choice sends a placeholder valid difficulty (the engine ignores it once a
// positive customRate is present) plus the custom $/ft; a preset choice sends
// just the difficulty and no rate key (legacy-clean). A 'custom' choice with a
// non-positive rate degrades to the fallback preset rather than $0.
// A stored custom $/ft counts as active only when it's a positive finite number
// — matches the engine's resolveRate guard, so the dropdown and the price agree.
function customRateActive(rate: number | undefined): boolean {
  return Number.isFinite(rate) && (rate as number) > 0;
}

type WireRate = { difficulty: RooflineDifficulty; customRate?: number };
function toWireRate(choice: DifficultyChoice, customRate: number, fallback: RooflineDifficulty): WireRate {
  if (choice === 'custom') {
    return customRate > 0 ? { difficulty: fallback, customRate } : { difficulty: fallback };
  }
  return { difficulty: choice };
}

// Form → engine inputs. `rooflineChoiceOverride` lets the breakdown's staff-pick
// radios re-quote with a specific choice without waiting on the async form-state
// update (#17 Phase 1b).
// Event Lighting (#96): the event-only inputs block, only for event quotes and
// only the fields staff set. Bistro footage is NOT here — it's design-driven and
// merged in by applyProjectionToInputs (route side) from the drawn scene.
function buildEventInputs(form: QuoteFormData): { event?: EventInputFields } {
  if (form.serviceType !== 'event') return {};
  const e: EventInputFields = {
    ...(form.event.barrelBoxes > 0 ? { barrelBoxes: form.event.barrelBoxes } : {}),
    ...(form.event.installDate ? { installDate: form.event.installDate } : {}),
    ...(form.event.eventDate ? { eventDate: form.event.eventDate } : {}),
    ...(form.event.takedownDate ? { takedownDate: form.event.takedownDate } : {}),
  };
  return Object.keys(e).length > 0 ? { event: e } : {};
}

// Permanent Bistro Lighting (#117): the permanentBistro-only inputs block,
// only for permanent_bistro quotes and only the fields staff set. Bistro
// FOOTAGE comes straight off the form (the Satellite-tab derive effect writes
// it there) — only positive-footage entries are sent, matching the poles > 0
// guard, so a quote with no drawn runs yet stays legacy-clean.
function buildPermanentBistroInputs(form: QuoteFormData): { permanentBistro?: PermanentBistroInputFields } {
  if (form.serviceType !== 'permanent_bistro') return {};
  const bistro = (form.permanentBistro.bistro ?? [])
    .filter((b) => b.footage > 0)
    // #117 MED: carry the run's stable id through so the engine keys the billed
    // line item on it (not a positional fallback that shifts on run delete).
    .map((b) => ({ footage: b.footage, ...(b.id ? { id: b.id } : {}) }));
  const pb: PermanentBistroInputFields = {
    ...(form.permanentBistro.poles > 0 ? { poles: form.permanentBistro.poles } : {}),
    ...(bistro.length > 0 ? { bistro } : {}),
  };
  return Object.keys(pb).length > 0 ? { permanentBistro: pb } : {};
}

export function buildQuoteInputs(
  form: QuoteFormData,
  rooflineChoiceOverride?: RooflineChoice,
): QuoteInputs {
  const effectiveRooflineChoice = rooflineChoiceOverride ?? form.rooflineChoice;
  // #102 per-item-type custom $/ft → wire. Each falls back to its own preset
  // default: the two ROOFLINE types to BUSINESS_RULES.rooflineDefaultDifficulty
  // (Easy, 2026-08-27), WW to 'medium', stake to 'easy'.
  const santas = toWireRate(form.santasDifficulty, form.santasCustomRate, BUSINESS_RULES.rooflineDefaultDifficulty);
  const gingerbread = toWireRate(form.gingerbreadDifficulty, form.gingerbreadCustomRate, BUSINESS_RULES.rooflineDefaultDifficulty);
  const winterWonderland = toWireRate(form.winterWonderlandDifficulty, form.winterWonderlandCustomRate, 'medium');
  const stakeLighting = toWireRate(form.stakeLightingDifficulty, form.stakeLightingCustomRate, 'easy');
  return {
    santasFootage: form.santasFootage,
    santasDifficulty: santas.difficulty,
    ...(santas.customRate !== undefined ? { santasCustomRate: santas.customRate } : {}),
    gingerbreadFootage: form.gingerbreadFootage,
    gingerbreadDifficulty: gingerbread.difficulty,
    ...(gingerbread.customRate !== undefined ? { gingerbreadCustomRate: gingerbread.customRate } : {}),
    winterWonderlandFootage: form.winterWonderlandFootage,
    winterWonderlandDifficulty: winterWonderland.difficulty,
    ...(winterWonderland.customRate !== undefined ? { winterWonderlandCustomRate: winterWonderland.customRate } : {}),
    stakeLightingFootage: form.stakeLightingFootage,
    stakeLightingDifficulty: stakeLighting.difficulty,
    ...(stakeLighting.customRate !== undefined ? { stakeLightingCustomRate: stakeLighting.customRate } : {}),
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
    // Only stored when set, same as waiveMinimum above — absent means the
    // notice shows normally.
    ...(form.suppressFreeSpritzerNotice ? { suppressFreeSpritzerNotice: true } : {}),
    // #177: only sent when set (blank/0 = use the BUSINESS_RULES default);
    // full 1-100-integer enforcement happens server-side (never trust the client).
    ...(form.depositPercent > 0 ? { depositPercent: form.depositPercent } : {}),
    // Early-install promo (#40) — only sent when staff picked a month.
    ...(form.installTiming !== 'none' ? { installTiming: form.installTiming } : {}),
    // #104: per-quote line-item overrides — only sent when at least one is set,
    // so legacy quotes stay clean in the inputs jsonb.
    ...(Object.keys(form.lineItemPriceOverrides).length > 0
      ? { lineItemPriceOverrides: form.lineItemPriceOverrides }
      : {}),
    // item-numbering-rename: per-quote label renames — only sent when at
    // least one is set, so legacy quotes stay clean in the inputs jsonb.
    ...(Object.keys(form.labelOverrides).length > 0
      ? { labelOverrides: form.labelOverrides }
      : {}),
    // #12: WW/Stake recommend flags — only sent when set (legacy-clean).
    ...(form.winterWonderlandRecommended ? { winterWonderlandRecommended: true } : {}),
    ...(form.stakeLightingRecommended ? { stakeLightingRecommended: true } : {}),
    // Event Lighting (#96) — event-only inputs (barrels + dates), event quotes only.
    ...buildEventInputs(form),
    // #88 Permanent: send the permanent block ONLY for permanent quotes, so a
    // holiday quote's inputs jsonb stays clean and the holiday engine never sees it.
    ...(form.serviceType === 'permanent' ? { permanent: form.permanent } : {}),
    // Permanent Bistro Lighting (#117) — permanentBistro-only inputs (poles),
    // permanent_bistro quotes only.
    ...buildPermanentBistroInputs(form),
    // Manual %/flat discount — only when "Apply discount" is on AND no early-install
    // month is picked. They share the one toggle and are mutually exclusive: an
    // early-install month sends installTiming (above) instead of a manual discount.
    ...(form.discountEnabled && form.installTiming === 'none' && {
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
    // Referral program redemption (#41 PR 2) — provenance only, only sent
    // when a referral credit was actually applied (legacy-clean jsonb).
    ...(form.referralCredit ? { referralCredit: form.referralCredit } : {}),
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
  const resolvedServiceType = serviceType ?? DEFAULT_SERVICE_TYPE;
  // #212 fix round (finding 2, defensive): installTiming is holiday-only —
  // the builder's own switch handler (clearHolidayOnlyDiscountState above)
  // now prevents a non-holiday quote from ever SAVING a non-'none' value
  // going forward, but hydrate had no equivalent guard of its own. A row
  // that predates that fix (or reaches this shape via any future path) would
  // otherwise rehydrate discountEnabled=true off a stale installTiming while
  // buildQuoteInputs's `discount` gate (installTiming === 'none') stays shut
  // — a manual discount the staffer then types would silently never reach
  // the save payload. Normalizing here, at the one place ALL hydration flows
  // through, closes that regardless of how the stale value got there.
  // Verified against prod: zero rows currently match this precondition.
  const effectiveInstallTiming = resolvedServiceType === 'holiday' ? (i.installTiming ?? 'none') : 'none';
  return {
    customer: {
      name: customerField(customer?.name, NAME_SENTINEL),
      address: customerField(customer?.address, ADDRESS_SENTINEL),
      phone: customerField(customer?.phone),
      email: customerField(customer?.email),
    },
    serviceType: resolvedServiceType,
    santasFootage: i.santasFootage ?? 0,
    // #102: a stored positive custom rate rehydrates the dropdown to 'custom'
    // and seeds the numeric field; otherwise the stored preset difficulty.
    santasDifficulty: customRateActive(i.santasCustomRate) ? 'custom' : (i.santasDifficulty ?? BUSINESS_RULES.rooflineDefaultDifficulty),
    santasCustomRate: i.santasCustomRate ?? 0,
    gingerbreadFootage: i.gingerbreadFootage ?? 0,
    gingerbreadDifficulty: customRateActive(i.gingerbreadCustomRate) ? 'custom' : (i.gingerbreadDifficulty ?? BUSINESS_RULES.rooflineDefaultDifficulty),
    gingerbreadCustomRate: i.gingerbreadCustomRate ?? 0,
    winterWonderlandFootage: i.winterWonderlandFootage ?? 0,
    winterWonderlandDifficulty: customRateActive(i.winterWonderlandCustomRate)
      ? 'custom'
      : (i.winterWonderlandDifficulty ?? 'medium'),
    winterWonderlandCustomRate: i.winterWonderlandCustomRate ?? 0,
    stakeLightingFootage: i.stakeLightingFootage ?? 0,
    stakeLightingDifficulty: customRateActive(i.stakeLightingCustomRate)
      ? 'custom'
      : (i.stakeLightingDifficulty ?? 'easy'),
    stakeLightingCustomRate: i.stakeLightingCustomRate ?? 0,
    ...(i.rooflineChoice ? { rooflineChoice: i.rooflineChoice } : {}),
    miniLightItems: i.miniLightItems ?? [],
    spritzers: i.spritzers ?? [],
    wreaths: i.wreaths ?? [],
    garland: i.garland ?? [],
    bows: i.bows ?? [],
    customLineItems: i.customLineItems ?? [],
    takedown: i.takedown ?? 'included',
    rushFee: i.rushFee ?? false,
    // "Apply discount" is open when there's a manual discount OR an early-install
    // promo (#40) — both live under that one toggle now. effectiveInstallTiming
    // (not the raw stored value) so a stale non-holiday installTiming can't
    // open this on its own (#212 finding 2).
    discountEnabled: d != null || effectiveInstallTiming !== 'none',
    discountType: d?.type ?? 'percentage',
    discountAmount:
      d == null ? 0 : d.type === 'percentage' ? fractionToWholePercent(d.amount) : d.amount,
    waiveMinimum: i.waiveMinimum ?? false,
    suppressFreeSpritzerNotice: i.suppressFreeSpritzerNotice ?? false,
    depositPercent: i.depositPercent ?? 0,
    installTiming: effectiveInstallTiming,
    // #104: hydrate the per-quote overrides map (legacy quotes → {}).
    lineItemPriceOverrides: i.lineItemPriceOverrides ?? {},
    // item-numbering-rename: hydrate the per-quote rename map (legacy quotes → {}).
    labelOverrides: i.labelOverrides ?? {},
    winterWonderlandRecommended: i.winterWonderlandRecommended ?? false,
    stakeLightingRecommended: i.stakeLightingRecommended ?? false,
    // Event Lighting (#96) — hydrate the event block (barrels + dates); bistro is
    // design-driven, not a form field. Legacy/non-event rows → blanks.
    event: {
      barrelBoxes: i.event?.barrelBoxes ?? 0,
      installDate: i.event?.installDate ?? '',
      eventDate: i.event?.eventDate ?? '',
      takedownDate: i.event?.takedownDate ?? '',
    },
    // #88 Permanent: hydrate the stored block, or a fresh blank one (a factory so
    // the gaps array isn't shared). Merged over the defaults so a partially-saved
    // block (older permanent quote) fills any missing field.
    permanent: i.permanent
      ? { ...makeDefaultPermanentFields(), ...i.permanent }
      : makeDefaultPermanentFields(),
    // Referral program redemption (#41 PR 2) — legacy/no-credit rows → null.
    referralCredit: i.referralCredit ?? null,
    // Permanent Bistro Lighting (#117) — hydrate the poles count + the saved
    // bistro runs (footage + the stable run id so a reopened-then-edited quote
    // keeps #104 overrides attached to the right run; sceneItemIds aren't
    // form-relevant since #117 moved bistro off the design projection).
    // Legacy/non-bistro rows → 0/[].
    permanentBistro: {
      poles: i.permanentBistro?.poles ?? 0,
      bistro: (i.permanentBistro?.bistro ?? []).map((b) => ({
        footage: b.footage,
        ...(b.id ? { id: b.id } : {}),
      })),
    },
    // #leads prefill-only field — a hydrated/reopened quote never carries it
    // (applyPrefill never runs on the edit flavor; see its own doc comment).
    highlevelContactId: null,
  };
}
