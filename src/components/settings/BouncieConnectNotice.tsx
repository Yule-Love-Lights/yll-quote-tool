// Renders the outcome of a Bouncie OAuth round trip on Settings → Accounts.
//
// WHY THIS EXISTS. The callback already redirected here with `?bouncie=<status>`
// and nothing read it, so connecting succeeded, failed, or was refused and the
// operator saw exactly the same thing either way: nothing. Two S68 lenses rated
// that HIGH independently, and it is this repo's recurring inert-fix class — a
// value produced with no consumer.
//
// The statuses are deliberately distinct because their FIXES are distinct.
// "Set an environment variable" and "go and look at the server logs" are
// different days, and a single "something went wrong" would flatten them.

const MESSAGES: Record<string, { tone: 'ok' | 'warn' | 'bad'; title: string; detail: string }> = {
  connected: {
    tone: 'ok',
    title: 'Bouncie connected',
    detail: 'Vehicle location can now be read. Nothing else needs doing.',
  },
  denied: {
    tone: 'warn',
    title: 'Bouncie access was not granted',
    detail: 'The approval screen was declined or closed. Start again when you are ready.',
  },
  bad_state: {
    tone: 'bad',
    title: 'That connection attempt was refused',
    detail:
      'The request did not match one started here, which can simply mean it sat too long before being approved. Start again from this page. If it keeps happening, say so rather than retrying.',
  },
  missing_code: {
    tone: 'bad',
    title: 'Bouncie did not send an approval code',
    detail: 'Nothing was stored. Start the connection again from this page.',
  },
  not_configured: {
    tone: 'bad',
    title: 'Bouncie is not configured on the server',
    detail:
      'BOUNCIE_CLIENT_ID, BOUNCIE_CLIENT_SECRET and BOUNCIE_REDIRECT_URI need setting before this can work.',
  },
  no_encryption_key: {
    tone: 'bad',
    title: 'The token encryption key is missing',
    detail:
      'TOKEN_ENCRYPTION_KEY is not set, so the connection was stopped BEFORE using up the approval code. Set it, redeploy, then try again.',
  },
  bad_credentials: {
    tone: 'bad',
    title: 'Bouncie rejected our app credentials',
    detail:
      'BOUNCIE_CLIENT_SECRET in Vercel does not match the CLIENT SECRET on the Bouncie app page. The usual cause: the API KEY was pasted instead — both hide behind SHOW buttons on the same page. Re-copy the CLIENT SECRET (under OAuth 2.0 Credentials), update Vercel, redeploy, then connect again.',
  },
  bouncie_down: {
    tone: 'warn',
    title: 'Bouncie had a problem on their end',
    detail:
      'Their server answered with an error, which is not something to fix here. Wait a few minutes and connect again. Nothing on our side changed.',
  },
  bouncie_unreachable: {
    tone: 'warn',
    title: 'Could not reach Bouncie',
    detail:
      'The connection to their server did not go through. Check the internet is up, wait a moment, and connect again. Nothing on our side changed.',
  },
  failed: {
    tone: 'bad',
    title: 'Connecting to Bouncie failed',
    detail:
      'The approval code could not be exchanged. It is now used up, so start again from this page. The server log has the reason.',
  },
};

const TONE_STYLE: Record<'ok' | 'warn' | 'bad', { border: string; background: string }> = {
  ok: { border: 'var(--brand-evergreen-3)', background: 'rgba(16, 122, 87, 0.08)' },
  warn: { border: '#b45309', background: 'rgba(180, 83, 9, 0.08)' },
  bad: { border: '#b91c1c', background: 'rgba(185, 28, 28, 0.08)' },
};

export function BouncieConnectNotice({ status }: { status?: string }) {
  if (!status) return null;
  const message = MESSAGES[status];
  // An unrecognised status still says something, rather than rendering nothing
  // and looking identical to the bug this component was written to fix.
  const shown = message ?? {
    tone: 'warn' as const,
    title: 'Bouncie connection returned an unexpected result',
    detail: `The server reported "${status}", which this page does not recognise.`,
  };
  const style = TONE_STYLE[shown.tone];

  return (
    <div
      role="status"
      className="mb-6 rounded-lg border p-4"
      style={{ borderColor: style.border, background: style.background }}
    >
      <p className="text-sm font-semibold mb-1">{shown.title}</p>
      <p className="text-sm opacity-80">{shown.detail}</p>
    </div>
  );
}
