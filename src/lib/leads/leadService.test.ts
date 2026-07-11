// Unit tests for the website lead-capture domain logic (#leads):
//  - resolveLeadPipeline maps each of the 4 lead services to the right GHL
//    pipeline/entry-stage (christmas/permanent/event-wedding reuse the real
//    ghlPipelineMap; landscape is env-driven with no map entry yet).
//  - splitLeadName never drops words past the first (the old plugin's bug).
//  - syncLeadToGhl composes the HighLevel calls in the right order/shape:
//    tags are exactly ['new lead', 'web-lead-<service>'] and NEVER the 3
//    legacy tags that trigger the old Christmas-only workflows; an existing
//    open opportunity is reused, never duplicated; a failure from
//    upsertContact itself propagates (the route is responsible for catching
//    it and keeping the lead row 'pending'); a failure from any LATER step
//    is caught internally and returned as status 'error' WITH the
//    ghlContactId already captured (F9); an unconfigured landscape pipeline
//    defers instead of failing.
//
// The HighLevel client is mocked — no live GHL calls. ghlPipelineMap is NOT
// mocked: christmas/permanent/event-wedding assert against its real,
// hardcoded pipeline ids so a drift there is caught here too.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hl = vi.hoisted(() => {
  class FakeHighLevelError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'HighLevelError';
      this.status = status;
    }
  }
  return {
    HighLevelError: FakeHighLevelError,
    upsertContact: vi.fn(async (_input: unknown) => ({
      contact: { id: 'contact-1', firstName: 'Mary', email: 'mary@example.com' } as {
        id: string;
        firstName?: string;
        email?: string;
        customFields?: Array<{ id: string; value?: string | string[] }>;
      },
      new: true,
    })),
    addContactTags: vi.fn(async (_contactId: string, _tags: string[]) => ({})),
    upsertContactCustomField: vi.fn(
      async (_contactId: string, _fieldId: string, _value: string | string[]) => {},
    ),
    createContactNote: vi.fn(async (_contactId: string, _body: string) => ({})),
    findOrCreateOpportunityForContact: vi.fn(async (_input: unknown) => ({
      opportunity: { id: 'opp-1' },
      created: true,
    })),
    createOpportunity: vi.fn(async (_input: unknown) => ({ id: 'opp-should-not-be-called' })),
  };
});
vi.mock('@/lib/integrations/highlevel', () => ({
  upsertContact: hl.upsertContact,
  addContactTags: hl.addContactTags,
  upsertContactCustomField: hl.upsertContactCustomField,
  createContactNote: hl.createContactNote,
  findOrCreateOpportunityForContact: hl.findOrCreateOpportunityForContact,
  createOpportunity: hl.createOpportunity,
  HighLevelError: hl.HighLevelError,
}));

const FakeHighLevelError = hl.HighLevelError;

import {
  LEAD_SERVICES,
  asLeadService,
  resolveLeadPipeline,
  splitLeadName,
  SERVICE_FIELD_VALUE,
  syncLeadToGhl,
  buildLeadNoteBody,
  type LeadInput,
} from './leadService';

function baseLead(overrides: Partial<LeadInput> = {}): LeadInput {
  return {
    name: 'Jordan Rivera',
    email: 'jordan@example.com',
    phone: '+16315550100',
    address: '123 Main St',
    service: 'christmas',
    notes: null,
    utm: null,
    landingUrl: null,
    formVariant: 'hero',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hl.upsertContact.mockResolvedValue({
    contact: { id: 'contact-1', firstName: 'Jordan', email: 'jordan@example.com' },
    new: true,
  });
  hl.findOrCreateOpportunityForContact.mockResolvedValue({
    opportunity: { id: 'opp-1' },
    created: true,
  });
  delete process.env.HIGHLEVEL_PIPELINE_ID_LANDSCAPE;
  delete process.env.HIGHLEVEL_STAGE_LANDSCAPE_ENTRY;
  delete process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LEAD_SERVICES / asLeadService', () => {
  it('narrows a valid service string, rejects everything else', () => {
    for (const s of LEAD_SERVICES) {
      expect(asLeadService(s)).toBe(s);
    }
    expect(asLeadService('holiday')).toBeNull();
    expect(asLeadService('')).toBeNull();
    expect(asLeadService(undefined)).toBeNull();
    expect(asLeadService(123)).toBeNull();
  });
});

