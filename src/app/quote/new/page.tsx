import QuoteBuilder from '@/components/quote/QuoteBuilder';
import { getAppSettings } from '@/lib/appSettings';

// Blank-slate builder. The editing flavor lives at /quote/[id] (task #31);
// both render the same QuoteBuilder component. `?test=1` (ledger #93) opens the
// builder in TEST MODE so Calculate saves a fully-simulated test quote.
export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ test?: string }>;
}) {
  const { test } = await searchParams;
  const { eventEnabled } = await getAppSettings();
  return <QuoteBuilder isTest={test === '1'} eventEnabled={eventEnabled} />;
}
