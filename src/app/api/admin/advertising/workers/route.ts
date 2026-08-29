import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  advertisingAppMetadata,
  advertisingMetadataIsSafe,
  validateAdvertisingCredentials,
} from '@/lib/auth/advertisingAccounts';
import {
  createAdvertisingWorker,
  getAdvertisingWorker,
  listAdvertisingWorkers,
  setAdvertisingWorkerActive,
  WorkerLoginTakenError,
} from '@/lib/advertising/workers';
import { logAdvertisingActivity } from '@/lib/advertising/activity';

export const runtime = 'nodejs';

/**
 * Advertising worker management — the ACCOUNT-CREATION DOOR the schema PR
 * deliberately did not ship (ops hub workstream B).
 *
 *   GET   /api/admin/advertising/workers — every worker + login state
 *   POST  /api/admin/advertising/workers — add a worker; optionally mint
 *         their advertising-role login in the same step
 *   PATCH /api/admin/advertising/workers — one edit at a time: active flag,
 *         password reset, or minting a login for a row that has none
 *
 * requireAdmin only. Mirrors /api/admin/staff's posture: the auth id a
 * password reset targets always comes from the WORKER ROW, never the body;
 * a minted login that cannot be attached is rolled back rather than left
 * orphaned holding the email address.
 */

const MIN_PASSWORD = 8;

export async function GET() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  const workers = await listAdvertisingWorkers({ includeInactive: true });

  // Login emails for display: resolve each linked auth user. Small population.
  const emails = new Map<string, string | null>();
  if (sb) {
    await Promise.all(
      workers
        .filter((w) => w.authUserId)
        .map(async (w) => {
          const { data } = await sb.auth.admin.getUserById(w.authUserId!);
          emails.set(w.authUserId!, data?.user?.email ?? null);
        }),
    );
  }

  return NextResponse.json({
    workers: workers.map((w) => ({
      id: w.id,
      displayName: w.displayName,
      active: w.active,
      isTest: w.isTest,
      hasLogin: w.authUserId !== null,
      email: w.authUserId ? (emails.get(w.authUserId) ?? null) : null,
    })),
  });
}

async function mintLogin(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  workerId: string,
  displayName: string,
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const meta = advertisingAppMetadata(displayName);
  if (!advertisingMetadataIsSafe(meta)) {
    console.error('advertising workers: refusing unsafe metadata');
    return { ok: false, status: 500, error: 'Internal role configuration error' };
  }

  const { data: created, error: createError } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: meta,
  });
  if (createError || !created?.user) {
    const message = createError?.message ?? 'Failed to create the login';
    const conflict = /already|exists|registered/i.test(message);
    return {
      ok: false,
      status: conflict ? 409 : 500,
      error: `${displayName} was saved, but the login was not created: ${message}`,
    };
  }

  // Attach via the data layer; any failure rolls the fresh login back so it
  // never lingers orphaned (invisible here, squatting on the email).
  try {
    const db = getSupabaseServiceClient();
    if (!db) throw new Error('service client unavailable');
    const { data, error } = await db
      .from('advertising_workers')
      .update({ auth_user_id: created.user.id })
      .eq('id', workerId)
      .is('auth_user_id', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      await sb.auth.admin.deleteUser(created.user.id).catch(() => {});
      return {
        ok: false,
        status: 409,
        error: `${displayName} was given a login by someone else just now. Reload and check.`,
      };
    }
  } catch (e) {
    await sb.auth.admin.deleteUser(created.user.id).catch(() => {});
    console.error('advertising workers link:', e instanceof Error ? e.message : e);
    return {
      ok: false,
      status: 500,
      error: `${displayName} was saved, but the login could not be attached and was rolled back.`,
    };
  }
  return { ok: true };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as
    | { displayName?: unknown; email?: unknown; password?: unknown; isTest?: unknown }
    | null;
  const displayName = String(body?.displayName ?? '').trim();
  if (!displayName) {
    return NextResponse.json({ error: 'Enter their name.' }, { status: 400 });
  }

  const email = String(body?.email ?? '').trim();
  const password = String(body?.password ?? '');
  const wantsLogin = email !== '' || password !== '';
  if (wantsLogin) {
    const guard = validateAdvertisingCredentials({ email, password });
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 400 });
  }

  try {
    const worker = await createAdvertisingWorker({
      displayName,
      isTest: body?.isTest === true,
    });

    await logAdvertisingActivity({
      actor: auth.operator.id,
      action: 'worker_created',
      workerId: worker.id,
      detail: { displayName: worker.displayName },
    });

    if (wantsLogin) {
      const minted = await mintLogin(sb, worker.id, worker.displayName, email, password);
      if (!minted.ok) {
        // The worker row stands with no login — visible as "No login yet".
        return NextResponse.json({ worker, error: minted.error }, { status: minted.status });
      }
    }

    const fresh = await getAdvertisingWorker(worker.id);
    return NextResponse.json({ worker: fresh ?? worker }, { status: 201 });
  } catch (e) {
    if (e instanceof WorkerLoginTakenError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error('POST /api/admin/advertising/workers:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to add the worker' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as
    | { workerId?: unknown; active?: unknown; password?: unknown; email?: unknown }
    | null;
  const workerId = String(body?.workerId ?? '').trim();
  if (!workerId) return NextResponse.json({ error: 'Choose a worker.' }, { status: 400 });

  const worker = await getAdvertisingWorker(workerId);
  if (!worker) return NextResponse.json({ error: 'That is not an advertising worker.' }, { status: 404 });

  try {
    if (body?.password !== undefined && body?.email === undefined) {
      // PASSWORD RESET for an existing login. The auth id comes from the
      // worker row, never the body.
      const password = String(body.password ?? '');
      if (password.length < MIN_PASSWORD) {
        return NextResponse.json(
          { error: `Password must be at least ${MIN_PASSWORD} characters.` },
          { status: 400 },
        );
      }
      if (!worker.authUserId) {
        return NextResponse.json(
          { error: `${worker.displayName} has no login yet — mint one with email + password.` },
          { status: 409 },
        );
      }
      const { error } = await sb.auth.admin.updateUserById(worker.authUserId, { password });
      if (error) {
        console.error('PATCH advertising workers password:', error.message);
        return NextResponse.json({ error: 'Failed to reset the password' }, { status: 500 });
      }
      return NextResponse.json({ worker });
    }

    if (body?.email !== undefined || body?.password !== undefined) {
      // MINT a login for a worker who has none yet.
      const email = String(body?.email ?? '').trim();
      const password = String(body?.password ?? '');
      const guard = validateAdvertisingCredentials({ email, password });
      if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 400 });
      if (worker.authUserId) {
        return NextResponse.json(
          { error: `${worker.displayName} already has a login. Use a password reset instead.` },
          { status: 409 },
        );
      }
      const minted = await mintLogin(sb, worker.id, worker.displayName, email, password);
      if (!minted.ok) return NextResponse.json({ error: minted.error }, { status: minted.status });
      const fresh = await getAdvertisingWorker(worker.id);
      return NextResponse.json({ worker: fresh ?? worker });
    }

    if (typeof body?.active === 'boolean') {
      const updated = await setAdvertisingWorkerActive(workerId, body.active);
      if (!updated) return NextResponse.json({ error: 'That is not an advertising worker.' }, { status: 404 });
      return NextResponse.json({ worker: updated });
    }

    return NextResponse.json(
      { error: 'Nothing to update. Send active, password, or email + password.' },
      { status: 400 },
    );
  } catch (e) {
    console.error('PATCH /api/admin/advertising/workers:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to update the worker' }, { status: 500 });
  }
}
