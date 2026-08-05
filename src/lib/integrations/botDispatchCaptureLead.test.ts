// Tests for the captureLead dispatch flow (Phase 3 of the 2026-07-19 plan).
// This is the bot's CONSENT model, so it's asserted directly:
//   • crew role required (staff/admin get it too, since crew is the floor)
//   • service missing → the bot ASKS and stages NOTHING (stateless — no
//     partial persisted, the crew resends the whole capture)
//   • service present → stages a confirm whose text IS the consent
//     affirmation
//   • "yes" → runs the write, notifies staff, and audits it
//   • "no" / an expired confirm → nothing runs
//
// runCaptureLead / summarizeCaptureLead are mocked so this file only exercises
// the dispatcher's gates, not the GHL sync logic (covered by
// src/lib/leads/fieldLead.test.ts and botWriteTools.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  interpretBotText: vi.fn(async (): Promise<unknown> => null),
  runWhatsAppCommand: vi.fn(async () => 'KEYWORD-REPLY'),
  runCaptureLead: vi.fn(async () => ({ reply: 'CAPTURE-REPLY', synced: true })),
  stagePendingAction: vi.fn(
    async (_opts: {
      chatId: string;
      userId: string;
      tool: string;
      args: Record<string, unknown>;
      summary: string;
    }): Promise<{ id: string; supersededSummary: string | null } | null> => ({
      id: 'pending-1',
      supersededSummary: null,
    }),
  ),
  consumePendingAction: vi.fn(async (): Promise<unknown> => null),
  peekPendingAction: vi.fn(async (): Promise<unknown> => null),
  appendPhotosToPendingAction: vi.fn(async (): Promise<unknown> => null),
  supersedeOpenActions: vi.fn(async () => undefined),
  logBotAction: vi.fn(async () => undefined),
  isInterpreterConfigured: vi.fn(() => true),
  isTranscriptionConfigured: vi.fn(() => false),
  notifyTelegramAudience: vi.fn(async () => undefined),
}));

vi.mock('./botInterpreter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./botInterpreter')>();
  return {
    ...actual,
    interpretBotText: mocks.interpretBotText,
    isInterpreterConfigured: mocks.isInterpreterConfigured,
  };
});
vi.mock('./whatsapp', () => ({ runWhatsAppCommand: mocks.runWhatsAppCommand }));
vi.mock('./botWriteTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./botWriteTools')>();
  return { ...actual, runCaptureLead: mocks.runCaptureLead };
});
vi.mock('./botConfirm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./botConfirm')>();
  return {
    ...actual,
    stagePendingAction: mocks.stagePendingAction,
    consumePendingAction: mocks.consumePendingAction,
    peekPendingAction: mocks.peekPendingAction,
    appendPhotosToPendingAction: mocks.appendPhotosToPendingAction,
    supersedeOpenActions: mocks.supersedeOpenActions,
  };
});
vi.mock('./botAudit', () => ({ logBotAction: mocks.logBotAction }));
vi.mock('./telegramRouting', () => ({ notifyTelegramAudience: mocks.notifyTelegramAudience }));
vi.mock('./transcribe', () => ({
  transcribeAudio: vi.fn(),
  isTranscriptionConfigured: mocks.isTranscriptionConfigured,
}));
// No service client here, so resolveSenderRole's roleFromDb returns null and role
// resolution falls to the env floor.
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => null,
  isSupabaseServiceConfigured: () => false,
}));

import { handleBotMessage } from './botDispatch';

const ENV_KEYS = [
  'TELEGRAM_ADMIN_USERS',
  'TELEGRAM_STAFF_USERS',
  'TELEGRAM_CREW_USERS',
  'TELEGRAM_BOT_USERNAME',
] as const;
const saved: Record<string, string | undefined> = {};

