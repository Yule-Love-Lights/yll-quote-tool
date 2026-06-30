import { describe, it, expect } from 'vitest';
import { parsePipelines, guessAssignments, type Pipeline } from './highlevelPipelines';

describe('parsePipelines', () => {
  it('parses the GHL /opportunities/pipelines shape into a clean list', () => {
    const raw = {
      pipelines: [
        {
          id: 'pipe_1',
          name: 'Holiday Lights',
          stages: [
            { id: 'stg_open', name: '📭 Open', position: 0 },
            { id: 'stg_sent', name: '📨 Bid Sent', position: 1 },
          ],
        },
      ],
    };
    expect(parsePipelines(raw)).toEqual([
      {
        id: 'pipe_1',
        name: 'Holiday Lights',
        stages: [
          { id: 'stg_open', name: '📭 Open' },
          { id: 'stg_sent', name: '📨 Bid Sent' },
        ],
      },
    ]);
  });

  it('returns [] when there are no pipelines / the shape is wrong', () => {
    expect(parsePipelines(null)).toEqual([]);
    expect(parsePipelines({})).toEqual([]);
    expect(parsePipelines({ pipelines: 'nope' })).toEqual([]);
    expect(parsePipelines({ pipelines: [] })).toEqual([]);
  });

  it('tolerates a pipeline with missing/blank fields without throwing', () => {
    const raw = { pipelines: [{ id: 'p1' /* no name, no stages */ }] };
    expect(parsePipelines(raw)).toEqual([{ id: 'p1', name: '(unnamed)', stages: [] }]);
  });

  it('tolerates a stage with missing fields', () => {
    const raw = { pipelines: [{ id: 'p1', name: 'P', stages: [{ position: 0 }] }] };
    expect(parsePipelines(raw)).toEqual([
      { id: 'p1', name: 'P', stages: [{ id: '', name: '(unnamed)' }] },
    ]);
  });
});

describe('guessAssignments', () => {
  // Mirrors the real Yule Love Lights "Christmas Lights" pipeline (+ the
  // "Commercial Christmas Lights" pipeline, to prove the commercial one is NOT
  // picked as the primary). The expected guesses match the human-chosen mapping
  // in .env.local.
  const PIPELINES: Pipeline[] = [
    {
      id: 'sC6JEcxlGnNDasanlXDN',
      name: 'Christmas Lights',
      stages: [
        { id: 'open', name: '📭Open' },
        { id: 'prevquotes', name: 'Previous Year Quotes' },
        { id: 'makequote', name: 'Make Quote' },
        { id: 'bidsent', name: '📨Bid Sent' },
        { id: 'interested', name: 'Interested' },
        { id: 'approved', name: '⏰Approved' },
        { id: 'jobber', name: '💼Job in Jobber' },
      ],
    },
    { id: 'commercial', name: 'Commercial Christmas Lights', stages: [{ id: 'copen', name: 'Open' }] },
  ];

  it('picks the Christmas Lights pipeline (not Commercial) and the matching stage for each env var', () => {
    const g = guessAssignments(PIPELINES);
    expect(g.HIGHLEVEL_PIPELINE_ID.value).toBe('sC6JEcxlGnNDasanlXDN');
    expect(g.HIGHLEVEL_PIPELINE_ID.pipelineName).toBe('Christmas Lights');
    expect(g.HIGHLEVEL_STAGE_QUOTE_CREATED.value).toBe('makequote');
    expect(g.HIGHLEVEL_STAGE_QUOTE_SENT.value).toBe('bidsent');
    expect(g.HIGHLEVEL_STAGE_QUOTE_INTERESTED.value).toBe('interested');
    expect(g.HIGHLEVEL_STAGE_QUOTE_SIGNED.value).toBe('approved');
  });

  it('does not mistake "Previous Year Quotes" for the "Make Quote" (created) stage', () => {
    const g = guessAssignments(PIPELINES);
    expect(g.HIGHLEVEL_STAGE_QUOTE_CREATED.stageName).toBe('Make Quote');
  });

  it('returns null values (no crash) when there are no pipelines', () => {
    const g = guessAssignments([]);
    expect(g.HIGHLEVEL_PIPELINE_ID.value).toBeNull();
    expect(g.HIGHLEVEL_STAGE_QUOTE_SENT.value).toBeNull();
  });

  it('leaves a stage guess null when nothing matches but still names the primary pipeline', () => {
    const g = guessAssignments([{ id: 'p1', name: 'Christmas Lights', stages: [{ id: 's1', name: 'Open' }] }]);
    expect(g.HIGHLEVEL_STAGE_QUOTE_SENT.value).toBeNull();
    expect(g.HIGHLEVEL_STAGE_QUOTE_SENT.pipelineName).toBe('Christmas Lights');
  });
});
