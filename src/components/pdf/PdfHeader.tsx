// Shared branded header for the ledger #87(a) customer PDFs. `logo` is the
// PNG file bytes read by the caller (the API route) from the SAME asset the
// portal watermark uses (public/yule-site-logo-2.png — see
// src/components/portal/LogoWatermark.tsx) — never re-fetched or re-encoded
// here. Optional: a read failure degrades to a text wordmark instead of
// failing the whole PDF.

import { View, Image, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

type Props = {
  logo?: Buffer | null;
  docTitle: string;
  docNumber: string;
  docDate?: string;
};

export function PdfHeader({ logo, docTitle, docNumber, docDate }: Props) {
  return (
    <View style={pdfStyles.headerRow} fixed>
      {logo ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image has no alt prop
        <Image src={logo} style={pdfStyles.logo} />
      ) : (
        <Text style={{ fontSize: 16, fontFamily: 'Helvetica-Bold', color: '#1f6f43' }}>Yule Love Lights</Text>
      )}
      <View style={pdfStyles.docTitleBlock}>
        <Text style={pdfStyles.docTitle}>{docTitle}</Text>
        <Text style={pdfStyles.docMeta}>{docNumber}</Text>
        {docDate && <Text style={pdfStyles.docMeta}>{docDate}</Text>}
      </View>
    </View>
  );
}
