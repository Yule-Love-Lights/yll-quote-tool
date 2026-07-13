// Ledger #87(a) Jobber-format redesign — a translucent diagonal status
// watermark across every page: green "PAID" once money is fully collected,
// red "CANCELLED" for a dead order. Upgrades the old solid cancelled banner
// (#87a fix-batch MED #4) to the reference format's diagonal treatment.

import { Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

type Props = {
  status: 'paid' | 'cancelled' | null;
};

export function PdfWatermark({ status }: Props) {
  if (!status) return null;
  const style = status === 'paid' ? pdfStyles.watermarkPaid : pdfStyles.watermarkCancelled;
  return (
    <Text style={[pdfStyles.watermark, style]} fixed>
      {status === 'paid' ? 'PAID' : 'CANCELLED'}
    </Text>
  );
}
