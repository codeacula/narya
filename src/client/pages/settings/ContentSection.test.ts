import { describe, expect, test } from 'bun:test';
import type { MediaFile } from '../../../shared/api';
import { fileBinding } from './ContentSection';

const quack = { src: '/sounds/quack.mp3', label: 'quack.mp3', kind: 'audio' } as MediaFile;

describe('fileBinding', () => {
  // The bug: a failed file-list load set the list to [] and every saved button's file
  // read as "(missing)".
  test('a file list that failed or is loading cannot call a saved file missing', () => {
    expect(fileBinding('/sounds/quack.mp3', [], { status: 'failed', error: 'boom' })).toBe('unknown');
    expect(fileBinding('/sounds/quack.mp3', [], { status: 'loading' })).toBe('unknown');
  });

  test('only a loaded list that lacks the file says off-catalog', () => {
    expect(fileBinding('/sounds/gone.mp3', [quack], { status: 'loaded' })).toBe('off-catalog');
  });

  test('a listed file is in the catalog, and no file is none', () => {
    expect(fileBinding('/sounds/quack.mp3', [quack], { status: 'loaded' })).toBe('catalog');
    expect(fileBinding('', [], { status: 'failed', error: 'boom' })).toBe('none');
  });
});
