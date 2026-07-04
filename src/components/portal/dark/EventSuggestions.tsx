// Event Lighting (#96) — "Want to add a little more?". A couple soft, context-
// aware add-on suggestions (popular pieces not already on the quote) shown on the
// event portal. Informational only — the customer mentions any they want and we
// add it (no instant-add / price change here). Rendered only when there are
// suggestions.

type Suggestion = { key: string; label: string; blurb: string };

export function EventSuggestions({ suggestions }: { suggestions: Suggestion[] }) {
  if (suggestions.length === 0) return null;

  return (
    <section className="w-full bg-slate-950 px-6 py-14 text-slate-100 sm:py-20">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.20em] text-[#FFB744]">
          Want to add a little more?
        </p>
        <h2 className="font-display text-2xl font-semibold text-[#F4ECD8] sm:text-3xl">
          A few touches that pair beautifully.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-slate-400">
          Just say the word and we&apos;ll add any of these to your design — no need to decide now.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {suggestions.map((s) => (
            <div
              key={s.key}
              className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-6 text-left"
            >
              <p className="text-base font-semibold text-[#F4ECD8]">{s.label}</p>
              <p className="mt-1.5 text-sm text-slate-400">{s.blurb}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
