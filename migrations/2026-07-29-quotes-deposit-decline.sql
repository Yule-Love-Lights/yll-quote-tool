-- #175: staff notification for a DECLINED deposit/balance card charge — a
-- decline previously vanished into a console.warn; the quote sat approved-
-- but-unpaid with zero explanation until staff spotted it on the Valor
-- dashboard the next day (live incident, 2026-07-28). These three columns
-- let the webhook route stamp the decline and throttle a staff alert email
-- to at most once per hour per quote, and let the admin quote page show it.
--
-- deposit_declined_at / deposit_decline_code: fill-always (the latest
-- decline wins) — informational only, no CAS needed.
-- deposit_decline_notified_at: the throttle claim column — a guarded UPDATE
-- (`.is.null` OR'd with `.lt.<cutoff>`) claims this slot before the alert
-- email sends, so two concurrent webhook deliveries for the same decline
-- can't double-email.
--
-- Applied out-of-band directly on prod; this file documents it (model:
-- migrations/2026-07-28-customers-manual-years.sql).

alter table quotes add column if not exists deposit_declined_at timestamptz;
alter table quotes add column if not exists deposit_decline_code text;
alter table quotes add column if not exists deposit_decline_notified_at timestamptz;
