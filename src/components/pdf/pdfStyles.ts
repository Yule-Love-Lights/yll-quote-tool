// Shared React-PDF styles for the ledger #87(a) customer documents (quote /
// invoice / receipt). One stylesheet so the three PDFs read as one branded
// family instead of three one-off layouts. Colors mirror the portal/admin
// palette already in use: amber accent (#FFB744, the snowglobe portal's
// accent) + the admin "collect" green (#1f6f43, see
// src/app/admin/invoices/[id]/page.tsx).

import { StyleSheet } from '@react-pdf/renderer';

export const BRAND_GREEN = '#1f6f43';
export const BRAND_AMBER = '#c8860a';
export const TEXT_DARK = '#1a1a1a';
export const TEXT_GRAY = '#6b7280';
export const BORDER_GRAY = '#e5e7eb';

export const pdfStyles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 56,
    paddingHorizontal: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: TEXT_DARK,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
    paddingBottom: 14,
    borderBottomWidth: 2,
    borderBottomColor: BRAND_GREEN,
  },
  logo: { width: 130 },
  docTitleBlock: { alignItems: 'flex-end' },
  docTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: BRAND_GREEN },
  docMeta: { fontSize: 9, color: TEXT_GRAY, marginTop: 3 },
  section: { marginBottom: 18 },
  sectionLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: TEXT_GRAY,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  customerName: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  customerLine: { fontSize: 10, color: TEXT_GRAY, marginTop: 2 },
  table: {
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    borderRadius: 4,
    overflow: 'hidden',
  },
  tableHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#f9fafb',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_GRAY,
  },
  tableHeaderLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: TEXT_GRAY,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: BORDER_GRAY,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { fontSize: 10 },
  rowDetail: { fontSize: 8, color: TEXT_GRAY, marginTop: 1 },
  rowAmount: { fontSize: 10 },
  totalsBlock: { marginTop: 14, alignSelf: 'flex-end', width: 260 },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  totalsLabel: { fontSize: 10, color: TEXT_GRAY },
  totalsAmount: { fontSize: 10 },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: 2,
    borderTopColor: BRAND_GREEN,
  },
  grandTotalLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  grandTotalAmount: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: BRAND_GREEN },
  depositBanner: {
    marginTop: 18,
    padding: 12,
    backgroundColor: '#fdf6e8',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#f0dfae',
  },
  depositLabel: { fontSize: 9, color: BRAND_AMBER, textTransform: 'uppercase', letterSpacing: 0.5 },
  depositAmount: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: TEXT_DARK, marginTop: 2 },
  paidBanner: {
    marginTop: 18,
    padding: 12,
    backgroundColor: '#eef7f1',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#cfe8d8',
  },
  paidLabel: { fontSize: 9, color: BRAND_GREEN, textTransform: 'uppercase', letterSpacing: 0.5 },
  paidAmount: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: BRAND_GREEN, marginTop: 2 },
  paidDate: { fontSize: 9, color: TEXT_GRAY, marginTop: 2 },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    textAlign: 'center',
    fontSize: 8,
    color: TEXT_GRAY,
    borderTopWidth: 1,
    borderTopColor: BORDER_GRAY,
    paddingTop: 8,
  },
  emptyNote: { fontSize: 9, color: TEXT_GRAY, fontStyle: 'italic', padding: 10 },
  link: { color: BRAND_GREEN, textDecoration: 'underline' },
});