describe('resolveLeadPipeline — per-service pipeline mapping (case a)', () => {
  it('christmas → the real holiday pipeline', () => {
    expect(resolveLeadPipeline('christmas')?.pipelineId).toBe('sC6JEcxlGnNDasanlXDN');
  });

  it('permanent → the real permanent pipeline', () => {
    expect(resolveLeadPipeline('permanent')?.pipelineId).toBe('OqpjVflTdgmjmUQmbcSF');
  });

  it('event-wedding → the real event pipeline', () => {
    expect(resolveLeadPipeline('event-wedding')?.pipelineId).toBe('YfCi5jy8Alc3oD5AfXmV');
  });

  it('landscape → env-driven; null when either env var is unset', () => {
    expect(resolveLeadPipeline('landscape')).toBeNull();
    process.env.HIGHLEVEL_PIPELINE_ID_LANDSCAPE = 'pipe-landscape';
    expect(resolveLeadPipeline('landscape')).toBeNull(); // stage still unset
    process.env.HIGHLEVEL_STAGE_LANDSCAPE_ENTRY = 'stage-landscape-entry';
    expect(resolveLeadPipeline('landscape')).toEqual({
      pipelineId: 'pipe-landscape',
      entryStageId: 'stage-landscape-entry',
    });
  });

  describe('skips the quote-flow env override (F5)', () => {
    const savedPipelineId = process.env.HIGHLEVEL_PIPELINE_ID;
    const savedStageCreated = process.env.HIGHLEVEL_STAGE_QUOTE_CREATED;

    afterEach(() => {
      if (savedPipelineId === undefined) delete process.env.HIGHLEVEL_PIPELINE_ID;
      else process.env.HIGHLEVEL_PIPELINE_ID = savedPipelineId;
      if (savedStageCreated === undefined) delete process.env.HIGHLEVEL_STAGE_QUOTE_CREATED;
      else process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = savedStageCreated;
    });

    it('christmas ignores HIGHLEVEL_PIPELINE_ID/HIGHLEVEL_STAGE_QUOTE_CREATED — a new lead must enter at Open, not the quote-flow "Make Quote" stage', () => {
      process.env.HIGHLEVEL_PIPELINE_ID = 'env-pipeline-should-not-apply';
      process.env.HIGHLEVEL_STAGE_QUOTE_CREATED = 'env-stage-should-not-apply';

      const pipeline = resolveLeadPipeline('christmas');
      expect(pipeline?.pipelineId).toBe('sC6JEcxlGnNDasanlXDN');
      expect(pipeline?.entryStageId).toBe('478396dd-a052-41ad-ae73-d528909cd5f4');
    });
  });
});

