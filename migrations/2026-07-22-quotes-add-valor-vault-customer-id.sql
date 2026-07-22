-- #161 "both vaults" decision (2026-07-22): the customer id Valor's OWN Vault
-- product assigns once a card is registered there (addcustomer), distinct from
-- valor_vault_token (the raw payment token captured via the redirect_url path).
alter table quotes add column if not exists valor_vault_customer_id text;
