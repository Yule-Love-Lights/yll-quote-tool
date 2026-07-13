// Ledger #87(a) Jobber-format redesign — "Page X of N" footer, right-aligned,
// repeated on every page.

import { Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

export function PdfFooter() {
  return (
    <Text
      style={pdfStyles.footer}
      fixed
      render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
    />
  );
}
