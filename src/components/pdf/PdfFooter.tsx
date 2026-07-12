// Shared footer for the ledger #87(a) customer PDFs — consistent branding
// across quote / invoice / receipt.

import { Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

export function PdfFooter() {
  return (
    <Text style={pdfStyles.footer} fixed>
      Yule Love Lights · Questions about this document? Reach out any time — we&apos;re happy to help.
    </Text>
  );
}
