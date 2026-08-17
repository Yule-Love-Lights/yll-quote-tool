import { describe, expect, it } from 'vitest';

import {
  ceilSeconds,
  clipAndMerge,
  envelopeMs,
  floorSeconds,
  parseMs,
  subtractSpans,
  totalMs,
  type Span,
} from './timeSpans';

const T = (hhmmss: string) => `2026-08-12T${hhmmss}Z`;
const iv = (start: string, end: string | null) => ({ start: T(start), end: end && T(end) });
const NOW = Date.parse(T('16:00:00.000'));

const span = (startMs: number, endMs: number): Span => ({ start: startMs, end: endMs });
const at = (hhmmss: string) => Date.parse(T(hhmmss));

describe('parseMs', () => {
  it('returns null for an unparseable value rather than NaN', () => {
    expect(parseMs('not-a-date')).toBeNull();
    expect(parseMs('')).toBeNull();
  });
});

describe('envelopeMs', () => {
  it('runs an open interval to now', () => {
    expect(envelopeMs(iv('08:00:00.000', null), NOW)).toEqual({
      start: at('08:00:00.000'),
      end: NOW,
    });
  });

  it('collapses an end that precedes its start, rather than going negative', () => {
    const e = envelopeMs(iv('16:00:00.000', '08:00:00.000'), NOW);
    expect(e).not.toBeNull();
    expect(e!.end).toBe(e!.start);
  });

  it('returns null when the start is unparseable', () => {
    expect(envelopeMs({ start: 'nope', end: T('16:00:00.000') }, NOW)).toBeNull();
  });
});

describe('clipAndMerge', () => {
  const envelope = span(at('08:00:00.000'), at('16:00:00.000'));

  it('clips a span that overruns the envelope on either side', () => {
    const merged = clipAndMerge(
      envelope,
      [iv('07:00:00.000', '09:00:00.000'), iv('15:00:00.000', '18:00:00.000')],
      NOW,
    );
    expect(merged).toEqual([
      span(at('08:00:00.000'), at('09:00:00.000')),
      span(at('15:00:00.000'), at('16:00:00.000')),
    ]);
  });

  it('drops a span entirely outside the envelope', () => {
    expect(clipAndMerge(envelope, [iv('17:00:00.000', '18:00:00.000')], NOW)).toEqual([]);
  });

  it('merges overlapping spans into their union, counting the overlap once', () => {
    const merged = clipAndMerge(
      envelope,
      [iv('12:00:00.000', '12:30:00.000'), iv('12:15:00.000', '12:45:00.000')],
      NOW,
    );
    expect(merged).toEqual([span(at('12:00:00.000'), at('12:45:00.000'))]);
    expect(totalMs(merged)).toBe(45 * 60 * 1000);
  });

  it('merges a nested span', () => {
    const merged = clipAndMerge(
      envelope,
      [iv('12:00:00.000', '13:00:00.000'), iv('12:15:00.000', '12:30:00.000')],
      NOW,
    );
    expect(totalMs(merged)).toBe(60 * 60 * 1000);
  });

  it('merges touching spans without changing the total', () => {
    const merged = clipAndMerge(
      envelope,
      [iv('10:00:00.000', '10:15:00.000'), iv('10:15:00.000', '10:30:00.000')],
      NOW,
    );
    expect(merged).toHaveLength(1);
    expect(totalMs(merged)).toBe(30 * 60 * 1000);
  });

  it('keeps genuinely separate spans separate', () => {
    const merged = clipAndMerge(
      envelope,
      [iv('10:00:00.000', '10:15:00.000'), iv('12:00:00.000', '12:30:00.000')],
      NOW,
    );
    expect(merged).toHaveLength(2);
    expect(totalMs(merged)).toBe(45 * 60 * 1000);
  });

  it('skips an unparseable span instead of poisoning the result', () => {
    const merged = clipAndMerge(
      envelope,
      [{ start: 'nope', end: T('12:30:00.000') }, iv('12:00:00.000', '12:30:00.000')],
      NOW,
    );
    expect(totalMs(merged)).toBe(30 * 60 * 1000);
  });

  it('runs an open span to now', () => {
    const merged = clipAndMerge(span(at('08:00:00.000'), NOW), [iv('15:00:00.000', null)], NOW);
    expect(totalMs(merged)).toBe(60 * 60 * 1000);
  });
});

