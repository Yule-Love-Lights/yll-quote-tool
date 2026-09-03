-- Referral program: mark a 'link' row as CONSUMED once its suggestion has been
-- turned into a real 'mention' referral, so the same link can never be paid
-- out twice.
--
-- The hole this closes, found by the PR #1158 review:
--
--   UNIQUE(referee_quote_id) guarantees at most one referral row per referee
--   QUOTE. It does nothing across DIFFERENT quotes. A 'link' row's status
--   never changes (accrueOnBooking matches only on referee_quote_id, which a
--   link row does not have), so it stays 'pending' forever. With the new
--   quote-builder prefill reading those rows back, a repeat customer's SECOND
--   quote re-surfaces the SAME stale link row, creates a second independent
--   mention row on a different quote id, and creditBalanceFor sums both:
--   $250 paid for one referral.
--
-- Marking the link row consumed is also what stops it inflating the Referrals
-- dashboard denominator forever (referralMetrics counts every row, and an
-- orphaned link row can never reach the numerator).
--
-- Additive and nullable: safe to apply ahead of the code that reads it, and
-- every existing row keeps its current meaning (NULL = not consumed).

alter table public.referrals
  add column if not exists consumed_at timestamptz;

alter table public.referrals
  add column if not exists consumed_by_quote_id uuid references public.quotes(id) on delete set null;

comment on column public.referrals.consumed_at is
  'When a link row was turned into a mention referral. NULL means still open. Only ever set on source=''link'' rows.';

comment on column public.referrals.consumed_by_quote_id is
  'The quote whose mention referral consumed this link row, so the two halves of one referral can be traced together.';

-- The prefill lookup filters on (source, status, consumed_at) and this table
-- is scanned on every quote-builder keystroke-with-debounce, so give it the
-- partial index that matches exactly the rows it wants: open link rows.
create index if not exists referrals_open_link_idx
  on public.referrals (source, status)
  where consumed_at is null;
