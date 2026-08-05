// src/lib/integrations/botWriteTools.ts
// Execution for the text-ops bot's field-capture writes (completeInstall,
// Phase 2; captureLead, Phase 3 — both of the 2026-07-19 plan). Everything
// here runs ONLY after the dispatcher has checked the sender's role AND
// consumed their confirm-yes — nothing in this module gates itself, by
// design: the gates live in one place (botDispatch) so a new tool can't
// accidentally ship ungated.
//
// SCOPE NOTE — completeInstall deliberately does NOT mark the job installed.
// In this codebase "complete" (src/app/api/jobs/[id]/complete/route.ts) advances
// the job to requires_invoicing, CREATES THE INVOICE, moves the GHL card, and
// can settle and close the job. That is a money path in Jason's area and must
// not fire from a crew member's text off a ladder. The bot captures what the
// field knows (photos + material actually used); the office still completes the
// job in the admin UI.
//
// PHOTO TARGET: jobs have no photo storage of their own — designs.extra_photos
// is the only store — so install photos attach to the job's LINKED DESIGN,
// titled with the job number. That keeps them reachable from the job while
// feeding the design history the #155 rebooking wave reuses.

import { listFulfillmentCards } from '@/lib/inventory/jobs';
import { recordMaterialActuals, type MaterialActualLine } from '@/lib/inventory/materialActuals';
import { addDesignExtraPhoto } from '@/lib/designs';
import { downloadTelegramFile } from './telegramMedia';
import { syncFieldLeadToGhl, type FieldLeadInput } from '@/lib/leads/fieldLead';
import { SERVICE_FIELD_VALUE, type LeadService } from '@/lib/leads/leadService';

export type CompleteInstallArgs = {
  jobNumber: number;
  /**
   * Already RESOLVED to real catalog entries by the dispatcher (see
   * materialResolve.ts). The name travels with the sku because the confirm line
   * is the crew's only chance to catch a wrong match, and nobody on a ladder
   * recognises "20009-SPK".
   */
  materials: { sku: string; name: string; qty: number }[];
  note?: string | null;
  photoFileIds?: string[];
};

// A single message realistically carries a handful of photos; the cap stops a
// malformed args blob from turning into an unbounded upload loop.
const MAX_PHOTOS = 5;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The one-line confirm shown BEFORE anything runs. Must name every effect. */
export function summarizeCompleteInstall(
  args: CompleteInstallArgs,
  customerName?: string | null,
): string {
  const who = customerName ? ` (${customerName})` : '';
  const parts = [`Close out job #${args.jobNumber}${who}:`];

  if (args.materials.length) {
    // Names, not codes: this line is the human check on the model's match.
    parts.push(`log ${args.materials.map((m) => `${m.qty}× ${m.name || m.sku}`).join(', ')}`);
  } else {
    parts.push('log no material');
  }

  const photos = args.photoFileIds?.length ?? 0;
  if (photos) parts.push(`save ${plural(photos, 'photo')}`);
  if (args.note) parts.push(`note "${args.note}"`);

  return `${parts.join(' · ')} — reply yes to confirm.`;
}

/**
 * Record one install completion. Returns the plain-text reply for the crew.
 *
 * Photos are deduped by Telegram file id at the design layer, so a retry re-sends
 * the same shots harmlessly and a genuine follow-up (new material line + a new
 * photo on an already-recorded job) still attaches — attach is NOT gated on the
 * material claim, which would drop that follow-up photo silently.
 */
export async function runCompleteInstall(
  args: CompleteInstallArgs,
  recordedBy: string,
): Promise<string> {
  const card = (await listFulfillmentCards()).find((c) => c.jobNumber === args.jobNumber);
  if (!card) return `No active job #${args.jobNumber}.`;

  const lines: MaterialActualLine[] = args.materials.map((m) => ({
    sku: m.sku,
    qty: m.qty,
    rawText: args.note ?? null,
  }));

  const result = lines.length ? await recordMaterialActuals(card.id, lines, recordedBy) : null;

  // Always attach — dedup lives at the design layer (addDesignExtraPhoto keys on
  // the Telegram file id), so a retry with the same shots is a no-op and a
  // follow-up photo on an already-recorded job still lands.
  const photoResult = await attachPhotos(card.designId, args.jobNumber, args.photoFileIds ?? []);

  const out: string[] = [];
  if (!lines.length) {
    out.push(`Job #${args.jobNumber}: no material logged.`);
  } else if (!result) {
    // Null is a transient failure (no service client, or a work-order read that
    // failed) — say so plainly so the crew retries instead of assuming it saved.
    out.push(`Couldn't record materials for job #${args.jobNumber} — try again in a minute.`);
  } else if (result.alreadyDone) {
    out.push(`Job #${args.jobNumber} already had its materials recorded — stock not touched again.`);
  } else {
    const nameBySku = new Map(args.materials.map((m) => [m.sku, m.name || m.sku]));
    const label = (sku: string) => nameBySku.get(sku) ?? sku;

    out.push(`Job #${args.jobNumber}: logged ${plural(lines.length, 'material line')}.`);
    if (result.baselineUnavailable) {
      // Recorded but not applied. Say it plainly: a crew member who is told
      // nothing would assume the shelf count moved.
      out.push("Stock NOT adjusted — I couldn't read what this job was prepped against. Tell the office.");
    } else if (result.trueUps.length) {
      out.push(
        'Stock adjusted: ' +
          result.trueUps
            .map((t) => `${label(t.sku)} ${t.delta > 0 ? '+' : ''}${t.delta}`)
            .join(', '),
      );
    } else {
      out.push('Stock matched the estimate — no adjustment.');
    }
    if (result.skipped.length) {
      out.push(`Not stocked, recorded only: ${result.skipped.map(label).join(', ')}`);
    }
  }

  if (photoResult.saved) out.push(`Saved ${plural(photoResult.saved, 'photo')}.`);
  if (photoResult.failed) out.push(`${plural(photoResult.failed, 'photo')} failed to save.`);
  if (photoResult.noDesign) out.push('No design linked to this job, so photos were skipped.');

  return out.join('\n');
}

