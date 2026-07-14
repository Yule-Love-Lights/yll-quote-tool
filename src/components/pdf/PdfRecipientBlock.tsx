// Ledger #87(a) Jobber-format redesign — the left-column RECIPIENT +
// SERVICE ADDRESS block. Our business has one address per job (no separate
// billing-office concept), so billingAddress and serviceAddress render the
// same real customer_address value — see PdfRecipient's doc comment
// (src/lib/pdf/docModels.ts).

import { View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import type { PdfRecipient } from '@/lib/pdf/docModels';

type Props = {
  recipient: PdfRecipient;
};

export function PdfRecipientBlock({ recipient }: Props) {
  return (
    <View style={pdfStyles.recipientCol}>
      <Text style={pdfStyles.sectionLabel}>RECIPIENT:</Text>
      <Text style={pdfStyles.recipientName}>{recipient.name}</Text>
      {recipient.billingAddress ? <Text style={pdfStyles.recipientLine}>{recipient.billingAddress}</Text> : null}
      {recipient.phone ? <Text style={pdfStyles.recipientLine}>Phone: {recipient.phone}</Text> : null}

      <View style={pdfStyles.recipientBlockGap}>
        <Text style={pdfStyles.sectionLabel}>SERVICE ADDRESS:</Text>
        <Text style={pdfStyles.recipientLine}>{recipient.serviceAddress}</Text>
      </View>
    </View>
  );
}
