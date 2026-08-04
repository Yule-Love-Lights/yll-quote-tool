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
  const compact = sp.compact === '1' || sp.compact === 'true';

  return (
    <main
      style={{
        margin: 0,
        padding: compact ? 0 : 4,
        background: 'transparent',
      }}
    >
      <SiteForm formType={formType} formVariant={formVariant} theme={theme} compact={compact} />
    </main>
  );
}
