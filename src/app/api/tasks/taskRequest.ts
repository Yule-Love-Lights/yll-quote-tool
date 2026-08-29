// Shared request/response helpers for the Office Tasks routes (GET/POST
// /api/tasks, PATCH /api/tasks/[id]). Mirrors yll-call-copilot's
// src/app/api/tasks/taskRequest.ts — this repo's own uuid/error-code
// conventions don't need reinventing here, but the file stays local to this
// route rather than reaching into another owner's module (e.g. the inbox's
// isUuid) to keep Office Tasks self-contained.

import { NextRequest, NextResponse } from 'next/server';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * The client-supplied idempotency key (a uuid the client mints once per
 * logical action and reuses on retry — see OfficeTasksCard's
 * createKeyRef/actionKeysRef). null when missing or malformed.
 */
export function readIdempotencyKey(request: NextRequest): string | null {
  const value = request.headers.get('x-idempotency-key')?.trim() ?? '';
  return isUuid(value) ? value : null;
}

export function taskError(code: string, message: string, status: number) {
  const response = NextResponse.json({ error: { code, message } }, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
