// Ledger #87(a) Jobber-format redesign — YLL's own contract terms, transcribed
// VERBATIM from the reference spec (the company's real terms already in use on
// the Jobber invoices this redesign matches). No paraphrasing: any wording
// change here would change what the customer is agreeing to. Rendered on the
// invoice + quote PDFs' "YULE LOVE LIGHTS CONTRACT AGREEMENT" block; the
// receipt (a record of money already collected, not an agreement) omits it.
//
// Kept as an array of paragraphs (not one giant string) so the React-PDF
// <Text> flow can wrap/paginate naturally across pages, the same way the
// reference PDF's terms block spills from page 2 onto page 3.

export const CONTRACT_TITLE = 'YULE LOVE LIGHTS CONTRACT AGREEMENT';

export const CONTRACT_INTRO =
  'By accepting this invoice, the customer agrees to the following terms and conditions:';

export type ContractSection = { heading: string; body: string };

export const CONTRACT_SECTIONS: ContractSection[] = [
  {
    heading: 'Payment Terms',
    body: 'Payment is due upon receipt of the invoice.',
  },
  {
    heading: 'Cancellation Policy',
    body: 'Cancellations must be made at least 2 days prior to the scheduled installation date. Any cancellations made after this period may result in a NON-REFUNDABLE DEPOSIT',
  },
  {
    heading: 'Liability',
    body: 'The customer acknowledges that the installation of holiday lights and decorations can involve certain risks, including but not limited to damage to property or injury to persons. The customer assumes all responsibility and liability for any damages or injuries that may occur during the installation process, and agrees to hold the holiday light installation company harmless from any claims, damages, or liabilities.',
  },
  {
    heading: 'Warranty',
    body: 'The holiday light installation company warrants that the installation of holiday lights and decorations will be performed in a professional and workmanlike manner. If any issues arise with the installation or decorations during the holiday season, the holiday light installation company will make reasonable efforts to resolve the issue in a timely manner.',
  },
  {
    heading: 'Governing Law',
    body: 'This agreement shall be governed by and construed in accordance with the laws of the state of New York, without regard to conflicts of law principles.',
  },
  {
    heading: 'Entire Agreement',
    body: 'This agreement constitutes the entire agreement between the customer and the holiday light installation company and supersedes all prior negotiations, understandings, and agreements between the parties, whether oral or written.',
  },
];

export const CONTRACT_CLOSING =
  'By accepting this invoice, the customer acknowledges that they have read and understood the terms and conditions of this agreement, and agrees to be bound by its terms.';

export const CONTRACT_MORE_DETAILS_HEADING = 'More Details';

export const CONTRACT_MORE_DETAILS =
  "25-50% deposit is due at the time of scheduling. The remaining % will be due at the time of installation. The full amount for materials (lighting and accessories) installation and removal must be paid in full upon completion of the installation. Yule Love Lights is not responsible for any products damaged or lost due to vandalism, extreme weather conditions, or acts of god and will make efforts to replace any damaged product for an additional charge. No warranty or complimentary repair service is expressed or implied, unless noted in writing in this agreement. Yule Love Lights will replace any malfunctioning product but does not guarantee that each individual bulb will light for the entire installation period. By signing this contract, the customer acknowledges that Yule Love Lights fills their schedule well in advance, and all cancellations will be charged 50% of the labor charge. All bids are made under the assumption that adequate power supplies and receptacles are available. Customer is responsible for maintaining and providing adequate electrical outlets adjacent to the proposed locations for its lit decorations and building lights. This contract is governed by New York State law, and is the entire contract between the parties. If a dispute arises out of this contract, the parties shall agree to resolve this dispute through arbitration in Suffolk County before a single arbitrator. Any judgement upon the award rendered by the arbitrator may be entered in any court having jurisdiction thereof. The prevailing party in arbitration shall be entitled to its reasonable attorney's fees and costs. By signing below, I agree to the terms of this contract, and accept this proposal on those terms. Furthermore, I declare that I am authorized to sign this document, either as an owner of the property, or as an agent for the owner or entity. Please note that 5% per month (60% per yr.) will be added to all outstanding balances.";

// The company block rendered on every page's header — verbatim/constant per
// Naldo (ledger #87a scope): Yule Love Lights · 6 Birch Road, Amityville, New
// York 11701 · (631) 517-0186 · sales@yulelovelights.com · yulelovelights.com.
export const COMPANY_INFO = {
  name: 'Yule Love Lights',
  addressLine: '6 Birch Road  |  Amityville, New York 11701',
  contactLine: '(631) 517-0186  |  sales@yulelovelights.com  |  yulelovelights.com',
};
