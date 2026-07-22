// Tests for the Phase-2 dispatcher gates. These are the bot's security model,
// so they are asserted directly rather than through the tools:
//   • a group message that isn't addressed to the bot produces NO reply and NO
//     model call (otherwise ordinary staff chatter would be answered)
//   • no write EVER executes without a confirm-yes
//   • a role below the tool's minimum is refused and audited
//   • a confirmed action runs exactly once

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  interpretBotText: vi.fn(async (): Promise<unknown> => null),
  runStatusTool: vi.fn(async () => 'STATUS-REPLY'),
  runScheduleTool: vi.fn(async () => 'SCHEDULE-REPLY'),
  runWhatsAppCommand: vi.fn(async () => 'KEYWORD-REPLY'),
  runCompleteInstall: vi.fn(async () => 'INSTALL-RECORDED'),
  stagePendingAction: vi.fn(
    async (_opts: {
      chatId: string;
      userId: string;
      tool: string;
      args: Record<string, unknown>;
      summary: string;
    }): Promise<string | null> => 'pending-1',
  ),
  consumePendingAction: vi.fn(async (): Promise<unknown> => null),
  supersedeOpenActions: vi.fn(async () => undefined),
  logBotAction: vi.fn(async () => undefined),
  listCatalog: vi.fn(async () => [{ sku: 'C9-WARM' }, { sku: 'CLIP-ALL' }]),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => [
    { id: 'job-uuid', jobNumber: 142, customerName: 'Alvarez', designId: 'design-1' },
  ]),
  downloadTelegramFile: vi.fn(async (): Promise<unknown> => null),
  transcribeAudio: vi.fn(async (): Promise<string | null> => null),
  isTranscriptionConfigured: vi.fn(() => false),
}));

