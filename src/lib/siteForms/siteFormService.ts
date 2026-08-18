// Non-lead website form submissions (#195): newsletter signups, job and intern
// applications, and Light Up For Hope nominations.
//
// THE POINT OF THIS MODULE is what it does NOT do. The sales path
// (src/lib/leads/leadService.ts) creates a GHL opportunity in a service
// pipeline and applies the 'new lead' tag, and that tag enrolls the contact in
// SMS drip campaigns. None of these forms are sales leads:
//
//   * a newsletter signup asked for email, not a salesperson
//   * a job applicant is not a customer
//   * a nominator is offering to help a neighbour
//
// So this module upserts a tagged CONTACT and stops. It imports neither
// createOpportunity nor findOrCreateOpportunityForContact, and there is a test
// asserting the 'new lead' tag can never appear here.
//
// One more rule, enforced below: for a nomination, only the SUBMITTER becomes a
// GHL contact. The nominated person's details are stored so staff can follow
// up by hand, but that person never consented to anything, so they are never
// created as a contact and never enter any automation.

import { upsertContact, addContactTags } from '@/lib/integrations/highlevel';

export const SITE_FORM_TYPES = ['newsletter', 'careers', 'intern', 'nomination'] as const;
export type SiteFormType = (typeof SITE_FORM_TYPES)[number];

export function asSiteFormType(value: unknown): SiteFormType | null {
  return typeof value === 'string' && (SITE_FORM_TYPES as readonly string[]).includes(value)
    ? (value as SiteFormType)
    : null;
}

// The tag each form type puts on the GHL contact. Deliberately none of these
// is 'new lead' — see siteFormService.test.ts, which fails if that ever
// changes. These are descriptive tags for segmenting, not pipeline triggers.
export const SITE_FORM_TAGS: Record<SiteFormType, string> = {
  newsletter: 'newsletter-signup',
  careers: 'job-applicant',
  intern: 'intern-applicant',
  nomination: 'hope-nominator',
};

// Tags that belong to the sales path and must never be applied from here.
export const FORBIDDEN_SALES_TAGS = ['new lead'] as const;

export type SiteSubmissionInput = {
  formType: SiteFormType;
  formVariant: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  payload?: Record<string, unknown>;
  consent?: boolean;
};

/**
 * Which fields a given form type requires. The footer newsletter is a single
 * email box (exactly as the Gravity Form was), so demanding a name there would
 * break the placement it replaces.
 */
export function requiredFieldsFor(formType: SiteFormType): {
  name: boolean;
  phone: boolean;
  consent: boolean;
} {
  switch (formType) {
    case 'newsletter':
      // Footer variant is email-only; the newsletter PAGE form asks for name
      // and phone, but they stay optional server-side so a future placement
      // can drop them without a deploy.
      return { name: false, phone: false, consent: false };
    case 'careers':
    case 'intern':
      // Applications carried a required consent checkbox in Gravity Forms.
      return { name: true, phone: true, consent: true };
    case 'nomination':
      return { name: true, phone: true, consent: true };
  }
}

/**
 * Splits a display name into the first/last GHL wants. GHL treats a missing
 * lastName as blank rather than erroring, so a single-word name is fine.
 */
export function splitName(name: string | null | undefined): {
  firstName?: string;
  lastName?: string;
} {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return {};
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export type SiteFormGhlResult = {
  contactId: string | null;
  tags: string[];
};

/**
 * Upserts the SUBMITTER as a GHL contact and tags it by form type.
 *
 * Never creates an opportunity. Never applies a sales tag. For a nomination,
 * receives only the submitter's own details: the caller must not pass the
 * nominee's contact information here.
 */
export async function syncSubmissionToGhl(input: {
  formType: SiteFormType;
  email: string;
  name?: string | null;
  phone?: string | null;
}): Promise<SiteFormGhlResult> {
  const tag = SITE_FORM_TAGS[input.formType];
  const { firstName, lastName } = splitName(input.name);

  const { contact } = await upsertContact({
    email: input.email,
    phone: input.phone || undefined,
    firstName,
    lastName,
    source: `website ${input.formType}`,
  });

  const contactId = (contact as { id?: string } | undefined)?.id ?? null;
  if (!contactId) return { contactId: null, tags: [] };

  await addContactTags(contactId, [tag]);
  return { contactId, tags: [tag] };
}
