import { expect, test } from 'bun:test';
import { sceneLabel, switchableScenes } from './scenes';

// The prefix the operator gets by default. It is configured in Settings now, so it
// arrives as an argument rather than being baked into the module.
const PREFIX = 'Scene - ';

test('switchableScenes keeps only prefixed entries when present', () => {
  const scenes = ['Scene - Starting', 'Webcam Full', 'Scene - Gaming'];
  expect(switchableScenes(scenes, PREFIX)).toEqual(['Scene - Starting', 'Scene - Gaming']);
});

test('switchableScenes falls back to all scenes when none are prefixed', () => {
  const scenes = ['Intro', 'Main', 'Outro'];
  expect(switchableScenes(scenes, PREFIX)).toEqual(scenes);
});

test('switchableScenes treats an empty prefix as "no convention"', () => {
  const scenes = ['Scene - Starting', 'Webcam Full'];
  expect(switchableScenes(scenes, '')).toEqual(scenes);
});

test('switchableScenes honours a custom prefix', () => {
  const scenes = ['OBS: Starting', 'Scene - Gaming', 'OBS: Ending'];
  expect(switchableScenes(scenes, 'OBS: ')).toEqual(['OBS: Starting', 'OBS: Ending']);
});

test('sceneLabel strips the prefix', () => {
  expect(sceneLabel('Scene - Starting', PREFIX)).toBe('Starting');
});

test('sceneLabel strips an optional numeric ordering prefix', () => {
  expect(sceneLabel('Scene - 01 - Starting', PREFIX)).toBe('Starting');
  expect(sceneLabel('Scene - 2. Gaming', PREFIX)).toBe('Gaming');
  expect(sceneLabel('Scene - 3) Ending', PREFIX)).toBe('Ending');
});

test('sceneLabel leaves an unprefixed name untouched', () => {
  expect(sceneLabel('Webcam Full', PREFIX)).toBe('Webcam Full');
});

test('sceneLabel leaves every name untouched when there is no prefix', () => {
  expect(sceneLabel('Scene - Starting', '')).toBe('Scene - Starting');
});

// A scene named exactly the prefix would otherwise render as a nameless button.
test('sceneLabel falls back to the full name rather than an empty label', () => {
  expect(sceneLabel('Scene - ', PREFIX)).toBe('Scene - ');
});