describe('subtractSpans', () => {
  it('removes a cut in the middle, leaving two pieces', () => {
    const out = subtractSpans(
      [span(at('09:00:00.000'), at('12:00:00.000'))],
      [span(at('10:00:00.000'), at('10:30:00.000'))],
    );
    expect(out).toEqual([
      span(at('09:00:00.000'), at('10:00:00.000')),
      span(at('10:30:00.000'), at('12:00:00.000')),
    ]);
    expect(totalMs(out)).toBe(150 * 60 * 1000);
  });

  it('trims from the left edge', () => {
    const out = subtractSpans(
      [span(at('09:00:00.000'), at('12:00:00.000'))],
      [span(at('08:00:00.000'), at('09:30:00.000'))],
    );
    expect(out).toEqual([span(at('09:30:00.000'), at('12:00:00.000'))]);
  });

  it('trims from the right edge', () => {
    const out = subtractSpans(
      [span(at('09:00:00.000'), at('12:00:00.000'))],
      [span(at('11:30:00.000'), at('13:00:00.000'))],
    );
    expect(out).toEqual([span(at('09:00:00.000'), at('11:30:00.000'))]);
  });

  it('removes a fully covered span entirely', () => {
    expect(
      subtractSpans(
        [span(at('09:00:00.000'), at('12:00:00.000'))],
        [span(at('08:00:00.000'), at('13:00:00.000'))],
      ),
    ).toEqual([]);
  });

  it('leaves a disjoint cut alone', () => {
    const minuend = [span(at('09:00:00.000'), at('12:00:00.000'))];
    expect(subtractSpans(minuend, [span(at('13:00:00.000'), at('14:00:00.000'))])).toEqual(minuend);
  });

  it('applies several cuts across several spans', () => {
    const out = subtractSpans(
      [
        span(at('09:00:00.000'), at('12:00:00.000')),
        span(at('13:00:00.000'), at('15:00:00.000')),
      ],
      [
        span(at('10:00:00.000'), at('10:30:00.000')),
        span(at('13:30:00.000'), at('14:00:00.000')),
      ],
    );
    expect(totalMs(out)).toBe((150 + 90) * 60 * 1000);
  });

  it('is a no-op when there is nothing to subtract', () => {
    const minuend = [span(at('09:00:00.000'), at('12:00:00.000'))];
    expect(subtractSpans(minuend, [])).toEqual(minuend);
  });

  it('does not mutate its input', () => {
    const minuend = [span(at('09:00:00.000'), at('12:00:00.000'))];
    const copy = minuend.map((s) => ({ ...s }));
    subtractSpans(minuend, [span(at('10:00:00.000'), at('10:30:00.000'))]);
    expect(minuend).toEqual(copy);
  });
});

describe('rounding', () => {
  it('ceilSeconds rounds up and never goes negative', () => {
    expect(ceilSeconds(10_500)).toBe(11);
    expect(ceilSeconds(10_000)).toBe(10);
    expect(ceilSeconds(-5_000)).toBe(0);
  });

  it('floorSeconds rounds down and never goes negative', () => {
    expect(floorSeconds(10_500)).toBe(10);
    expect(floorSeconds(10_000)).toBe(10);
    expect(floorSeconds(-5_000)).toBe(0);
  });

  it('the pair keeps envelope minus subtracted exact on millisecond inputs', () => {
    // The S58 regression, pinned here at the arithmetic layer so it cannot
    // come back through a different caller.
    const envelope = 10_700;
    const subtracted = 400;
    expect(ceilSeconds(envelope) - floorSeconds(subtracted)).toBe(11);
    expect(floorSeconds(subtracted) + (ceilSeconds(envelope) - floorSeconds(subtracted))).toBe(
      ceilSeconds(envelope),
    );
  });
});
