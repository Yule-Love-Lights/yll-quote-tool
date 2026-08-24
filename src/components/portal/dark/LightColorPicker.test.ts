// Tests for the pure analytics property builders extracted out of
// LightColorPicker (PostHog Wave 2 — daylight_toggled/color_changed/
// custom_colors_opened). No component-render test infra exists
// (@testing-library/jsdom isn't installed — see StickyBottomBar.test.ts), so
// this covers the event-name/property-shape contract as plain functions:
// exact keys, no extraneous PII (no hex values, no free-text color names —
// catalog scheme/color ids only).

import { describe, it, expect } from 'vitest';
import {
  daylightToggledProps,
  schemeChangedProps,
  customColorsOpenedProps,
  customColorAddedProps,
  colorPickerIntro,
  bookedColorRequestIntro,
} from './LightColorPicker';

describe('no-preview copy', () => {
  it('does not promise a live recolor when the house design is hidden', () => {
    expect(colorPickerIntro(false, false)).toBe(
      'Pick the color or pattern you’d like for your lights.',
    );
    expect(bookedColorRequestIntro(false)).toContain('Choose any colour above');
    expect(bookedColorRequestIntro(false)).not.toMatch(/preview/i);
  });

  it('keeps the live-preview copy when the house design is visible', () => {
    expect(colorPickerIntro(false, true)).toMatch(/recolors instantly above/i);
    expect(bookedColorRequestIntro(true)).toMatch(/preview any colour above/i);
  });
});

describe('daylightToggledProps (PostHog Wave 2)', () => {
  it('carries quote_id/service_type + the NEW on-state', () => {
    expect(daylightToggledProps('q1', 'holiday', true)).toEqual({
      quote_id: 'q1',
      service_type: 'holiday',
      on: true,
    });
  });

  it('reflects the toggled-off state exactly as passed', () => {
    expect(daylightToggledProps('q1', 'permanent', false)).toEqual({
      quote_id: 'q1',
      service_type: 'permanent',
      on: false,
    });
  });

  it('has exactly the three expected keys — no extraneous fields', () => {
    expect(Object.keys(daylightToggledProps('q1', 'holiday', true)).sort()).toEqual(
      ['on', 'quote_id', 'service_type'].sort(),
    );
  });

  it('tolerates an undefined quoteId/serviceType (mock/dev fallback)', () => {
    expect(daylightToggledProps(undefined, undefined, true)).toEqual({
      quote_id: undefined,
      service_type: undefined,
      on: true,
    });
  });
});

describe('schemeChangedProps (PostHog Wave 2)', () => {
  it('carries the catalog scheme id, never a hex/free-text value, with custom: false', () => {
    expect(schemeChangedProps('q1', 'holiday', 'warm-white')).toEqual({
      quote_id: 'q1',
      service_type: 'holiday',
      scheme: 'warm-white',
      custom: false,
    });
  });

  it('has exactly the four expected keys — no extraneous fields', () => {
    expect(Object.keys(schemeChangedProps('q1', 'holiday', 'warm-white')).sort()).toEqual(
      ['custom', 'quote_id', 'scheme', 'service_type'].sort(),
    );
  });
});

describe('customColorsOpenedProps (PostHog Wave 2)', () => {
  it('carries only quote_id/service_type — no color state (opening the builder, not picking a color)', () => {
    expect(customColorsOpenedProps('q1', 'event')).toEqual({
      quote_id: 'q1',
      service_type: 'event',
    });
  });

  it('has exactly the two expected keys — no extraneous fields', () => {
    expect(Object.keys(customColorsOpenedProps('q1', 'event')).sort()).toEqual(
      ['quote_id', 'service_type'].sort(),
    );
  });
});

describe('customColorAddedProps (PostHog Wave 2)', () => {
  it('carries the catalog color id (never a hex/free-text value), scheme: "custom", custom: true', () => {
    expect(customColorAddedProps('q1', 'permanent', 'ruby-red')).toEqual({
      quote_id: 'q1',
      service_type: 'permanent',
      scheme: 'custom',
      custom: true,
      color: 'ruby-red',
    });
  });

  it('has exactly the five expected keys — no extraneous fields', () => {
    expect(Object.keys(customColorAddedProps('q1', 'permanent', 'ruby-red')).sort()).toEqual(
      ['color', 'custom', 'quote_id', 'scheme', 'service_type'].sort(),
    );
  });
});
