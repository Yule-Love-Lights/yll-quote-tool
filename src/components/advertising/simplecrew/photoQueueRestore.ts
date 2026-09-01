// Pure logic for what happens to a photo that was on disk when the capture
// screen reopens (Naldo, 2026-08-31: offline durability for the field
// capture app). No storage access here on purpose, the same way
// cameraGps.ts keeps the send rule out of the component: this file just
// decides what a stored record MEANS, so it is testable without a browser.
// See photoQueueStorage.ts for the actual IndexedDB seam that calls it.
//
// The one hard case is a photo that was mid-upload when the app died. We
// truly cannot tell, from here, whether the server received it before the
// tab closed. Guessing wrong either drops paid work (never resend a photo
// that failed) or pays twice for one photo (resend one that already
// landed), so the app never guesses: it holds the photo and tells the
// worker to check before sending it again, the same wording the app
// already uses today for an ambiguous "sent, but no confirmation came
// back" response.

/** Every state a stored photo can be in. 'uploading' and 'discarded' only
 * ever exist in storage (never in the app's own status while running):
 * 'uploading' is what a photo looks like if the app dies mid-request, and
 * 'discarded' is the durable marker written just before the worker's
 * discard finishes deleting the record. */
export type StoredPhotoStatus = 'uploading' | 'waiting' | 'failed' | 'uploaded' | 'discarded';

/** The states a photo can be found in while it is still unsent. */
export type PendingStoredPhotoStatus = 'uploading' | 'waiting' | 'failed';

export type RestoredPhotoDecision = {
  /** What the restored queue item's status should show. */
  status: 'waiting' | 'failed';
  /** True: start sending again on its own. False: the worker has to tap
   * to send it, because we are not sure it did not already go through. */
  autoResume: boolean;
  error?: string;
};

const MAYBE_ALREADY_SENT =
  'This was sending when the app closed. It may have already gone through. Check the campaign, then try again.';

/** PURE. Decide how a single stored photo comes back to life. */
export function reconcileStoredPhoto(record: {
  status: PendingStoredPhotoStatus;
  error?: string;
}): RestoredPhotoDecision {
  if (record.status === 'uploading') {
    return { status: 'failed', autoResume: false, error: MAYBE_ALREADY_SENT };
  }
  if (record.status === 'failed') {
    return { status: 'failed', autoResume: false, error: record.error };
  }
  // 'waiting': the last known outcome was a plain, already-observed
  // failure worth retrying, so it resumes exactly like it would have if
  // the app had just stayed open through the wait.
  return { status: 'waiting', autoResume: true, error: record.error };
}

/** PURE. A record only reaches 'uploaded' or 'discarded' status in storage
 * because deleting it after the fact failed (a full quota, a tab dying
 * mid-cleanup). Either way it is finished work, not pending work, and must
 * never be treated as something still to send: an uploaded photo landing
 * again is a second pay claim, and a discarded photo coming back undoes
 * the worker's own decision to throw it away. */
export function isTerminalStoredStatus(status: StoredPhotoStatus): status is 'uploaded' | 'discarded' {
  return status === 'uploaded' || status === 'discarded';
}

/** PURE. Newest photo first, matching how a fresh shot is added to the
 * live queue, so a restore does not reorder what the worker already took. */
export function sortRestoredNewestFirst<T extends { capturedAt: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => b.capturedAt - a.capturedAt);
}

/** PURE. The plain-words banner telling the worker something is waiting
 * from before. Null when there is nothing to say. */
export function describeRestoredBanner(entries: { autoResume: boolean }[]): string | null {
  if (entries.length === 0) return null;
  const maybeSent = entries.filter((e) => !e.autoResume).length;
  const resuming = entries.length - maybeSent;
  const parts: string[] = [];
  if (resuming > 0) {
    parts.push(`${resuming} photo${resuming === 1 ? '' : 's'} from before ${resuming === 1 ? 'is' : 'are'} sending again`);
  }
  if (maybeSent > 0) {
    parts.push(
      `${maybeSent} photo${maybeSent === 1 ? '' : 's'} may have already gone through, check before resending`,
    );
  }
  return `${parts.join('. ')}.`;
}
