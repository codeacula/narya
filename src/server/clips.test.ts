import { describe, expect, test } from 'bun:test';
import {
  createClipButton,
  deleteClipButton,
  getClipButtons,
  triggerClipButton,
  updateClipButton,
} from './clips';
import { HttpRouteError } from './http';
import { listMediaFiles } from './media';

// public/clips is gitignored, so a video fixture may not exist in CI. The
// happy-path cases below are guarded on one being present.
const aVideo = listMediaFiles().find(file => file.kind === 'video')?.src ?? null;
const anAudio = listMediaFiles().find(file => file.kind === 'audio')?.src ?? null;

describe('clip buttons', () => {
  test('requires a label', () => {
    expect(() => createClipButton({ label: '', filename: aVideo ?? '/clips/x.mp4' })).toThrow(HttpRouteError);
  });

  test('rejects a file that is not an available video', () => {
    expect(() => createClipButton({ label: 'Missing', filename: '/clips/does-not-exist.mp4' })).toThrow(HttpRouteError);
  });

  test('rejects an audio file (wrong kind)', () => {
    if (!anAudio) return;
    expect(() => createClipButton({ label: 'Not a clip', filename: anAudio })).toThrow(HttpRouteError);
  });

  test('update and delete of an unknown id are 404s', () => {
    expect(() => updateClipButton('nope', { label: 'X', filename: aVideo ?? '/clips/x.mp4' })).toThrow(HttpRouteError);
    expect(() => deleteClipButton('nope')).toThrow(HttpRouteError);
  });

  test('triggerClipButton returns null for an unknown id', () => {
    expect(triggerClipButton('nope')).toBeNull();
  });

  test.if(Boolean(aVideo))('creates, lists, plays, and deletes a clip button', () => {
    const created = createClipButton({ label: 'Test Clip', filename: aVideo! });
    expect(created.id).toBeTruthy();
    expect(getClipButtons().some(clip => clip.id === created.id)).toBe(true);

    const playback = triggerClipButton(created.id);
    expect(playback?.src).toBe(aVideo!);
    expect(playback?.kind).toBe('video');

    deleteClipButton(created.id);
    expect(getClipButtons().some(clip => clip.id === created.id)).toBe(false);
  });
});
