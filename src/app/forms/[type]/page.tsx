// Embeddable non-lead forms (#195), iframed by yulelovelights.com.
//
// /forms/newsletter?variant=footer&theme=dark&compact=1   → footer signup
// /forms/newsletter                                       → newsletter page
// /forms/careers | /forms/intern | /forms/nomination
//
// Framing is allowed only for our own marketing origins (see next.config.ts,
// which sends frame-ancestors for /forms/:path* exactly as it already does for
// /estimate). The portal is never frameable: its URLs carry the quote UUID.

import { notFound } from 'next/navigation';
import SiteForm, { type FormType } from './SiteForm';

const TYPES: FormType[] = ['newsletter', 'careers', 'intern', 'nomination'];

export const metadata = {
  // The root layout advertises the OPERATOR app, whose manifest start_url is
  // '/' — the login screen for anyone who is not staff. This page is public, so
  // it drops the manifest rather than inheriting it: a visitor who adds it to
  // their home screen gets a shortcut back to this page, not an app that opens
  // our login. null is Next's remove-this-field value, not merely an absent key.
  // The apple-touch-icon is deliberately still inherited, so they get the YLL
  // logo rather than a screenshot of the page.
  manifest: null,
  title: 'Yule Love Lights',
  robots: { index: false, follow: false },
};

export default async function FormEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { type } = await params;
  const sp = await searchParams;

  if (!TYPES.includes(type as FormType)) notFound();
  const formType = type as FormType;

  const variantRaw = typeof sp.variant === 'string' ? sp.variant : '';
  const formVariant = (variantRaw || `${formType}-page`).slice(0, 50);
  const theme = sp.theme === 'dark' ? 'dark' : 'light';
  // compact is the inline footer layout, which puts the submit button beside
  // the email box. That only makes sense for the one-field newsletter form; on
  // an application it would strand the button above the remaining fields, so it
  // is ignored elsewhere rather than trusted from the query string.
  const compact = (sp.compact === '1' || sp.compact === 'true') && formType === 'newsletter';

  return (
    <>
      {/* These routes exist to be iframed. The root layout paints the operator
          surface's cream background onto <body>, and that cream showed through
          the embed, so the dark theme's white text sat on a near-white field
          and the email placeholder was invisible in the site footer. The host
          page's background is the background. */}
      <style>{'body.operator-surface { background: transparent; }'}</style>
      <main
        style={{
          margin: 0,
          // No padding: the reported height measures the FORM, so any padding
          // on this wrapper is height the parent frame never accounts for, and
          // the form ends up with its own scrollbar inside the embed (the
          // nomination form overflowed by exactly this 8px). Spacing around the
          // form belongs to the page doing the embedding, not to the embed.
          padding: 0,
          background: 'transparent',
        }}
      >
        <SiteForm formType={formType} formVariant={formVariant} theme={theme} compact={compact} />
      </main>
    </>
  );
}
