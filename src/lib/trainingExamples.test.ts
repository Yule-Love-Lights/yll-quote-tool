import { describe, it, expect } from 'vitest';
import { exampleToFewShot, type TrainingExampleRow } from './trainingExamples';
import type { Scene } from './design/sceneTypes';

// A minimal scene: one tagged front-roofline C9 strand across a 1000×500 photo.
const SCENE: Scene = {
  yardsticks: [],
  items: [
    {
      id: 'seed-santas-1', yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12,
      drawingStyle: 'strand', colorPattern: ['warm-white'], points: [100, 100, 600, 100],
      surface: 'santas-roofline', included: true,
    },
  ],
};

function row(overrides: Partial<TrainingExampleRow> = {}): TrainingExampleRow {
  return {
    id: 'ex-1', created_at: '2026-06-12T00:00:00Z', quote_id: 'q1', design_id: 'd1',
    source: 'manual', excluded: false, notes: null, address: '1 Main',
    street_photo_base64: 'AAAA', street_media_type: 'image/jpeg', street_w: 1000, street_h: 500,
    satellite_base64: null, satellite_media_type: null, satellite_w: null, satellite_h: null,
    satellite_feet_per_pixel: null, satellite_lines: null,
    original_analysis: null,
    final_scene: SCENE,
    final_inputs: { santasFootage: 50, santasDifficulty: 'medium', gingerbreadFootage: 0, gingerbreadDifficulty: 'medium' },
    ...overrides,
  };
}

describe('exampleToFewShot', () => {
  it('M1: returns null when the street photo is missing', () => {
    expect(exampleToFewShot(row({ street_photo_base64: null }))).toBeNull();
  });

  it('M1: returns null when street pixel dims are missing/zero (would teach empty lines vs nonzero footage)', () => {
    expect(exampleToFewShot(row({ street_w: 0 }))).toBeNull();
    expect(exampleToFewShot(row({ street_h: null }))).toBeNull();
  });

  it('projects the final scene roofline into normalized polylines', () => {
    const ex = exampleToFewShot(row())!;
    expect(ex).not.toBeNull();
    expect(ex.source).toBe('design');
    expect(ex.photos).toHaveLength(1); // street only
    expect(ex.santasLines).toHaveLength(1);
    expect(ex.santasLines[0].points).toEqual([[0.1, 0.2], [0.6, 0.2]]);
    expect(ex.santasFootage).toBe(50);
  });

  it('M2: a satellite image WITHOUT confirmed lines is NOT taught (no incoherent empty-arrays lesson)', () => {
    const ex = exampleToFewShot(row({
      satellite_base64: 'SAT', satellite_media_type: 'image/jpeg',
      satellite_lines: { santas: [], gingerbread: [], c9: [] },
    }))!;
    expect(ex.photos).toHaveLength(1); // satellite dropped
    expect(ex.photos.every((p) => p.tag !== 'satellite')).toBe(true);
    expect(ex.satelliteSantasLines).toEqual([]);
  });

  it('M2: a satellite image WITH confirmed lines rides along, lines included', () => {
    const ex = exampleToFewShot(row({
      satellite_base64: 'SAT', satellite_media_type: 'image/jpeg', satellite_feet_per_pixel: 0.15,
      satellite_lines: {
        santas: [{ points: [[0.2, 0.5], [0.7, 0.5]], label: 'front' }],
        gingerbread: [], c9: [], santasFootage: 50,
      },
    }))!;
    expect(ex.photos).toHaveLength(2);
    expect(ex.photos[1].tag).toBe('satellite');
    expect(ex.satelliteSantasLines).toHaveLength(1);
    expect(ex.satelliteSantasFootage).toBe(50);
  });
});
