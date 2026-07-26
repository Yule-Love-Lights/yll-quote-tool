// Tests for the group-chat address gate. The property that matters: in a group
// the bot answers ONLY when spoken to, so two staff members talking to each
// other never trigger an interpreter call or a "didn't understand" reply.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAddressedToBot, isPrivateChat } from './botGroupGate';

const savedUsername = process.env.TELEGRAM_BOT_USERNAME;

beforeEach(() => {
  delete process.env.TELEGRAM_BOT_USERNAME;
});

afterEach(() => {
  if (savedUsername === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
  else process.env.TELEGRAM_BOT_USERNAME = savedUsername;
});

describe('isPrivateChat', () => {
  it('treats a missing chat type as private (1:1 is the default surface)', () => {
    expect(isPrivateChat(undefined)).toBe(true);
    expect(isPrivateChat(null)).toBe(true);
    expect(isPrivateChat('private')).toBe(true);
    expect(isPrivateChat('group')).toBe(false);
    expect(isPrivateChat('supergroup')).toBe(false);
  });
});

describe('isAddressedToBot — private chat', () => {
  it('accepts anything, including a bare confirmation', () => {
    expect(isAddressedToBot({ chatType: 'private', text: 'what installs are today?' })).toBe(true);
    expect(isAddressedToBot({ chatType: 'private', text: 'yes' })).toBe(true);
  });
});

describe('isAddressedToBot — group chat', () => {
  it('ignores ordinary conversation between people', () => {
    expect(isAddressedToBot({ chatType: 'group', text: 'yeah I already called him back' })).toBe(false);
    expect(isAddressedToBot({ chatType: 'supergroup', text: 'ok' })).toBe(false);
    expect(isAddressedToBot({ chatType: 'group', text: '' })).toBe(false);
    expect(isAddressedToBot({ chatType: 'group', text: '   ' })).toBe(false);
  });

  it('accepts a slash command (these arrive even with privacy mode ON)', () => {
    expect(isAddressedToBot({ chatType: 'group', text: '/jobs' })).toBe(true);
  });

  it('accepts an @mention of the bot', () => {
    process.env.TELEGRAM_BOT_USERNAME = 'yll_ops_bot';
    expect(isAddressedToBot({ chatType: 'group', text: '@yll_ops_bot what installs are today?' })).toBe(true);
    expect(isAddressedToBot({ chatType: 'group', text: 'hey @YLL_OPS_BOT status alvarez' })).toBe(true);
  });

  it('ignores a mention of a DIFFERENT bot or person', () => {
    process.env.TELEGRAM_BOT_USERNAME = 'yll_ops_bot';
    expect(isAddressedToBot({ chatType: 'group', text: '@jason can you check this' })).toBe(false);
    expect(isAddressedToBot({ chatType: 'group', text: '@yll_ops_bot_staging jobs' })).toBe(false);
  });

  it('accepts an explicit username override ahead of the env value', () => {
    process.env.TELEGRAM_BOT_USERNAME = 'env_bot';
    expect(isAddressedToBot({ chatType: 'group', text: '@passed_bot jobs', botUsername: 'passed_bot' })).toBe(true);
    expect(isAddressedToBot({ chatType: 'group', text: '@env_bot jobs', botUsername: 'passed_bot' })).toBe(false);
  });

  it('tolerates a username configured with a leading @', () => {
    process.env.TELEGRAM_BOT_USERNAME = '@yll_ops_bot';
    expect(isAddressedToBot({ chatType: 'group', text: '@yll_ops_bot jobs' })).toBe(true);
  });

  it('accepts a reply to the bot — this is how a bare "yes" confirms in a group', () => {
    expect(isAddressedToBot({ chatType: 'group', text: 'yes', isReplyToBot: true })).toBe(true);
  });

  it('accepts a reply to the bot even with EMPTY text (a voice-note or photo "yes")', () => {
    // Checked before the empty-text guard — a hands-free voice reply carries no
    // text but is unambiguously addressed to the bot.
    expect(isAddressedToBot({ chatType: 'group', text: '', isReplyToBot: true })).toBe(true);
  });

  it('never matches a mention when no username is configured', () => {
    expect(isAddressedToBot({ chatType: 'group', text: '@anything jobs' })).toBe(false);
  });
});
