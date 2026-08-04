-- Non-lead website form submissions (#195).
--
-- The marketing site has four forms that are NOT sales leads: the footer
-- newsletter signup, the newsletter page signup, job/intern applications, and
-- Light Up For Hope nominations. They used to be Gravity Forms; that plugin was
-- retired by #152 when lead capture moved to the custom embed, which left the
-- shortcodes printing raw text to visitors.
--
-- These deliberately do NOT reuse public.website_leads. A row there flows into
-- syncLeadToGhl(), which creates a GHL OPPORTUNITY in a service pipeline and
-- applies the 'new lead' tag — and that tag enrolls the contact in SMS drips.
-- Texting a person who signed up for a newsletter, applied for a job, or
-- nominated a neighbour would be wrong. Separate table, separate route,
-- separate GHL treatment (a tagged CONTACT only).
--
-- Note there is deliberately NO ghl_opportunity_id column: an opportunity can
-- never be attached to one of these rows even by mistake, because there is
-- nowhere to record it.
--
-- MIGRATION ORDER: new table, ships migration-first (the code reads and writes
-- it immediately).

create table if not exists public.site_submissions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  -- newsletter | careers | intern | nomination
  form_type      text not null,
  -- which placement it came from, e.g. 'footer', 'newsletter-page',
  -- 'careers-page', 'intern-page', 'hope-page'
  form_variant   text not null,

  -- Submitter. Only email is guaranteed: the footer newsletter form is a
  -- single email field, exactly as it was in Gravity Forms.
  name           text,
  email          text not null,
  phone          text,

  -- Everything form-specific: the application questions, and for a nomination
  -- the whole nominee block (their name, address, contact details, the story).
  -- Kept as jsonb so a new question does not need a schema change.
  payload        jsonb not null default '{}'::jsonb,

  -- Object path in the PRIVATE 'applications' storage bucket. Never a public
  -- URL: a resume is personal data and is served only through a short-lived
  -- signed URL generated for a signed-in staff user.
  resume_path    text,

  consent        boolean not null default false,
  landing_url    text,
  utm            jsonb,
  ip             text,

  -- GHL contact for the SUBMITTER only, tagged by form type. A nominated third
  -- party is never created as a contact: they did not consent to anything.
  ghl_contact_id text,
  -- pending | synced | skipped | spam | error
  sync_status    text not null default 'pending',
  sync_error     text,

  is_test        boolean not null default false
);

-- Newest-first admin view.
create index if not exists site_submissions_created_at_idx
  on public.site_submissions (created_at desc);

-- The rate-limit query (count from this IP in the last hour), mirroring the
-- website_leads approach: a DB count survives serverless cold starts and
-- multiple regions in a way an in-memory counter does not.
create index if not exists site_submissions_ip_created_at_idx
  on public.site_submissions (ip, created_at);

-- Admin filtering by form type.
create index if not exists site_submissions_form_type_created_at_idx
  on public.site_submissions (form_type, created_at desc);

-- Service-role only, same as website_leads: RLS on with no policies, so the
-- anon key can neither read nor write. Every access goes through the server.
alter table public.site_submissions enable row level security;
