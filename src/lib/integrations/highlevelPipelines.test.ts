import { describe, it, expect } from 'vitest';
import { parsePipelines } from './highlevelPipelines';

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
