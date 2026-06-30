import { describe, it, expect } from 'vitest';
import { buildDraftPrompt, type DraftContext } from './draft';

const base: DraftContext = {
  customerName: 'Jane', source: 'ghl', channel: 'sms',
  recentMessages: [{ fromCustomer: true, text: 'How much for my roofline?' }],
  quoteTotal: null,
};

describe('buildDraftPrompt', () => {
  it('encodes the no-hard-commitments guardrail and the YLL sign-off in the system prompt', () => {
    const { system } = buildDraftPrompt(base);
    expect(system.toLowerCase()).toContain('do not');
    expect(system.toLowerCase()).toMatch(/price|date|schedul/);
    expect(system).toContain('Yule Love Lights team');
  });
  it('puts the customer name and the recent message into the user prompt', () => {
    const { user } = buildDraftPrompt(base);
    expect(user).toContain('Jane');
    expect(user).toContain('How much for my roofline?');
  });
  it('labels who said what', () => {
    const { user } = buildDraftPrompt({ ...base, recentMessages: [
      { fromCustomer: true, text: 'hi' }, { fromCustomer: false, text: 'hello' },
    ] });
    expect(user).toMatch(/customer/i);
    expect(user).toMatch(/us|you|team/i);
  });
  it('mentions the customer has a quote when quoteTotal is set, without stating the number as a promise', () => {
    const { user } = buildDraftPrompt({ ...base, source: 'quotetool', quoteTotal: 2218.5 });
    expect(user.toLowerCase()).toContain('quote');
  });
});
