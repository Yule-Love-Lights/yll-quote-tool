import type { QuoteStatus } from './quoteStatus';

export type QuoteBuildStartReason = 'contact_selected' | 'prefilled_open';

type TimerEligibility = {
  isTest: boolean;
  viewOnly: boolean;
  status: QuoteStatus | null;
};

export function quoteBuildTimerEligible(input: TimerEligibility): boolean {
  return !input.isTest && !input.viewOnly && (input.status === null || input.status === 'draft');
}

export function shouldStartPrefilledQuoteTimer(
  input: TimerEligibility & { hasPrefilledContact: boolean },
): boolean {
  return input.hasPrefilledContact && quoteBuildTimerEligible(input);
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type QuoteBuildTimerClient = {
  start: (reason: QuoteBuildStartReason, quoteId?: string | null) => Promise<string | null>;
  link: (quoteId: string) => Promise<void>;
  currentId: () => string | null;
  current: () => {
    quoteBuildTimerId: string;
    quoteBuildStartReason: QuoteBuildStartReason;
  } | null;
};

export function createQuoteBuildTimerClient({
  fetcher = (input, init) => fetch(input, init),
  randomUuid = () => crypto.randomUUID(),
}: {
  fetcher?: Fetcher;
  randomUuid?: () => string;
} = {}): QuoteBuildTimerClient {
  let timerId: string | null = null;
  let startReason: QuoteBuildStartReason | null = null;
  let startPromise: Promise<string | null> | null = null;
  let linkedQuoteId: string | null = null;

  const post = async (quoteId?: string | null): Promise<string | null> => {
    if (!timerId || !startReason) return null;
    try {
      const res = await fetcher('/api/quote-build-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timerId,
          startReason,
          ...(quoteId ? { quoteId } : {}),
        }),
        keepalive: true,
      });
      return res.ok ? timerId : null;
    } catch {
      return null;
    }
  };

  const start = (reason: QuoteBuildStartReason, quoteId?: string | null): Promise<string | null> => {
    if (startPromise) return startPromise;
    timerId = randomUuid();
    startReason = reason;
    startPromise = post(quoteId);
    if (quoteId) {
      void startPromise.then((linked) => {
        if (linked) linkedQuoteId = quoteId;
      });
    }
    return startPromise;
  };

  return {
    start,
    async link(quoteId) {
      if (linkedQuoteId === quoteId || !startPromise) return;
      await startPromise;
      if (linkedQuoteId === quoteId) return;
      if (await post(quoteId)) linkedQuoteId = quoteId;
    },
    currentId: () => timerId,
    current: () => timerId && startReason
      ? { quoteBuildTimerId: timerId, quoteBuildStartReason: startReason }
      : null,
  };
}
