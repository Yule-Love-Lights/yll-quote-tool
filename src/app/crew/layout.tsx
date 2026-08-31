// Segment layout for the signed-link crew surface. Markup passthrough; it exists
// only to drop the operator app's web manifest.
//
// The root layout advertises the QUOTE TOOL app, whose manifest start_url is '/'
// — the operator login for anyone who is not office staff. /crew is public
// (operatorGate allows /crew and /crew/**) and is reached from a texted signed
// link, so a crew member who adds it to their home screen would otherwise get an
// icon that opens our login screen instead of their day. null is Next's
// remove-this-field value, not merely an absent key.
//
// The apple-touch-icon is deliberately left inherited: they still get the YLL
// logo rather than a screenshot of the page.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  manifest: null,
};

export default function CrewLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
