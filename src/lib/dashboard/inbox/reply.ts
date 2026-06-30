// Pure reply-routing decision (#58 v2). Given an item's source/channel/GHL contact,
// decide how to send. The route executes the decision (sendSms/sendEmail). No I/O.

import type { InboxSource } from './types';

export type ReplyTarget =
  | { kind: 'send'; via: 'sms' | 'email'; contactId: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'no_contact'; reason: string };

export function resolveReplyTarget(
  item: { source: InboxSource; channel: string | null; ghlContactId: string | null },
  chosenChannel?: 'sms' | 'email',
): ReplyTarget {
  if (item.source === 'gmail') {
    return { kind: 'unsupported', reason: 'Reply to Gmail threads in Gmail — inline send is not available for email yet.' };
  }
  if (item.source === 'homeworks') {
    return { kind: 'unsupported', reason: 'Homeworks items are read-only.' };
  }
  if (!item.ghlContactId) {
    return { kind: 'no_contact', reason: 'No GoHighLevel contact linked — open this customer in GHL to reply.' };
  }
  // Quote leads default to email; GHL items follow their channel; calls/unknown → sms.
  let via: 'sms' | 'email';
  if (chosenChannel) via = chosenChannel;
  else if (item.source === 'quotetool') via = 'email';
  else via = item.channel === 'email' ? 'email' : 'sms';
  return { kind: 'send', via, contactId: item.ghlContactId };
}
