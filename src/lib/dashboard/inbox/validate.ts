// Shared input guards for the dashboard routes. The dashboard's row ids are all
// Postgres uuids (gen_random_uuid); validating the shape lets a malformed id fail
// fast with a clean 400 instead of a downstream 503/500 from the DB.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
