// Shared React-PDF styles for the ledger #87(a) customer documents (quote /
// invoice / receipt), redesigned to match the company's Jobber invoice
// format: coral accent bars/headers, a gray "Account Balance" row, hairline
// separators, and a diagonal PAID/CANCELLED watermark.

import { StyleSheet } from '@react-pdf/renderer';

export const CORAL = '#E9573F';
export const CORAL_DARK = '#c8442f';
export const GRAY_ROW = '#f3f4f6';
export const TEXT_DARK = '#1a1a1a';
export const TEXT_GRAY = '#6b7280';
export const BORDER_GRAY = '#e5e7eb';
export const WATERMARK_GREEN = '#1f6f43';
export const WATERMARK_RED = '#b91c1c';

export const pdfStyles = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 48,
    paddingHorizontal: 40,
    fontSize: 9.5,
    fontFamily: 'Helvetica',
    color: TEXT_DARK,
  },

  // ─── Company header (every page) ─────────────────────────────────────────
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  logo: { width: 68, marginRight: 14 },
  companyName: { fontSize: 17, fontFamily: 'Helvetica-Bold' },
  companyLine: { fontSize: 9, color: TEXT_DARK, marginTop: 2 },

  // ─── Recipient / service address block ───────────────────────────────────
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  recipientCol: { width: 280 },
  sectionLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: TEXT_DARK,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  recipientName: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  recipientLine: { fontSize: 9.5, color: TEXT_DARK, marginBottom: 1 },
  recipientBlockGap: { marginTop: 12 },

  // ─── Meta card (Invoice #/Quote #/Receipt # + dates + Total + Account Balance) ──
  metaCard: {
    width: 230,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    borderRadius: 3,
    overflow: 'hidden',
  },
  metaCardTitleBar: { backgroundColor: CORAL, paddingVertical: 8, paddingHorizontal: 10 },
  metaCardTitle: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#ffffff' },
  metaCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: GRAY_ROW,
    borderTopWidth: 1,
    borderTopColor: '#ffffff',
  },
  metaCardRowLabel: { fontSize: 9, color: TEXT_DARK },
  metaCardRowValue: { fontSize: 9, color: TEXT_DARK },
  metaCardTotalBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: CORAL,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  metaCardTotalLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#ffffff' },
  metaCardTotalValue: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#ffffff' },
  metaCardBalanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: GRAY_ROW,
  },
  metaCardBalanceLabel: { fontSize: 8.5, color: TEXT_GRAY },
  metaCardBalanceValue: { fontSize: 8.5, color: TEXT_GRAY },

  // ─── Section title ("For Yule Love Lights Holiday Light Installation") ──
  docSectionTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 10 },

  // ─── Line items table ────────────────────────────────────────────────────
  table: { width: '100%' },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: CORAL,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  colProduct: { width: '20%' },
  colDescription: { width: '45%' },
  colQty: { width: '10%', textAlign: 'right' },
  colUnitPrice: { width: '12.5%', textAlign: 'right' },
  colTotal: { width: '12.5%', textAlign: 'right' },
  tableHeaderLabel: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: '#ffffff' },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_GRAY,
  },
  productLabel: { fontSize: 9.5, fontFamily: 'Helvetica-Bold' },
  descriptionText: { fontSize: 8.5, color: TEXT_DARK, lineHeight: 1.4 },
  cellText: { fontSize: 9.5 },
  emptyNote: { fontSize: 9, color: TEXT_GRAY, fontStyle: 'italic', padding: 10 },

  // ─── Totals stack (bottom-right) ─────────────────────────────────────────
  totalsBlock: { marginTop: 16, alignSelf: 'flex-end', width: 260 },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_GRAY,
  },
  totalsLabel: { fontSize: 9.5 },
  totalsAmount: { fontSize: 9.5 },
  totalsRowBold: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_GRAY,
  },
  totalsLabelBold: { fontSize: 10, fontFamily: 'Helvetica-Bold' },
  totalsAmountBold: { fontSize: 10, fontFamily: 'Helvetica-Bold' },
  totalsRowLast: { borderBottomWidth: 0 },

  // ─── Contract-agreement block ────────────────────────────────────────────
  contractBlock: { marginTop: 24, flexDirection: 'row', justifyContent: 'space-between' },
  contractTextCol: { width: 300 },
  contractTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 8 },
  contractParagraph: { fontSize: 8, color: TEXT_DARK, marginBottom: 8, lineHeight: 1.5 },
  contractHeading: { fontFamily: 'Helvetica-Bold' },

  // ─── Footer ("Page X of N") ───────────────────────────────────────────────
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    textAlign: 'right',
    fontSize: 8,
    color: TEXT_GRAY,
  },

  // ─── Diagonal status watermark ────────────────────────────────────────────
  watermark: {
    position: 'absolute',
    top: '42%',
    left: -100,
    right: -100,
    textAlign: 'center',
    fontSize: 92,
    fontFamily: 'Helvetica-Bold',
    transform: 'rotate(-32deg)',
    opacity: 0.28,
  },
  watermarkPaid: { color: WATERMARK_GREEN },
  watermarkCancelled: { color: WATERMARK_RED },
});
