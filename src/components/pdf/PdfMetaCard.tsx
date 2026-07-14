// Ledger #87(a) Jobber-format redesign — the right-column meta card: a coral
// "Invoice #<n>" / "Quote #<ref>" / "Receipt #<n>" title bar, Issued/Due/Paid
// rows (only the rows that apply per doc), a coral Total bar, and an
// optional gray Account Balance row (omitted for the Quote PDF — a quote has
// no invoice/balance concept yet).

import { View, Text } from '@react-pdf/renderer';
import { pdfStyles } from './pdfStyles';

type DateRow = { label: string; value: string };

type Props = {
  title: string; // "Invoice #485"
  dateRows: DateRow[]; // only the rows that apply — Issued / Due / Paid
  totalLabel: string; // "Total"
  totalValue: string;
  accountBalance?: string | null; // omitted (undefined/null) ⇒ no Account Balance row
};

export function PdfMetaCard({ title, dateRows, totalLabel, totalValue, accountBalance }: Props) {
  return (
    <View style={pdfStyles.metaCard}>
      <View style={pdfStyles.metaCardTitleBar}>
        <Text style={pdfStyles.metaCardTitle}>{title}</Text>
      </View>
      {dateRows.map((row) => (
        <View key={row.label} style={pdfStyles.metaCardRow}>
          <Text style={pdfStyles.metaCardRowLabel}>{row.label}</Text>
          <Text style={pdfStyles.metaCardRowValue}>{row.value}</Text>
        </View>
      ))}
      <View style={pdfStyles.metaCardTotalBar}>
        <Text style={pdfStyles.metaCardTotalLabel}>{totalLabel}</Text>
        <Text style={pdfStyles.metaCardTotalValue}>{totalValue}</Text>
      </View>
      {accountBalance != null && (
        <View style={pdfStyles.metaCardBalanceRow}>
          <Text style={pdfStyles.metaCardBalanceLabel}>Account Balance</Text>
          <Text style={pdfStyles.metaCardBalanceValue}>{accountBalance}</Text>
        </View>
      )}
    </View>
  );
}
