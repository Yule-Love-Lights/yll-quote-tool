-- Backlog-send marker (2026-09-03, Naldo).
--
-- The homepage "Quote turnaround" KPI averages created_at -> quote_sent_at
-- over EVERY sent quote, with no window (computeKpis in
-- src/lib/dashboard/metrics.ts). That is the right measure for "how fast do we
-- get a quote back to someone who asked".
--
-- On 2026-09-03 Naldo started sending a batch of quotes that had been built in
-- July and held in storage. The delay there was a business decision about when
-- to open the season, not a response time, and it dragged the all-time average
-- to 16.54 days.
--
-- The backfill that accompanied this migration stamped 51 rows, on the rule
-- Naldo picked: built before 2026-08-01 AND held 14 or more days before being
-- sent. That deliberately leaves two groups in the average. Seven quotes were
-- built and sent on 2026-09-03, which is a real same-day turnaround, and two
-- were held nine days, which is ordinary slowness rather than storage. It does
-- include seven quotes from the same July batch that trickled out between
-- 30 Jul and 17 Aug, so the metric does not depend on which day a stored quote
-- happened to go out. Smallest gap marked 14.2 days, largest gap left counting
-- 13.8 days, so nothing near-identical falls on opposite sides of the line.
--
-- Nothing in the app writes this column today. It was stamped once, by hand,
-- with Naldo's named go. A future send wave needs a deliberate decision, not a
-- default.
--
-- This column marks such a send. A stamped row keeps its true created_at and
-- its true quote_sent_at, still counts for conversion, booked revenue, active
-- quotes and every other metric, and is left out of the turnaround average
-- alone. The KPI card reports how many rows it excluded, so the number is
-- never quietly smaller than the population.
--
-- Timestamptz rather than a boolean so we keep WHEN a row was marked, which
-- is what makes a later "who marked this and why" question answerable.
--
-- Additive + nullable -> non-breaking; idempotent. Roll-forward only.
BEGIN;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS backlog_send_at timestamptz;

-- Partial index: only the marked rows, which are a small minority. Supports
-- "show me the backlog batch" reads without scanning the table.
CREATE INDEX IF NOT EXISTS quotes_backlog_send_idx
  ON public.quotes (backlog_send_at DESC)
  WHERE backlog_send_at IS NOT NULL;

COMMIT;