describe('splitLeadName — full name split (case j)', () => {
  it('first word is firstName, ALL remaining words are lastName', () => {
    expect(splitLeadName('Mary Jane Van Der Berg')).toEqual({
      firstName: 'Mary',
      lastName: 'Jane Van Der Berg',
    });
  });

  it('a single-word name has an empty lastName', () => {
    expect(splitLeadName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });
});

describe('SERVICE_FIELD_VALUE', () => {
  it('maps every lead service to its GHL contact.service field label', () => {
    expect(SERVICE_FIELD_VALUE.christmas).toBe('Christmas');
    expect(SERVICE_FIELD_VALUE.permanent).toBe('Permanent');
    expect(SERVICE_FIELD_VALUE['event-wedding']).toBe('Event/Wedding');
    expect(SERVICE_FIELD_VALUE.landscape).toBe('Landscape');
  });
});

describe('syncLeadToGhl — tags (case b)', () => {
  it('sends exactly [\'new lead\', \'web-lead-<service>\'] — never the 3 legacy tags', async () => {
    await syncLeadToGhl(baseLead({ service: 'permanent' }));

    expect(hl.addContactTags).toHaveBeenCalledTimes(1);
    const [, tags] = hl.addContactTags.mock.calls[0]!;
    expect(tags).toEqual(['new lead', 'web-lead-permanent']);
    expect(tags).not.toContain('heroform');
    expect(tags).not.toContain('stickyform');
    expect(tags).not.toContain('quotesectionform');
  });

  it('splits the name before upserting the contact (case j wiring)', async () => {
    await syncLeadToGhl(baseLead({ name: 'Mary Jane Van Der Berg' }));
    expect(hl.upsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Mary', lastName: 'Jane Van Der Berg', source: 'Website Form' }),
    );
  });
});

describe('syncLeadToGhl — existing open opportunity (case c)', () => {
  it('reuses it — never calls createOpportunity directly', async () => {
    hl.findOrCreateOpportunityForContact.mockResolvedValue({
      opportunity: { id: 'opp-existing' },
      created: false,
    });

    const result = await syncLeadToGhl(baseLead());

    expect(result.status).toBe('synced');
    expect(result.ghlOpportunityId).toBe('opp-existing');
    expect(hl.findOrCreateOpportunityForContact).toHaveBeenCalledTimes(1);
    expect(hl.createOpportunity).not.toHaveBeenCalled();
  });

  it('passes source "Website Leads" and omits monetaryValue', async () => {
    await syncLeadToGhl(baseLead());
    expect(hl.findOrCreateOpportunityForContact).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'Website Leads' }),
    );
    const call = hl.findOrCreateOpportunityForContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.monetaryValue).toBeUndefined();
  });
});

describe('syncLeadToGhl — contact.service custom field', () => {
  it('skips the field write when HIGHLEVEL_CONTACT_FIELD_SERVICE is unset', async () => {
    await syncLeadToGhl(baseLead());
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('writes the field as an ARRAY when the env var is set (F4 — contact.service is a GHL CHECKBOX field)', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE = 'field-123';
    await syncLeadToGhl(baseLead({ service: 'landscape' }));
    // landscape defers (no pipeline env), but the field write happens before
    // pipeline resolution and must still fire.
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-123', ['Landscape']);
  });
});

describe('syncLeadToGhl — contact.service is a CHECKBOX field, so we UNION instead of replace (F4)', () => {
  it('unions with an existing ARRAY-shaped selection instead of overwriting it', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE = 'field-123';
    hl.upsertContact.mockResolvedValue({
      contact: {
        id: 'contact-1',
        firstName: 'Jordan',
        email: 'jordan@example.com',
        customFields: [{ id: 'field-123', value: ['Christmas'] }],
      },
      new: false,
    });

    await syncLeadToGhl(baseLead({ service: 'permanent' }));

    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-123', [
      'Christmas',
      'Permanent',
    ]);
  });

  it('is defensive about a STRING-shaped existing value (legacy data) — still unions correctly', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE = 'field-123';
    hl.upsertContact.mockResolvedValue({
      contact: {
        id: 'contact-1',
        firstName: 'Jordan',
        email: 'jordan@example.com',
        customFields: [{ id: 'field-123', value: 'Christmas' }],
      },
      new: false,
    });

    await syncLeadToGhl(baseLead({ service: 'permanent' }));

    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-123', [
      'Christmas',
      'Permanent',
    ]);
  });

  it('does not duplicate the label when the same service is submitted twice', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE = 'field-123';
    hl.upsertContact.mockResolvedValue({
      contact: {
        id: 'contact-1',
        firstName: 'Jordan',
        email: 'jordan@example.com',
        customFields: [{ id: 'field-123', value: ['Christmas'] }],
      },
      new: false,
    });

    await syncLeadToGhl(baseLead({ service: 'christmas' }));

    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-123', ['Christmas']);
  });
});

