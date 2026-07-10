import { expect, test } from 'bun:test';
import { sceneLabel, switchableScenes } from './scenes';

test('switchableScenes keeps only Scene - prefixed entries when present', () => {
  const scenes = ['Scene - Starting', 'Webcam Full', 'Scene - Gaming'];
  expect(switchableScenes(scenes)).toEqual(['Scene - Starting', 'Scene - Gaming']);
});

test('switchableScenes falls back to all scenes when none are prefixed', () => {
  const scenes = ['Intro', 'Main', 'Outro'];
  expect(switchableScenes(scenes)).toEqual(scenes);
});

test('sceneLabel strips the Scene - prefix', () => {
  expect(sceneLabel('Scene - Starting')).toBe('Starting');
});

test('sceneLabel strips an optional numeric ordering prefix', () => {
  expect(sceneLabel('Scene - 01 - Starting')).toBe('Starting');
  expect(sceneLabel('Scene - 2. Gaming')).toBe('Gaming');
  expect(sceneLabel('Scene - 3) Ending')).toBe('Ending');
});

test('sceneLabel leaves an unprefixed name untouched', () => {
  expect(sceneLabel('Webcam Full')).toBe('Webcam Full');
});
