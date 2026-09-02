// One place that knows the shape of a HighLevel contact URL.
//
// This pattern was written out by hand in two places before this module
// existed: the "View in HighLevel" button on the customer detail page
// (src/app/customers/[contactId]/page.tsx) and the leads admin table
// (src/app/admin/leads/LeadsAdminClient.tsx). Both now call in here, so the
// URL shape is stated once and a change to it cannot reach one surface and
// miss the other.
//
// Deliberately NOT under src/lib/integrations/**: that path is a shared
// ownership path in AGENTS.md, and this is a pure string builder with no
// HighLevel API involvement at all.
//
// The location id is not a secret. It is visible in every HighLevel URL a
// staffer already looks at. It still comes from the server, because reading
// process.env in a module a client component imports is its own bug (see the
// client/server boundary note in AGENTS.md).

/**
 * The HighLevel app URL for one contact. Pure: it takes an already-resolved
 * location id rather than reading the environment, so a client component can
 * call it with a value handed down from the server.
 */
export function highLevelContactUrl(locationId: string, contactId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${encodeURIComponent(contactId)}`;
}

/**
 * The configured HighLevel location id, or null when this environment has
 * none. SERVER ONLY: it reads process.env, so never import it into a module
 * a client component pulls in. Client code receives the built URL, or the
 * resolved location id, from the server instead.
 */
export function highLevelLocationId(): string | null {
  return process.env.HIGHLEVEL_LOCATION_ID ?? null;
}

/**
 * The contact URL built from the environment's location id, or null when
 * either the location id or the contact id is missing. SERVER ONLY, for the
 * same reason as highLevelLocationId above.
 */
export function highLevelContactUrlFromEnv(contactId: string | null): string | null {
  const locationId = highLevelLocationId();
  if (!locationId || !contactId) return null;
  return highLevelContactUrl(locationId, contactId);
}
