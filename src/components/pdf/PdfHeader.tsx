// Ledger #87(a) Jobber-format redesign — the branded company header, repeated
// on every page: the YLL logo + "Yule Love Lights" + the constant company
// contact block. `logo` is the PNG file bytes read by the caller (the API
// route) from the SAME asset the portal watermark uses
// (public/yule-site-logo-2.png — see src/components/portal/LogoWatermark.tsx)
// — never re-fetched or re-encoded here. A read failure degrades to a text
// wordmark instead of failing the whole PDF.

import { View, Image, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import { COMPANY_INFO } from '@/lib/pdf/contractTerms';

type Props = {
  logo?: Buffer | null;
};

export function PdfHeader({ logo }: Props) {
  return (
    <View style={pdfStyles.headerRow} fixed>
      {logo ? (
        // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image has no alt prop
        <Image src={logo} style={pdfStyles.logo} />
      ) : null}
      <View>
        <Text style={pdfStyles.companyName}>{COMPANY_INFO.name}</Text>
        <Text style={pdfStyles.companyLine}>{COMPANY_INFO.addressLine}</Text>
        <Text style={pdfStyles.companyLine}>{COMPANY_INFO.contactLine}</Text>
      </View>
    </View>
  );
}