vi.mock('./botInterpreter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./botInterpreter')>();
  return { ...actual, interpretBotText: mocks.interpretBotText };
});
vi.mock('./botTools', () => ({
  runStatusTool: mocks.runStatusTool,
  runScheduleTool: mocks.runScheduleTool,
}));
vi.mock('./whatsapp', () => ({ runWhatsAppCommand: mocks.runWhatsAppCommand }));
vi.mock('./botWriteTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./botWriteTools')>();
  return { ...actual, runCompleteInstall: mocks.runCompleteInstall };
});
vi.mock('./botConfirm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./botConfirm')>();
  return {
    ...actual,
    stagePendingAction: mocks.stagePendingAction,
    consumePendingAction: mocks.consumePendingAction,
    supersedeOpenActions: mocks.supersedeOpenActions,
  };
});
vi.mock('./botAudit', () => ({ logBotAction: mocks.logBotAction }));
vi.mock('@/lib/inventory/catalog', () => ({ listCatalog: mocks.listCatalog }));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards: mocks.listFulfillmentCards }));
vi.mock('./telegramMedia', () => ({ downloadTelegramFile: mocks.downloadTelegramFile }));
vi.mock('./transcribe', () => ({
  transcribeAudio: mocks.transcribeAudio,
  isTranscriptionConfigured: mocks.isTranscriptionConfigured,
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
  mocks.stagePendingAction.mockResolvedValue('pending-1');
  mocks.consumePendingAction.mockResolvedValue(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('group gate', () => {
  it('stays silent — and never calls the model — on unaddressed group chatter', async () => {
    const reply = await handleBotMessage({
      ...base,
      chatType: 'group',
      text: 'yeah I already called him back',
    });
    expect(reply).toBeNull();
    expect(mocks.interpretBotText).not.toHaveBeenCalled();
    expect(mocks.runWhatsAppCommand).not.toHaveBeenCalled();
  });

  it('answers when @mentioned in a group', async () => {
    mocks.interpretBotText.mockResolvedValue({ tool: 'status', args: { query: 'alvarez' }, confidence: 0.9 });
    const reply = await handleBotMessage({
      ...base,
      chatType: 'group',
      text: '@yll_ops_bot hows the alvarez quote',
    });
    expect(reply).toBe('STATUS-REPLY');
  });

  it('answers every message in a 1:1 chat', async () => {
    const reply = await handleBotMessage({ ...base, text: 'jobs' });
    expect(reply).toBe('KEYWORD-REPLY');
  });
});

describe('write safety — nothing executes without a yes', () => {
  beforeEach(() => {
    mocks.interpretBotText.mockResolvedValue({
      tool: 'completeInstall',
      args: { jobNumber: 142, materials: [{ sku: 'C9-WARM', qty: 2 }] },
      confidence: 0.9,
    });
  });

  it('stages a confirm summary instead of running the install', async () => {
    const reply = await handleBotMessage({ ...base, text: 'job 142 done, 2 boxes C9' });
    expect(mocks.runCompleteInstall).not.toHaveBeenCalled();
    expect(mocks.stagePendingAction).toHaveBeenCalledOnce();
    expect(reply).toContain('#142');
    expect(reply).toContain('reply yes');
  });

  it('carries the message photos into the staged action', async () => {
    await handleBotMessage({ ...base, text: 'job 142 done', photoFileIds: ['file-abc'] });
    const staged = mocks.stagePendingAction.mock.calls[0][0];
    expect(staged.args.photoFileIds).toEqual(['file-abc']);
  });

  it('runs the install only after an affirmative reply', async () => {
    mocks.consumePendingAction.mockResolvedValue({
      id: 'p1',
      tool: 'completeInstall',
      args: { jobNumber: 142, materials: [] },
      summary: 's',
    });
    const reply = await handleBotMessage({ ...base, text: 'yes' });
    expect(mocks.runCompleteInstall).toHaveBeenCalledOnce();
    expect(reply).toBe('INSTALL-RECORDED');
  });

  it('says nothing is pending when a stray yes arrives', async () => {
    mocks.consumePendingAction.mockResolvedValue(null);
    expect(await handleBotMessage({ ...base, text: 'yes' })).toBe('Nothing is waiting for a yes.');
    expect(mocks.runCompleteInstall).not.toHaveBeenCalled();
  });

  it('cancels on a negative reply without running anything', async () => {
    const reply = await handleBotMessage({ ...base, text: 'no' });
    expect(mocks.supersedeOpenActions).toHaveBeenCalledOnce();
    expect(mocks.runCompleteInstall).not.toHaveBeenCalled();
    expect(reply).toContain('Cancelled');
  });

  it('does not claim an action is pending when staging failed to store', async () => {
    mocks.stagePendingAction.mockResolvedValue(null);
    const reply = await handleBotMessage({ ...base, text: 'job 142 done' });
    expect(reply).not.toContain('reply yes');
    expect(reply).toContain('try again');
  });

  it('asks for the job number rather than guessing one', async () => {
    mocks.interpretBotText.mockResolvedValue({
      tool: 'completeInstall',
      args: { materials: [{ sku: 'C9-WARM', qty: 2 }] },
      confidence: 0.9,
    });
    const reply = await handleBotMessage({ ...base, text: 'all done, used 2 boxes' });
    expect(reply).toContain('Which job number');
    expect(mocks.stagePendingAction).not.toHaveBeenCalled();
  });

  it('refuses an unknown job before staging anything', async () => {
    mocks.listFulfillmentCards.mockResolvedValue([]);
    const reply = await handleBotMessage({ ...base, text: 'job 142 done' });
    expect(reply).toBe('No active job #142.');
    expect(mocks.stagePendingAction).not.toHaveBeenCalled();
  });
});

describe('role gate', () => {
  it('refuses a stock-moving keyword command from crew and audits it', async () => {
    const reply = await handleBotMessage({ ...base, text: 'set C9-WARM 40' });
    expect(mocks.runWhatsAppCommand).not.toHaveBeenCalled();
    expect(reply).toContain("don't have access");
    expect(mocks.logBotAction).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'set', outcome: 'denied', role: 'crew' }),
    );
  });

  it('lets staff stage the same command behind a confirm', async () => {
    process.env.TELEGRAM_STAFF_USERS = CREW;
    delete process.env.TELEGRAM_CREW_USERS;
    const reply = await handleBotMessage({ ...base, text: 'set C9-WARM 40' });
    expect(mocks.runWhatsAppCommand).not.toHaveBeenCalled();
    expect(reply).toContain('reply yes');
  });

  it('re-checks the role at execution time, not just at staging', async () => {
    mocks.consumePendingAction.mockResolvedValue({
      id: 'p1',
      tool: 'set',
      args: { kind: 'set', sku: 'C9-WARM', qty: 40 },
      summary: 's',
    });
    const reply = await handleBotMessage({ ...base, text: 'yes' });
    expect(mocks.runWhatsAppCommand).not.toHaveBeenCalled();
    expect(reply).toContain("don't have access");
  });

  it('still lets crew run the reads', async () => {
    expect(await handleBotMessage({ ...base, text: 'jobs' })).toBe('KEYWORD-REPLY');
  });
});

describe('voice input', () => {
  it('explains when voice is not configured instead of failing silently', async () => {
    mocks.isTranscriptionConfigured.mockReturnValue(false);
    const reply = await handleBotMessage({ ...base, text: '', voiceFileId: 'v1' });
    expect(reply).toContain('not set up');
  });

  it('routes a transcribed voice note through the normal gates', async () => {
    mocks.isTranscriptionConfigured.mockReturnValue(true);
    mocks.downloadTelegramFile.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'audio/ogg' });
    mocks.transcribeAudio.mockResolvedValue('jobs');
    const reply = await handleBotMessage({ ...base, text: '', voiceFileId: 'v1' });
    expect(reply).toBe('KEYWORD-REPLY');
  });

  it('asks the sender to type it when the audio could not be transcribed', async () => {
    mocks.isTranscriptionConfigured.mockReturnValue(true);
    mocks.downloadTelegramFile.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'audio/ogg' });
    mocks.transcribeAudio.mockResolvedValue(null);
    const reply = await handleBotMessage({ ...base, text: '', voiceFileId: 'v1' });
    expect(reply).toContain("Couldn't make out");
  });
});

describe('fallbacks', () => {
  it('keeps the not-understood reply when the interpreter returns null', async () => {
    mocks.interpretBotText.mockResolvedValue(null);
    expect(await handleBotMessage({ ...base, text: 'zzz gibberish' })).toContain("Didn't understand");
  });

  it('prompts for the job when a photo arrives with no caption', async () => {
    const reply = await handleBotMessage({ ...base, text: '', photoFileIds: ['file-abc'] });
    expect(reply).toContain('job 142 done');
  });
});
