-- =====================================================================
-- Bouncie OAuth token storage (ledger row 403, phase 3a).
--
-- WHY THE DATABASE AND NOT AN ENV VAR. Gmail gets away with a refresh token in
-- the environment because that token is effectively permanent. Bouncie's is not:
-- refreshing CONSUMES the refresh token and returns a new one, and an unused
-- refresh token expires on its own. A value that changes on every use cannot
-- live in a deploy-time variable, so it has to be written somewhere the running
-- app can update.
--
-- WHY THIS TABLE AND NOT A NEW ONE. `integration_tokens` already exists with
-- exactly the right shape and RLS posture (service-role only, deny-all to
-- authenticated). It was built for Gmail and then never used — zero rows,
-- measured before writing this. Adding a second token table alongside a dormant
-- correct one would be how a schema ends up with two of everything.
--
-- ABOUT `refresh_token_enc`. That column has carried the comment "encrypted at
-- rest (Vault/pgcrypto)" since it was created, and nothing ever implemented it.
-- As of this migration that promise becomes true: `src/lib/crypto/secretBox.ts`
-- does AES-256-GCM with a key from the environment, and the writer refuses to
-- store anything if the key is missing. The column name now describes reality.
--
-- HOW TO APPLY — READ THIS, IT IS NOT FULLY SELF-APPLYING.
--
-- The three nullable ADD COLUMNs ARE on AGENTS.md's safe/additive allowlist:
-- the table has zero rows (measured), nothing is altered or dropped, and no
-- existing column changes type or nullability.
--
-- The trigger and its function are NOT. That allowlist is explicitly exhaustive
-- rather than illustrative, and it does not include creating functions or
-- triggers. An earlier draft of this file claimed the whole migration was
-- allowlisted; that was wrong, and the S68 admin lens caught it. Saying "safe"
-- about something the rule does not cover is how the rule stops meaning
-- anything.
--
-- So: this migration needs the dev's explicit go before being applied, on
-- account of the trigger. If you would rather not grant that, apply only the
-- three ADD COLUMNs — the application code works without the trigger, and the
-- only loss is that `updated_at` stays stale, which costs a diagnostic signal
-- during an outage rather than any behaviour.
-- =====================================================================

-- The short-lived half of the pair. Encrypted with the same box as the refresh
-- token: it is a live credential for as long as it lasts, and "it expires soon"
-- is not a reason to store it in the clear.
alter table public.integration_tokens
  add column if not exists access_token_enc text;

-- When the access token stops working. Nullable because a row may exist holding
-- only a refresh token (the Gmail shape), and because a provider that does not
-- tell us the lifetime should leave this NULL rather than get a guessed value.
alter table public.integration_tokens
  add column if not exists access_token_expires_at timestamptz;

-- What the grant covers, as the provider described it. Recorded rather than
-- assumed, so a later permission problem can be diagnosed from the row instead
-- of by re-running the whole authorization flow to find out what we asked for.
alter table public.integration_tokens
  add column if not exists scope text;

-- Rotation happens on every refresh, so "when did this last change" is the first
-- question during an outage. The table has updated_at but nothing maintained it.
create or replace function integration_tokens_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists integration_tokens_updated_at_trigger on public.integration_tokens;
create trigger integration_tokens_updated_at_trigger
  before update on public.integration_tokens
  for each row execute function integration_tokens_set_updated_at();