describe('syncLeadToGhl — note (notes/utm/landingUrl present)', () => {
  it('creates a note containing notes, service, form variant, UTM, and landing url', async () => {
    await syncLeadToGhl(
      baseLead({
        notes: 'Wants warm white only',
        utm: { utm_source: 'google', utm_campaign: 'fall2026' },
        landingUrl: 'https://yulelovelights.com/quote',
        formVariant: 'sticky',
      }),
    );
    expect(hl.createContactNote).toHaveBeenCalledTimes(1);
    const [, body] = hl.createContactNote.mock.calls[0]!;
    expect(body).toContain('Wants warm white only');
    expect(body).toContain('Christmas');
    expect(body).toContain('sticky');
    expect(body).toContain('utm_source=google');
    expect(body).toContain('utm_campaign=fall2026');
    expect(body).toContain('https://yulelovelights.com/quote');
  });

  it('skips the note when notes/utm/landingUrl are all absent', async () => {
    await syncLeadToGhl(baseLead({ notes: null, utm: null, landingUrl: null }));
    expect(hl.createContactNote).not.toHaveBeenCalled();
  });
});

describe('buildLeadNoteBody — note-forgery hardening (F12)', () => {
  it('strips newlines from landingUrl and utm values so a submitter cannot inject a fake extra line', () => {
    const body = buildLeadNoteBody(
      baseLead({
        notes: 'Line one\nLine two — legit multi-line notes stay intact',
        utm: { utm_source: 'google\nFAKE: injected line' },
        landingUrl: 'https://evil.example.com/\nFAKE: injected line',
      }),
    );

    // notes is legitimately free text — left alone, still multi-line.
    expect(body).toContain('Line one\nLine two — legit multi-line notes stay intact');

    // utm value and landingUrl are submitter-controlled raw text — newlines
    // collapsed to a space so neither can forge a new note line.
    expect(body).toContain('utm_source=google FAKE: injected line');
    expect(body).not.toContain('utm_source=google\nFAKE');
    expect(body).toContain('Landing page: https://evil.example.com/ FAKE: injected line');
    expect(body).not.toContain('https://evil.example.com/\nFAKE');
  });
});

describe('syncLeadToGhl — landscape deferred (case h)', () => {
  it('returns status "deferred" and names the missing env vars, without touching the pipeline', async () => {
    const result = await syncLeadToGhl(baseLead({ service: 'landscape' }));
    expect(result.status).toBe('deferred');
    expect(result.syncError).toContain('HIGHLEVEL_PIPELINE_ID_LANDSCAPE');
    expect(result.syncError).toContain('HIGHLEVEL_STAGE_LANDSCAPE_ENTRY');
    expect(hl.findOrCreateOpportunityForContact).not.toHaveBeenCalled();
  });
});

describe('syncLeadToGhl — GHL failure propagates (case g wiring)', () => {
  it('a thrown HighLevelError from upsertContact rejects the call', async () => {
    hl.upsertContact.mockRejectedValue(new FakeHighLevelError('GHL is down', 502));
    await expect(syncLeadToGhl(baseLead())).rejects.toThrow('GHL is down');
  });
});

describe('syncLeadToGhl — a failure AFTER the contact exists is caught, not thrown (F9)', () => {
  it('an opportunity-step throw returns status "error" WITH the ghlContactId already captured', async () => {
    hl.findOrCreateOpportunityForContact.mockRejectedValue(
      new FakeHighLevelError('opportunity API down', 502),
    );
    const result = await syncLeadToGhl(baseLead());
    expect(result.status).toBe('error');
    expect(result.ghlContactId).toBe('contact-1');
    expect(result.syncError).toContain('opportunity API down');
  });

  it('a tag-step throw also returns status "error" WITH the ghlContactId (not a throw)', async () => {
    hl.addContactTags.mockRejectedValue(new FakeHighLevelError('tags API down', 502));
    const result = await syncLeadToGhl(baseLead());
    expect(result.status).toBe('error');
    expect(result.ghlContactId).toBe('contact-1');
    expect(result.syncError).toContain('tags API down');
  });
});