const CREW = '900';
const base = {
  chatId: '-100999',
  userId: CREW,
  chatType: 'private',
  text: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TELEGRAM_CREW_USERS = CREW;
  process.env.TELEGRAM_BOT_USERNAME = 'yll_ops_bot';
  mocks.stagePendingAction.mockResolvedValue({ id: 'pending-1', supersededSummary: null });
  mocks.consumePendingAction.mockResolvedValue(null);
  mocks.peekPendingAction.mockResolvedValue(null);
  mocks.appendPhotosToPendingAction.mockResolvedValue(null);
  mocks.isInterpreterConfigured.mockReturnValue(true);
  mocks.isTranscriptionConfigured.mockReturnValue(false);
  mocks.runCaptureLead.mockResolvedValue({ reply: 'CAPTURE-REPLY', synced: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const CAPTURE_ARGS = {
  tool: 'captureLead' as const,
  args: { name: 'John Smith', phone: '631-555-0100', address: '12 Oak St', service: 'permanent' as const },
  confidence: 0.9,
};

describe('captureLead — role gate', () => {
  // captureLead's minimum role is 'crew' (see botRoles.ts TOOL_MIN_ROLE) — the
  // LOWEST tier the bot has. resolveSenderRole (botUsers.ts) defaults every
  // allowlisted-but-unassigned sender to 'crew' (`?? 'crew'`), so there is no
  // reachable "sender denied" case for this specific tool: anyone the bot
  // answers at all already clears its floor. The generic deny-and-audit
  // mechanism itself (mayRunTool + denied()) is already covered for a
  // staff-minimum tool in botDispatchPhase2.test.ts's "role gate" block — this
  // file only needs to prove captureLead actually clears that floor, not
  // re-prove the mechanism.
  it('lets crew stage a capture (crew is the tool floor)', async () => {
    mocks.interpretBotText.mockResolvedValue(CAPTURE_ARGS);
    const reply = await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100 12 Oak St permanent' });
    expect(mocks.stagePendingAction).toHaveBeenCalledOnce();
    expect(reply).toContain('New field lead');
  });

  it('lets an unassigned-but-allowlisted sender through too (env-floor default is crew)', async () => {
    delete process.env.TELEGRAM_CREW_USERS; // no explicit tier anywhere
    mocks.interpretBotText.mockResolvedValue(CAPTURE_ARGS);
    const reply = await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100 12 Oak St permanent' });
    expect(mocks.stagePendingAction).toHaveBeenCalledOnce();
    expect(reply).toContain('New field lead');
  });
});

describe('captureLead — service is required, and the bot ASKS rather than guesses', () => {
  it('asks for the service and stages NOTHING when it is missing', async () => {
    mocks.interpretBotText.mockResolvedValue({
      tool: 'captureLead',
      args: { name: 'John Smith', phone: '631-555-0100', address: '12 Oak St' }, // no service
      confidence: 0.9,
    });
    const reply = await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100 12 Oak St' });
    expect(reply).toContain('which service');
    expect(reply).toContain('John Smith');
    expect(mocks.stagePendingAction).not.toHaveBeenCalled();
    expect(mocks.runCaptureLead).not.toHaveBeenCalled();
  });

  it('is stateless — nothing is stored for the crew to complete later; they must resend', async () => {
    mocks.interpretBotText.mockResolvedValue({
      tool: 'captureLead',
      args: { name: 'John Smith', phone: '631-555-0100' },
      confidence: 0.9,
    });
    await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100' });
    // Nothing was staged, and a bare "yes" afterward has nothing to consume —
    // resending the WHOLE capture (with the service) is a fresh message, not a
    // completion of a stored partial.
    expect(mocks.stagePendingAction).not.toHaveBeenCalled();
    // consumePendingAction is mocked to resolve null by default (beforeEach) —
    // exactly what a real "nothing pending" DB read returns, since nothing was
    // ever staged above.
    const yesReply = await handleBotMessage({ ...base, text: 'yes' });
    expect(yesReply).toBe('Nothing is waiting for a yes.');
  });

  it('asks for name/phone when either is missing, before ever checking service', async () => {
    mocks.interpretBotText.mockResolvedValue({
      tool: 'captureLead',
      args: { name: 'John Smith' }, // no phone
      confidence: 0.9,
    });
    const reply = await handleBotMessage({ ...base, text: 'new lead John Smith' });
    expect(reply).toContain('name and phone number');
    expect(mocks.stagePendingAction).not.toHaveBeenCalled();
  });

  it('stages once name, phone, and service are all present', async () => {
    mocks.interpretBotText.mockResolvedValue(CAPTURE_ARGS);
    await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100 12 Oak St permanent' });
    expect(mocks.stagePendingAction).toHaveBeenCalledOnce();
    const staged = mocks.stagePendingAction.mock.calls[0][0];
    expect(staged.args).toEqual({
      name: 'John Smith',
      phone: '631-555-0100',
      address: '12 Oak St',
      note: null,
      service: 'permanent',
    });
  });
});

describe('captureLead — the confirm line IS the consent record (task #9, locked)', () => {
  it('the staged summary contains the exact consent affirmation wording', async () => {
    mocks.interpretBotText.mockResolvedValue(CAPTURE_ARGS);
    const reply = await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100 12 Oak St permanent' });
    expect(reply).toContain('Reply YES only if they agreed to be contacted');
    expect(reply).toContain("they'll be enrolled in texts");
    expect(reply).toContain('John Smith');
    expect(reply).toContain('631-555-0100');
    expect(reply).toContain('12 Oak St');
    expect(reply).toContain('Permanent');
  });
});

describe('captureLead — nothing executes without a yes', () => {
  it('does not call runCaptureLead while only staging', async () => {
    mocks.interpretBotText.mockResolvedValue(CAPTURE_ARGS);
    await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100 12 Oak St permanent' });
    expect(mocks.runCaptureLead).not.toHaveBeenCalled();
  });

  it('runs the capture, notifies staff, and audits it on an affirmative reply', async () => {
    mocks.consumePendingAction.mockResolvedValue({
      id: 'p1',
      tool: 'captureLead',
      args: { name: 'John Smith', phone: '631-555-0100', address: '12 Oak St', note: null, service: 'permanent' },
      summary: 's',
    });
    const reply = await handleBotMessage({ ...base, text: 'yes' });
    expect(mocks.runCaptureLead).toHaveBeenCalledWith({
      name: 'John Smith',
      phone: '631-555-0100',
      address: '12 Oak St',
      note: null,
      service: 'permanent',
    });
    expect(reply).toBe('CAPTURE-REPLY');
    expect(mocks.notifyTelegramAudience).toHaveBeenCalledWith('leads', expect.stringContaining('John Smith'));
    expect(mocks.logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'captureLead', outcome: 'ran', detail: 'CAPTURE-REPLY' }),
    );
  });

  it('does NOT notify staff when the sync did not fully succeed', async () => {
    mocks.runCaptureLead.mockResolvedValue({ reply: 'Saved but tagging failed', synced: false });
    mocks.consumePendingAction.mockResolvedValue({
      id: 'p1',
      tool: 'captureLead',
      args: { name: 'John Smith', phone: '631-555-0100', service: 'permanent' },
      summary: 's',
    });
    const reply = await handleBotMessage({ ...base, text: 'yes' });
    expect(reply).toBe('Saved but tagging failed');
    expect(mocks.notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('says nothing is pending on a stray yes', async () => {
    mocks.consumePendingAction.mockResolvedValue(null);
    expect(await handleBotMessage({ ...base, text: 'yes' })).toBe('Nothing is waiting for a yes.');
    expect(mocks.runCaptureLead).not.toHaveBeenCalled();
  });

  it('cancels on a negative reply without running anything', async () => {
    mocks.interpretBotText.mockResolvedValue(CAPTURE_ARGS);
    await handleBotMessage({ ...base, text: 'new lead John Smith 631-555-0100 12 Oak St permanent' });
    const reply = await handleBotMessage({ ...base, text: 'no' });
    expect(mocks.supersedeOpenActions).toHaveBeenCalled();
    expect(mocks.runCaptureLead).not.toHaveBeenCalled();
    expect(reply).toContain('Cancelled');
  });

});
