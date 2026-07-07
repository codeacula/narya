import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../shared/api';
import { normalizeCommandUpsert, renderTemplate } from './chatbotCommands';

function chatReply(template: string) {
  return [{ type: 'chat_reply', enabled: true, payload: { template } }];
}

describe('normalizeCommandUpsert', () => {
  test('accepts a valid command and lowercases the trigger', () => {
    const result = normalizeCommandUpsert({ command: '!Site', actions: chatReply('hello') });
    expect(result.command).toBe('!site');
    expect(result.enabled).toBe(true);
    expect(result.actions).toHaveLength(1);
  });

  test('rejects a trigger that does not start with !', () => {
    expect(() => normalizeCommandUpsert({ command: 'site', actions: chatReply('hi') }))
      .toThrow('Command must start with !');
  });

  test('rejects an empty action list', () => {
    expect(() => normalizeCommandUpsert({ command: '!site', actions: [] }))
      .toThrow('At least one command action is required.');
  });

  test('rejects more than five actions', () => {
    const actions = Array.from({ length: 6 }, () => ({ type: 'obs_transition', enabled: true, payload: {} }));
    expect(() => normalizeCommandUpsert({ command: '!site', actions }))
      .toThrow('at most five actions');
  });

  test('rejects a chat_reply without a template', () => {
    expect(() => normalizeCommandUpsert({ command: '!site', actions: chatReply('') }))
      .toThrow('Chat reply actions need a response.');
  });

  test('rejects a sound_play without a sound id', () => {
    expect(() => normalizeCommandUpsert({ command: '!boom', actions: [{ type: 'sound_play', enabled: true, payload: {} }] }))
      .toThrow('Sound actions need a sound button.');
  });

  test('rejects a chat_reply that starts with a command trigger (A12)', () => {
    expect(() => normalizeCommandUpsert({ command: '!loop', actions: chatReply('!quack and more') }))
      .toThrow('Chat replies must not start with a command trigger.');
  });

  test('rejects an unsupported action type', () => {
    expect(() => normalizeCommandUpsert({ command: '!site', actions: [{ type: 'nope', enabled: true, payload: {} }] }))
      .toThrow('Unsupported command action');
  });
});

describe('renderTemplate', () => {
  const message = { username: 'viewer', displayName: 'Viewer' } as ChatMessage;

  test('substitutes {username} with the display name', () => {
    expect(renderTemplate('hi {username}!', message)).toBe('hi Viewer!');
  });

  test('replaces every {username} occurrence', () => {
    expect(renderTemplate('{username} {username}', message)).toBe('Viewer Viewer');
  });

  test('falls back to username when displayName is empty', () => {
    expect(renderTemplate('yo {username}', { username: 'viewer', displayName: '' } as ChatMessage)).toBe('yo viewer');
  });
});
