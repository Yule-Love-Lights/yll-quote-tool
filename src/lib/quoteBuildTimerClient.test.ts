import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  createQuoteBuildTimerClient,
  quoteBuildTimerEligible,
  shouldStartPrefilledQuoteTimer,
} from './quoteBuildTimerClient';

const TIMER_ID = '11111111-2222-4333-8444-555555555555';
const QUOTE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('quote build timer eligibility', () => {
  it('starts for a real draft whose contact is already filled on builder open', () => {
    expect(
      shouldStartPrefilledQuoteTimer({
        hasPrefilledContact: true,
        isTest: false,
        viewOnly: false,
        status: 'draft',
      }),
    ).toBe(true);
    expect(
      shouldStartPrefilledQuoteTimer({
        hasPrefilledContact: true,
        isTest: false,
        viewOnly: false,
        status: null,
      }),
    ).toBe(true);
  });

  it('excludes test, view-only, already-sent, and contactless builders', () => {
    expect(quoteBuildTimerEligible({ isTest: true, viewOnly: false, status: 'draft' })).toBe(false);
    expect(quoteBuildTimerEligible({ isTest: false, viewOnly: true, status: 'draft' })).toBe(false);
    expect(quoteBuildTimerEligible({ isTest: false, viewOnly: false, status: 'sent' })).toBe(false);
    expect(
      shouldStartPrefilledQuoteTimer({
        hasPrefilledContact: false,
        isTest: false,
        viewOnly: false,
        status: 'draft',
      }),
    ).toBe(false);
  });
});

describe('createQuoteBuildTimerClient', () => {
  it('starts exactly once and keeps the first start reason', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const timer = createQuoteBuildTimerClient({ fetcher, randomUuid: () => TIMER_ID });

    const [first, second] = await Promise.all([
      timer.start('contact_selected'),
      timer.start('prefilled_open'),
    ]);

    expect(first).toBe(TIMER_ID);
    expect(second).toBe(TIMER_ID);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/quote-build-sessions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timerId: TIMER_ID, startReason: 'contact_selected' }),
      }),
    );
  });

  it('uses the live saved quote id when a contact is picked after an earlier save', () => {
    const source = readFileSync(
      new URL('../components/quote/QuoteBuilder.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain("start('contact_selected', savedQuoteId)");
    expect(source).not.toContain("start('contact_selected', initialQuote?.quoteId)");
    expect(source).toContain('...(quoteBuildTimer ? quoteBuildTimer : {})');
  });

  it('starts a saved draft in one keepalive request so navigation cannot strand the link', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const timer = createQuoteBuildTimerClient({ fetcher, randomUuid: () => TIMER_ID });

    await timer.start('prefilled_open', QUOTE_ID);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/quote-build-sessions',
      expect.objectContaining({
        body: JSON.stringify({ timerId: TIMER_ID, startReason: 'prefilled_open', quoteId: QUOTE_ID }),
        keepalive: true,
      }),
    );
    expect(timer.currentId()).toBe(TIMER_ID);
  });

  it('links after the start attempt and sends the same id and reason', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const timer = createQuoteBuildTimerClient({ fetcher, randomUuid: () => TIMER_ID });

    await timer.start('prefilled_open');
    await timer.link(QUOTE_ID);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/quote-build-sessions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timerId: TIMER_ID, startReason: 'prefilled_open', quoteId: QUOTE_ID }),
      }),
    );
    expect(timer.currentId()).toBe(TIMER_ID);
  });

  it('fails open and retries persistence when the quote becomes available', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'down' }), { status: 500 }));
    const timer = createQuoteBuildTimerClient({ fetcher, randomUuid: () => TIMER_ID });

    await expect(timer.start('contact_selected')).resolves.toBeNull();
    await expect(timer.link(QUOTE_ID)).resolves.toBeUndefined();
    expect(timer.currentId()).toBe(TIMER_ID);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/quote-build-sessions',
      expect.objectContaining({
        body: JSON.stringify({ timerId: TIMER_ID, startReason: 'contact_selected', quoteId: QUOTE_ID }),
      }),
    );
  });

  it('exposes the timer id immediately while persistence is still in flight', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    const timer = createQuoteBuildTimerClient({ fetcher, randomUuid: () => TIMER_ID });

    const pending = timer.start('contact_selected');
    expect(timer.currentId()).toBe(TIMER_ID);
    expect(timer.current()).toEqual({
      quoteBuildTimerId: TIMER_ID,
      quoteBuildStartReason: 'contact_selected',
    });

    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(pending).resolves.toBe(TIMER_ID);
  });
});
