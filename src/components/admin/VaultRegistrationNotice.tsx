// #171g — surfaces a Valor Vault registration failure that was previously
// console.warn-only (the webhook's best-effort vault hook, #161 "both
// vaults" decision — src/app/api/integrations/valor/webhook/route.ts). Shown
// on the admin quote detail page's payment section, styled to match the
// existing "Card declined" amber notice on the same page.
//
// Deliberately NOT a new migration: the quote row already carries both
// columns this reads (valor_vault_token, valor_vault_customer_id).
export type VaultRegistrationNoticeProps = {
  depositPaidAt: string | null;
  valorVaultToken: string | null;
  valorVaultCustomerId: string | null;
};

export function VaultRegistrationNotice({
  depositPaidAt,
  valorVaultToken,
  valorVaultCustomerId,
}: VaultRegistrationNoticeProps) {
  const showNotice = !!depositPaidAt && !!valorVaultToken && !valorVaultCustomerId;
  if (!showNotice) return null;

  return (
    <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      Card saved, but Valor Vault registration didn&apos;t complete — the token still works for charging.
    </div>
  );
}
