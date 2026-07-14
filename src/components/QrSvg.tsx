// Shared inline QR-code display (ledger #41 growth feature 2). Pure /
// presentational: the SVG string is generated server-side
// (src/lib/referralQr.ts — no browser canvas, no external QR service, since a
// strict CSP blocks remote calls) and handed down as a prop. This component
// just sizes it inside a white box (a QR code needs a light background to
// stay scannable regardless of the surrounding theme) and is otherwise
// theme-agnostic, so both the dark customer portal and the operator
// dashboard's --op-* styling can drop it in and add their own caption.

export function QrSvg({ svg, className = 'w-16 h-16' }: { svg: string; className?: string }) {
  return (
    <div
      className={`shrink-0 rounded-lg bg-white p-1.5 ${className}`}
      // Our OWN server-generated SVG string (src/lib/referralQr.ts) — never
      // user input — so dangerouslySetInnerHTML here is safe.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
