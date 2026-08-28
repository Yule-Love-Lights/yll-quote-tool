import { describe, it, expect } from 'vitest';
import {
  buildDoorAnchorPrompt,
  isValidDoorAnchorModelResult,
  doorAnchorScaleFromModelResult,
  rescaleFtPerPxToOriginal,
  type DoorAnchorModelResult,
} from './doorAnchor';

describe('buildDoorAnchorPrompt', () => {
  it('interpolates width/height into the {W}x{H} placeholders', () => {
    const prompt = buildDoorAnchorPrompt(1200, 800);
    expect(prompt).toContain('This image is 1200x800 pixels');
  });

  it('carries the object preference order and JSON shape from the spike verbatim', () => {
    const prompt = buildDoorAnchorPrompt(640, 400);
    expect(prompt).toContain('front entry door > garage door > exterior brick coursing');
    expect(prompt).toContain('"object":"front_door"|"garage_door"|"window"|"step_riser"|"brick_course"|"none"');
  });
});

describe('isValidDoorAnchorModelResult', () => {
  const valid: DoorAnchorModelResult = {
    object: 'front_door',
    garageDoorWidth: null,
    bbox: [10, 20, 30, 80],
    confidence: 0.9,
  };

  it('accepts a well-formed result', () => {
    expect(isValidDoorAnchorModelResult(valid)).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(isValidDoorAnchorModelResult(null)).toBe(false);
    expect(isValidDoorAnchorModelResult('front_door')).toBe(false);
    expect(isValidDoorAnchorModelResult(undefined)).toBe(false);
  });

  it('rejects an off-enum object', () => {
    expect(isValidDoorAnchorModelResult({ ...valid, object: 'dragon' })).toBe(false);
  });

  it('rejects an off-enum garageDoorWidth', () => {
    expect(isValidDoorAnchorModelResult({ ...valid, garageDoorWidth: 'triple' })).toBe(false);
  });

  it('accepts garageDoorWidth single/double/null', () => {
    expect(isValidDoorAnchorModelResult({ ...valid, garageDoorWidth: 'single' })).toBe(true);
    expect(isValidDoorAnchorModelResult({ ...valid, garageDoorWidth: 'double' })).toBe(true);
    expect(isValidDoorAnchorModelResult({ ...valid, garageDoorWidth: null })).toBe(true);
  });

  it('rejects a bbox that is not a 4-tuple of finite numbers', () => {
    expect(isValidDoorAnchorModelResult({ ...valid, bbox: [1, 2, 3] })).toBe(false);
    expect(isValidDoorAnchorModelResult({ ...valid, bbox: [1, 2, 3, 'x'] })).toBe(false);
    expect(isValidDoorAnchorModelResult({ ...valid, bbox: [1, 2, 3, NaN] })).toBe(false);
    expect(isValidDoorAnchorModelResult({ ...valid, bbox: 'not-an-array' })).toBe(false);
  });

  it('rejects a non-finite confidence', () => {
    expect(isValidDoorAnchorModelResult({ ...valid, confidence: NaN })).toBe(false);
    expect(isValidDoorAnchorModelResult({ ...valid, confidence: 'high' })).toBe(false);
  });

  it('rejects a missing field', () => {
    const missingConfidence: Record<string, unknown> = { ...valid };
    delete missingConfidence.confidence;
    expect(isValidDoorAnchorModelResult(missingConfidence)).toBe(false);
  });
});

