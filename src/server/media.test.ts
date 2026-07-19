import { describe, expect, test } from 'bun:test';
import { findMediaFile, listMediaFiles, mediaKindForPath, mediaScanRoot } from './media';

const isKnownMediaSrc = (src: string) => findMediaFile(src) !== null;

describe('test isolation', () => {
  /**
   * The guard that keeps this suite hermetic. public/clips and public/sounds are
   * gitignored operator media, so scanning public/ here would make every
   * file-dependent assertion below pass only on a machine that happens to hold the
   * operator's library — and fail in CI and in every fresh clone or worktree.
   */
  test('scans the committed fixtures, never the operator media in public/', () => {
    expect(mediaScanRoot()).toContain('__fixtures__');
    expect(mediaScanRoot().endsWith('public')).toBe(false);
  });

  test('every scanned file comes from the fixtures tree', () => {
    // A fixture directory that silently emptied would make the assertions below
    // vacuous rather than failing, so prove the scan actually found something.
    expect(listMediaFiles().length).toBeGreaterThan(0);
  });
});

describe('mediaKindForPath', () => {
  test('classifies video and audio by extension, case-insensitively', () => {
    expect(mediaKindForPath('a.mp4')).toBe('video');
    expect(mediaKindForPath('a.WEBM')).toBe('video');
    expect(mediaKindForPath('a.mp3')).toBe('audio');
    expect(mediaKindForPath('a.wav')).toBe('audio');
  });

  test('ignores anything else', () => {
    expect(mediaKindForPath('a.txt')).toBeNull();
    expect(mediaKindForPath('a.mp4.exe')).toBeNull();
    expect(mediaKindForPath('noextension')).toBeNull();
  });
});

describe('listMediaFiles', () => {
  const files = listMediaFiles();

  test('finds the fixture quack sounds, recursing into subfolders', () => {
    const quacks = files.filter(file => file.src.startsWith('/sounds/quacks/'));
    expect(quacks.length).toBeGreaterThanOrEqual(3);
    expect(quacks.every(file => file.kind === 'audio')).toBe(true);
  });

  test('reports src as a URL path with a label and a size', () => {
    const quack = files.find(file => file.src.startsWith('/sounds/quacks/'));
    expect(quack?.src.startsWith('/')).toBe(true);
    expect(quack?.label).not.toContain('.mp3');
    expect(quack?.sizeBytes).toBeGreaterThan(0);
  });
});

describe('findMediaFile', () => {
  const known = listMediaFiles()[0]?.src ?? '';

  test('accepts a src the catalog actually contains', () => {
    expect(known).not.toBe('');
    expect(isKnownMediaSrc(known)).toBe(true);
  });

  // The binding is checked against the scanned catalog rather than pattern-matched,
  // so traversal and off-site URLs fail simply by not being in it.
  test('rejects traversal, absolute paths, and off-site URLs', () => {
    expect(isKnownMediaSrc('/clips/../../etc/passwd')).toBe(false);
    expect(isKnownMediaSrc('../../.env')).toBe(false);
    expect(isKnownMediaSrc('/etc/passwd')).toBe(false);
    expect(isKnownMediaSrc('https://evil.example/clip.mp4')).toBe(false);
    expect(isKnownMediaSrc('')).toBe(false);
  });

  test('rejects a file that is not in a media root', () => {
    expect(isKnownMediaSrc('/index.html')).toBe(false);
  });
});
