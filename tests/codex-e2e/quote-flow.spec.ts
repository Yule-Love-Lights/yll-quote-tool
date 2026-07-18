import { expect, test } from '@playwright/test';

const requiredEnvironment = [
  'TEST_LOGIN_EMAIL',
  'TEST_LOGIN_PASSWORD',
  'TEST_CUSTOMER_EMAIL',
] as const;
const emailEnvironment = ['TEST_LOGIN_EMAIL', 'TEST_CUSTOMER_EMAIL'] as const;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 6;

function required(name: (typeof requiredEnvironment)[number]): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const auditDate = process.env.CODEX_AUDIT_DATE ?? new Date().toISOString().slice(0, 10);
const testQuoteTitle = `TEST-CODEX-${auditDate}`;

test.describe.serial('Codex production quote audit', () => {
  let quoteId = '';
  let portalUrl = '';

  test.beforeAll(() => {
    const missing = requiredEnvironment.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`Production verifier blocked. Missing: ${missing.join(', ')}`);
    }
    const invalidEmails = emailEnvironment.filter(
      (name) => !EMAIL_RE.test(process.env[name] ?? ''),
    );
    if (invalidEmails.length > 0) {
      throw new Error(
        `Production verifier blocked. Invalid email shape: ${invalidEmails.join(', ')}`,
      );
    }
    if ((process.env.TEST_LOGIN_PASSWORD ?? '').length < MIN_PASSWORD_LENGTH) {
      throw new Error('Production verifier blocked. Invalid length: TEST_LOGIN_PASSWORD');
    }
  });

  test('team member creates, designs, prices, and sends a test quote', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(required('TEST_LOGIN_EMAIL'));
    await page.locator('#password').fill(required('TEST_LOGIN_PASSWORD'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/');

    await page.goto('/quote/new?test=1');
    await expect(page.getByText('Test Mode')).toBeVisible();

    await page.getByPlaceholder('Jane Smith (optional)').fill(testQuoteTitle);
    await page.getByPlaceholder('jane@example.com').fill(required('TEST_CUSTOMER_EMAIL'));
    await page
      .getByPlaceholder('123 Main St, Smithtown, NY 11787')
      .fill('1600 Pennsylvania Avenue NW, Washington, DC 20500');

    await page.getByRole('button', { name: /Analyze from Address/ }).click();
    await expect(page.getByText(/Analysis complete/i)).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

    const calculateResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/quote',
    );
    await page.getByRole('button', { name: 'Calculate Quote' }).click();
    const calculateResponse = await calculateResponsePromise;
    expect(calculateResponse.ok()).toBeTruthy();

    const calculated = (await calculateResponse.json()) as {
      persisted?: boolean;
      quoteId?: string | null;
    };
    expect(calculated.persisted).toBe(true);
    expect(calculated.quoteId).toBeTruthy();
    quoteId = calculated.quoteId as string;
    portalUrl = new URL(`/portal/${quoteId}`, page.url()).toString();
    test.info().annotations.push({
      type: 'production-test-quote',
      description: `${testQuoteTitle} | ${quoteId}`,
    });
    console.log(`CODEX_TEST_QUOTE=${testQuoteTitle}|${quoteId}`);

    await expect(page.getByRole('heading', { name: 'Send Quote to Customer' })).toBeVisible();

    const sendResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/quotes/${quoteId}/send`,
    );
    await page.getByRole('button', { name: /Send Quote to Customer/ }).click();
    const sendResponse = await sendResponsePromise;
    expect(sendResponse.ok()).toBeTruthy();
    const sent = (await sendResponse.json()) as { ok?: boolean };
    expect(sent.ok).toBe(true);
    await expect(page.getByRole('button', { name: /Sent/ })).toBeVisible();
  });

  test('customer selects a package, signs, approves, and reaches confirmation', async ({
    browser,
  }) => {
    expect(portalUrl).toBeTruthy();
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(portalUrl);
    await expect(page.getByRole('heading', { name: /Here's your home,/i })).toBeVisible();

    const packageGroup = page.getByRole('radiogroup', {
      name: 'Choose your lighting package',
    });
    await packageGroup.scrollIntoViewIfNeeded();
    const alternatePackage = packageGroup.locator('[role="radio"][aria-checked="false"]').first();
    await expect(alternatePackage).toBeVisible();
    await alternatePackage.click();
    await expect(alternatePackage).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('button', { name: 'Approve quote' }).last().click();
    await page.getByLabel('Type your full name to sign').fill('Codex Test Customer');
    await page.getByRole('button', { name: 'Confirm approval' }).click();

    await page.waitForURL(/\/portal\/[^/]+\/approved$/, { timeout: 120_000 });
    await expect(page.getByRole('heading', { name: /You're booked!/i })).toBeVisible();

    await context.close();
  });
});
