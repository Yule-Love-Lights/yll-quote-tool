// Shared branded header for the ledger #87(a) customer PDFs. `logo` is the
// PNG file bytes read by the caller (the API route) from the SAME asset the
// portal watermark uses (public/yule-site-logo-2.png — see
// src/components/portal/LogoWatermark.tsx) — never re-fetched or re-encoded
// here. Optional: a read failure degrades to a text wordmark instead of
// failing the whole PDF.

import { View, Image, Text } from '@react-pdf/renderer';
import { pdfStyles, BRAND_RED } from './pdfStyles';

type Props = {
  logo?: Buffer | null;
  docTitle: string;
  docNumber: string;
  docDate?: string;
  // #87(a) fix-batch MED #4 — a cancelled invoice/receipt must never look
  // like a valid document. Rendered in the header so it can't be missed.
  statusLabel?: string | null;
};

export function PdfHeader({ logo, docTitle, docNumber, docDate, statusLabel }: Props) {
  return (
    <View style={pdfStyles.headerRow} fixed>
      {logo ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image has no alt prop
        <Image src={logo} style={pdfStyles.logo} />
      ) : (
        <Text style={{ fontSize: 16, fontFamily: 'Helvetica-Bold', color: '#1f6f43' }}>Yule Love Lights</Text>
      )}
      <View style={pdfStyles.docTitleBlock}>
        {statusLabel && (
          <Text style={{ fontSize: 13, fontFamily: 'Helvetica-Bold', color: BRAND_RED, marginBottom: 2 }}>
            {statusLabel}
          </Text>
        )}
        <Text style={pdfStyles.docTitle}>{docTitle}</Text>
        <Text style={pdfStyles.docMeta}>{docNumber}</Text>
        {docDate && <Text style={pdfStyles.docMeta}>{docDate}</Text>}
      </View>
    </View>
  );
}
