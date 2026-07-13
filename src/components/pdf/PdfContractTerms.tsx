// Ledger #87(a) Jobber-format redesign — the "YULE LOVE LIGHTS CONTRACT
// AGREEMENT" block. Renders the VERBATIM terms constant (src/lib/pdf/
// contractTerms.ts) as separate paragraphs so React-PDF's normal text flow
// can wrap/paginate across pages on its own, the way the reference PDF's
// terms block spills from page 2 onto page 3 — no manual pagination here.

import { View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';
import {
  CONTRACT_TITLE,
  CONTRACT_INTRO,
  CONTRACT_SECTIONS,
  CONTRACT_CLOSING,
  CONTRACT_MORE_DETAILS_HEADING,
  CONTRACT_MORE_DETAILS,
} from '@/lib/pdf/contractTerms';

export function PdfContractTerms() {
  return (
    <View style={pdfStyles.contractTextCol}>
      <Text style={pdfStyles.contractTitle}>{CONTRACT_TITLE}</Text>
      <Text style={pdfStyles.contractParagraph}>{CONTRACT_INTRO}</Text>
      {CONTRACT_SECTIONS.map((section) => (
        <Text key={section.heading} style={pdfStyles.contractParagraph}>
          <Text style={pdfStyles.contractHeading}>{section.heading}: </Text>
          {section.body}
        </Text>
      ))}
      <Text style={pdfStyles.contractParagraph}>{CONTRACT_CLOSING}</Text>
      <Text style={pdfStyles.contractParagraph}>
        <Text style={pdfStyles.contractHeading}>{CONTRACT_MORE_DETAILS_HEADING}</Text>
        {'\n'}
        {CONTRACT_MORE_DETAILS}
      </Text>
    </View>
  );
}
