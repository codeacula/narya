import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Spy on broadcast (static imports are hoisted, so the module under test is imported
// dynamically after the mock is installed).
const emitted: Array<{ event: string; payload: unknown }> = [];
const realtime = await import('./realtime');
mock.module('./realtime', () => ({
  ...realtime,
  broadcast: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
}));

const { db } = await import('./db');
const { flushViewer, unflushViewer } = await import('./viewerIdentity');

beforeEach(() => {
  db.exec('delete from chat_messages');
  db.exec('delete from ignored_logins');
  emitted.length = 0;
});

function seedMessage(id: string, username: string) {
  db.prepare(`
    insert into chat_messages (id, channel, username, display_name, message, received_at)
    values (?, 'codeacula', ?, ?, 'hi', '2026-11-14T11:59:00.000Z')
  `).run(id, username, username);
}

describe('flushing a viewer tells every open surface', () => {
  test('chat surfaces are told to drop the viewer, in the existing moderation shape', () => {
    seedMessage('m1', 'quietorbit');
    flushViewer('QuietOrbit');
    const moderated = emitted.filter(e => e.event === 'chat:moderated');
    expect(moderated).toHaveLength(1);
    expect(moderated[0]!.payload).toMatchObject({ type: 'user.ban', username: 'quietorbit', deletedReason: 'viewer flushed' });
  });

  test('no chat broadcast when the viewer had no stored messages', () => {
    flushViewer('lurker');
    expect(emitted.filter(e => e.event === 'chat:moderated')).toHaveLength(0);
  });

  test('flush and unflush refresh the top bars with the field-by-field payload', () => {
    flushViewer('quietorbit');
    unflushViewer('quietorbit');
    const latest = emitted.filter(e => e.event === 'overlay:latest-events');
    expect(latest).toHaveLength(2);
    expect(Object.keys(latest[0]!.payload as object).sort()).toEqual(['cheer', 'follow', 'raid', 'sub']);
  });
});
