import QuoteBuilder from '@/components/quote/QuoteBuilder';

// Blank-slate builder. The editing flavor lives at /quote/[id] (task #31);
// both render the same QuoteBuilder component.
export default function NewQuotePage() {
  return <QuoteBuilder />;
}
