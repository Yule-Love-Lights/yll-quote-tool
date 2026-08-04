// #171g — surfaces a Valor Vault registration failure that was previously
// console.warn-only (the webhook's best-effort vault hook, #161 "both
// vaults" decision — src/app/api/integrations/valor/webhook/route.ts). Shown
// on the admin quote detail page's payment section, styled to match the
// existing "Card declined" amber notice on the same page.
//
// Deliberately NOT a new migration: the quote row already carries both
// columns this reads (valor_vault_token, valor_vault_customer_id).
//
// #663 review — two caveats baked into the gate + copy:
//   1. `vaultRegisterEnabled` (the caller passes isVaultRegisterEnabled()):
//      when the integration is OFF (or its auth vars are missing), the
//      webhook never even ATTEMPTS registration — every deposit-paid quote
//      would otherwise sit at exactly the "token set, customer id null"
//      state this notice matches, falsely implying a live integration
//      failure. No notice at all when unarmed.
//   2. Copy says "hasn't completed" rather than "failed": the #171f reorder
//      moved the vault hook to run AFTER job creation + the notification
//      batch, widening the window where a staff refresh right after booking
//      catches a registration that's still genuinely in flight, not one
//      that's actually failed.
export type VaultRegistrationNoticeProps = {
  vaultRegisterEnabled: boolean;
  depositPaidAt: string | null;
  valorVaultToken: string | null;
  valorVaultCustomerId: string | null;
};

export function VaultRegistrationNotice({
  vaultRegisterEnabled,
  depositPaidAt,
  valorVaultToken,
  valorVaultCustomerId,
}: VaultRegistrationNoticeProps) {
  const showNotice =
    vaultRegisterEnabled && !!depositPaidAt && !!valorVaultToken && !valorVaultCustomerId;
  if (!showNotice) return null;

  return (
    <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      Valor Vault registration hasn&apos;t completed (it may still be running) — the saved card
      token still works for charging.
    </div>
  );
}
