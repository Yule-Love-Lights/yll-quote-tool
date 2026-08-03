// #171g — smoke coverage for the admin quote detail page's Vault
// registration notice. Renders with react-dom/server (same approach as
// ReferralCreditBanner.test.tsx / ReferredByPicker.test.tsx) — a static
// prop-driven presentational component, no need for a DOM environment.
//
// #663 review: vaultRegisterEnabled is a plain boolean prop (the caller
// resolves isVaultRegisterEnabled() server-side and passes the result in),
// so the flag-off suppression is directly testable here via props — no env
// var mocking or contortion needed.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VaultRegistrationNotice } from './VaultRegistrationNotice';

const ALL_CONDITIONS_HOLD = {
  vaultRegisterEnabled: true,
  depositPaidAt: '2026-07-30T12:00:00Z',
  valorVaultToken: 'vault_abc',
  valorVaultCustomerId: null,
};

describe('VaultRegistrationNotice', () => {
  it('renders the amber notice when armed, the deposit is paid, a token is on file, and Vault registration has not completed', () => {
    const html = renderToStaticMarkup(<VaultRegistrationNotice {...ALL_CONDITIONS_HOLD} />);
    expect(html).toContain("Valor Vault registration hasn");
    expect(html).toContain('may still be running');
    expect(html).toContain('the saved card');
    expect(html).toContain('token still works for charging');
  });

  it('renders nothing when the deposit is not yet paid', () => {
    const html = renderToStaticMarkup(
      <VaultRegistrationNotice {...ALL_CONDITIONS_HOLD} depositPaidAt={null} />,
    );
    expect(html).toBe('');
  });

  it('renders nothing when there is no vault token on file', () => {
    const html = renderToStaticMarkup(
      <VaultRegistrationNotice {...ALL_CONDITIONS_HOLD} valorVaultToken={null} />,
    );
    expect(html).toBe('');
  });

  it('renders nothing once Valor Vault registration HAS completed (a customer id is on file)', () => {
    const html = renderToStaticMarkup(
      <VaultRegistrationNotice {...ALL_CONDITIONS_HOLD} valorVaultCustomerId="vc-1" />,
    );
    expect(html).toBe('');
  });

  // #663 review, technical MED: when the integration is unarmed (flag off or
  // auth vars missing), the webhook never ATTEMPTS registration — every
  // deposit-paid quote would sit at exactly this trio (token set, customer id
  // null) forever, which would otherwise read as a false failure on every
  // single quote. No notice at all when unarmed, even though the other three
  // conditions all hold.
  it('renders nothing when Vault registration is not armed, even though the token/deposit-paid/no-customer-id trio holds', () => {
    const html = renderToStaticMarkup(
      <VaultRegistrationNotice {...ALL_CONDITIONS_HOLD} vaultRegisterEnabled={false} />,
    );
    expect(html).toBe('');
  });
});
