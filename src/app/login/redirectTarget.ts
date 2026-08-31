// Split out of page.tsx when that page became a server component (it needs
// generateMetadata, which a 'use client' module cannot export). Pure function,
// no React, so both the client form and the tests import it directly. Copied
// verbatim from the committed page.tsx, comment and all: nothing about the
// guard itself changed.

// WT-61: `from.startsWith('/')` alone lets a protocol-relative value like
// `//evil.com/x` through — the browser treats a leading `//` as "same scheme,
// different host", so `router.replace` navigates off-origin (open redirect /
// phishing). Require a single leading slash: same-origin path, not a
// scheme-relative host. Also reject the `/\host` backslash form AND any ASCII
// tab/newline/CR. The WHATWG URL parser normalizes a backslash to a slash and
// strips control chars before parsing, so `/\evil.com`, `/\/evil.com`, and
// `/%09/evil.com` all re-form as a protocol-relative host and hard-navigate
// off-origin. No legitimate same-origin path contains them.
export function safeRedirectTarget(target: string): string {
  if (!target.startsWith('/')) return '/';
  if (/[\t\n\r]/.test(target)) return '/';
  if (target[1] === '/' || target[1] === '\\') return '/';
  return target;
}