// ─── captureLead (Phase 3) ──────────────────────────────────────────────
// A crew installer texts in a brand-new lead met in the field. Unlike
// completeInstall, this tool needs an explicit CONSENT affirmation before the
// dispatcher will even stage the confirm (see summarizeCaptureLead below) —
// the bot must never enroll someone in SMS without the crew affirming the
// homeowner agreed. Naldo's locked decision: enrollment here means "tag for
// automation" (see fieldLead.ts), never a pipeline opportunity.

export type CaptureLeadArgs = {
  name: string;
  phone: string;
  address?: string | null;
  note?: string | null;
  service: LeadService;
};

/**
 * The one-line confirm shown BEFORE anything runs. Doubles as the CONSENT
 * affirmation — the crew's "yes" to this exact line is the consent record
 * (task #9, locked), so the wording must make that unmistakable rather than
 * reading like an ordinary "reply yes to confirm" prompt.
 */
export function summarizeCaptureLead(args: CaptureLeadArgs): string {
  const parts = [args.name, args.phone];
  if (args.address) parts.push(args.address);
  parts.push(SERVICE_FIELD_VALUE[args.service]);
  return `New field lead: ${parts.join(' · ')}. Reply YES only if they agreed to be contacted (they'll be enrolled in texts).`;
}

export type CaptureLeadResult = { reply: string; synced: boolean };

/**
 * Record one field-lead capture. Returns the plain-text reply for the crew
 * plus whether the sync fully succeeded (so the caller knows whether it's
 * safe to tell staff a new lead is enrolled — see botDispatch's captureLead
 * case, which only notifies on `synced`).
 *
 * Never throws into the webhook: syncFieldLeadToGhl's one THROWING call
 * (upsertContact) is caught here so a GHL hiccup degrades to a plain "try
 * again" reply rather than propagating, matching this module's fail-closed
 * style (mirrors runCompleteInstall never throwing).
 */
export async function runCaptureLead(args: CaptureLeadArgs): Promise<CaptureLeadResult> {
  const input: FieldLeadInput = {
    name: args.name,
    phone: args.phone,
    address: args.address ?? null,
    note: args.note ?? null,
    service: args.service,
  };

  let result;
  try {
    result = await syncFieldLeadToGhl(input);
  } catch (err) {
    console.error('[botWriteTools] captureLead sync failed:', err);
    return {
      reply: `Couldn't create the GHL contact for ${args.name} — try again in a minute.`,
      synced: false,
    };
  }

  if (result.status === 'error') {
    // The contact WAS created — say so, rather than implying total failure
    // and risking a duplicate contact on retry.
    return {
      reply: `Saved ${args.name}'s contact, but tagging/the note failed — tell the office to check GHL.`,
      synced: false,
    };
  }

  return {
    reply: `Got it — ${args.name} (${args.phone}) is in and enrolled in texts.`,
    synced: true,
  };
}

type PhotoResult = { saved: number; failed: number; noDesign: boolean };

async function attachPhotos(
  designId: string | null,
  jobNumber: number,
  fileIds: string[],
): Promise<PhotoResult> {
  if (!fileIds.length) return { saved: 0, failed: 0, noDesign: false };
  if (!designId) return { saved: 0, failed: 0, noDesign: true };

  let saved = 0;
  let failed = 0;
  const title = `Install photo — job #${jobNumber}`;

  for (const fileId of fileIds.slice(0, MAX_PHOTOS)) {
    try {
      const file = await downloadTelegramFile(fileId);
      if (!file) {
        failed += 1;
        continue;
      }
      // source 'crew' keeps this OUT of the homeowner's portal gallery — the
      // portal renders every extra photo it is given (see portalPhotos), and a
      // ladder shot is for the office, not the customer. The fileId is the
      // dedupe key: a retry or redelivered webhook re-sends the same file id and
      // addDesignExtraPhoto no-ops instead of appending a duplicate.
      await addDesignExtraPhoto(
        designId,
        file.buffer.toString('base64'),
        file.contentType,
        title,
        'crew',
        fileId,
      );
      saved += 1;
    } catch (err) {
      // One bad photo must not lose the material actuals that came with it.
      console.error('[botWriteTools] failed to attach install photo:', err);
      failed += 1;
    }
  }
  return { saved, failed, noDesign: false };
}
