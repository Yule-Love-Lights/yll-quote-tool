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

// The nominated household, created as a contact when the nominator confirms they
// have permission for us to contact them (Naldo, 2026-08-17). A separate tag so a
// nominee is never mistaken for the person who sent the nomination, and so this
// audience can be targeted or suppressed on its own.
export const NOMINEE_TAG = 'hope-nominee';

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

/**
 * Creates the NOMINATED household as a GHL contact, tagged so it can enter the
 * Light Up For Hope automation.
 *
 * Only ever called when the nominator ticked the permission box on the form.
 * That gate exists for a plain reason: the nominee did not fill in this form and
 * did not ask to hear from us, and messaging people who never agreed is the kind
 * of thing that carries per-message penalties. The nominator confirming they have
 * the household's permission is what makes reaching out defensible, so the
 * caller MUST pass consent through rather than defaulting it on.
 */
export async function syncNomineeToGhl(input: {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  address?: string | null;
  consent: boolean;
}): Promise<SiteFormGhlResult> {
  if (!input.consent) return { contactId: null, tags: [] };
  // Nothing to create a contact from. A nomination can legitimately arrive with
  // only a name and address, and GHL needs an email or phone to be reachable.
  if (!input.email && !input.phone) return { contactId: null, tags: [] };

  const { firstName, lastName } = splitName(input.name);
  const { contact } = await upsertContact({
    email: input.email || undefined,
    phone: input.phone || undefined,
    firstName,
    lastName,
    address1: input.address || undefined,
    source: 'website hope nominee',
  });

  const contactId = (contact as { id?: string } | undefined)?.id ?? null;
  if (!contactId) return { contactId: null, tags: [] };

  await addContactTags(contactId, [NOMINEE_TAG]);
  return { contactId, tags: [NOMINEE_TAG] };
}
