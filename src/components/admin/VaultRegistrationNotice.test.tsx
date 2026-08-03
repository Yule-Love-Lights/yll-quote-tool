// #171g — smoke coverage for the admin quote detail page's Vault
// registration notice. Renders with react-dom/server (same approach as
// ReferralCreditBanner.test.tsx / ReferredByPicker.test.tsx) — a static
// prop-driven presentational component, no need for a DOM environment.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VaultRegistrationNotice } from './VaultRegistrationNotice';

const ALL_CONDITIONS_HOLD = {
  depositPaidAt: '2026-07-30T12:00:00Z',
  valorVaultToken: 'vault_abc',
  valorVaultCustomerId: null,
};

describe('VaultRegistrationNotice', () => {
  it('renders the amber notice when the deposit is paid, a token is on file, and Vault registration never completed', () => {
    const html = renderToStaticMarkup(<VaultRegistrationNotice {...ALL_CONDITIONS_HOLD} />);
    expect(html).toContain("Valor Vault registration didn");
    expect(html).toContain('the token still works for charging');
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
});
