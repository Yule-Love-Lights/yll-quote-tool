// The office phone, for the two places on this route that need a way out: the
// fallback line under the booking widget, and the branded 404.
//
// Same shape as src/app/refer/[code]/not-found.tsx, which is where this pattern
// comes from: an env override if one is set, otherwise the number that also
// lives in MOCK_TEAM and is already printed on every customer portal.
export const OFFICE_PHONE = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
export const OFFICE_TEL_HREF = `tel:${OFFICE_PHONE.replace(/[^\d+]/g, '')}`;
export const MARKETING_SITE_URL = 'https://yulelovelights.com';