describe('doorAnchorScaleFromModelResult', () => {
  it('front_door: ftPerPx = (80in/12) / bboxHeightPx', () => {
    const r: DoorAnchorModelResult = { object: 'front_door', garageDoorWidth: null, bbox: [0, 0, 40, 100], confidence: 0.8 };
    const scale = doorAnchorScaleFromModelResult(r);
    expect(scale).not.toBeNull();
    expect(scale!.ftPerPx).toBeCloseTo((80 / 12) / 100, 10);
    expect(scale!.source).toBe('front-door');
    expect(scale!.confidence).toBe(0.8);
  });

  it('front_door: bbox height <= 0 -> null', () => {
    const r: DoorAnchorModelResult = { object: 'front_door', garageDoorWidth: null, bbox: [0, 0, 40, 0], confidence: 0.8 };
    expect(doorAnchorScaleFromModelResult(r)).toBeNull();
  });

  it('garage_door single: ftPerPx = (108in/12) / bboxWidthPx', () => {
    const r: DoorAnchorModelResult = { object: 'garage_door', garageDoorWidth: 'single', bbox: [0, 0, 200, 60], confidence: 0.7 };
    const scale = doorAnchorScaleFromModelResult(r);
    expect(scale).not.toBeNull();
    expect(scale!.ftPerPx).toBeCloseTo((108 / 12) / 200, 10);
    expect(scale!.source).toBe('garage-door');
  });

  it('garage_door double: ftPerPx = (192in/12) / bboxWidthPx', () => {
    const r: DoorAnchorModelResult = { object: 'garage_door', garageDoorWidth: 'double', bbox: [0, 0, 350, 70], confidence: 0.6 };
    const scale = doorAnchorScaleFromModelResult(r);
    expect(scale).not.toBeNull();
    expect(scale!.ftPerPx).toBeCloseTo((192 / 12) / 350, 10);
  });

  it('garage_door: ambiguous width (null) -> null, no standard size to anchor to', () => {
    const r: DoorAnchorModelResult = { object: 'garage_door', garageDoorWidth: null, bbox: [0, 0, 200, 60], confidence: 0.7 };
    expect(doorAnchorScaleFromModelResult(r)).toBeNull();
  });

  it('garage_door: bbox width <= 0 -> null', () => {
    const r: DoorAnchorModelResult = { object: 'garage_door', garageDoorWidth: 'single', bbox: [0, 0, 0, 60], confidence: 0.7 };
    expect(doorAnchorScaleFromModelResult(r)).toBeNull();
  });

  it('window/step_riser/brick_course/none -> null (scope narrowed from the spike, see module comment)', () => {
    const objects: DoorAnchorModelResult['object'][] = ['window', 'step_riser', 'brick_course', 'none'];
    for (const object of objects) {
      const r: DoorAnchorModelResult = { object, garageDoorWidth: null, bbox: [0, 0, 40, 80], confidence: 0.5 };
      expect(doorAnchorScaleFromModelResult(r)).toBeNull();
    }
  });
});

describe('rescaleFtPerPxToOriginal', () => {
  it('scales up when the sent image was downscaled from a larger original', () => {
    // Sent image is half the original's width -> a real-world extent spans
    // half as many pixels in the sent image, so its ftPerPx must be halved
    // to describe the ORIGINAL (larger) pixel grid.
    const sentFtPerPx = 0.1; // ft per px, in the (downscaled) sent image
    const result = rescaleFtPerPxToOriginal(sentFtPerPx, 800, 1600);
    expect(result).toBeCloseTo(0.05, 10);
  });

  it('is a no-op when the sent and original widths match (no downscale happened)', () => {
    expect(rescaleFtPerPxToOriginal(0.1, 1000, 1000)).toBeCloseTo(0.1, 10);
  });

  it('is a no-op (returns the input unchanged) when either width is not a real positive number', () => {
    expect(rescaleFtPerPxToOriginal(0.1, 0, 1000)).toBe(0.1);
    expect(rescaleFtPerPxToOriginal(0.1, 1000, 0)).toBe(0.1);
    expect(rescaleFtPerPxToOriginal(0.1, -5, 1000)).toBe(0.1);
    expect(rescaleFtPerPxToOriginal(0.1, 1000, NaN)).toBe(0.1);
  });

  it('never returns NaN or Infinity for finite positive inputs', () => {
    const result = rescaleFtPerPxToOriginal(0.2, 500, 2000);
    expect(Number.isFinite(result)).toBe(true);
  });
});
