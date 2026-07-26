import type { SoundButton, SoundButtonUpdate, SoundPlayback } from '../shared/api';
import { appConfig } from './appConfig';
import { db } from './db';
import { findMediaFile } from './media';
import { HttpRouteError } from './http';
import { createLabeledButtonRepo } from './labeledButtons';
import { broadcast } from './realtime';

/**
 * The sounds a fresh install starts with, so the tablet soundboard is not an empty
 * grid on first run. Seeded once (see below); deleting a button keeps it deleted.
 *
 * public/sounds is gitignored operator media (see .gitignore), so these files are
 * NOT shipped with the repo — a bare clone has none of them until the operator
 * restores their own library. `defaultSoundButtonsToSeed` only seeds the ones whose
 * file is actually present, so a fresh install gets an honestly-empty soundboard
 * instead of buttons that play nothing.
 */
export const DEFAULT_QUACK_SOUNDS = [
  '/sounds/quacks/075176_duck-quack-40345.mp3',
  '/sounds/quacks/duck-quack-112941.mp3',
  '/sounds/quacks/duck-quacking-37392.mp3',
];

const defaultSoundButtons = DEFAULT_QUACK_SOUNDS.map((filename, index) => ({
  id: `quack-${index + 1}`,
  label: `Quack ${index + 1}`,
  filename,
}));

/** Pulled out so the "skip a default whose file isn't there" decision is testable
 *  without touching the database or the real filesystem. IDs are assigned before
 *  filtering, so which quacks are missing never shifts the surviving ones' ids. */
export function defaultSoundButtonsToSeed(fileExists: (src: string) => boolean): SoundButton[] {
  return defaultSoundButtons.filter(sound => fileExists(sound.filename));
}

const countSoundButtons = db.prepare('select count(*) as count from sound_buttons');
const insertSoundButton = db.prepare(`
  insert or ignore into sound_buttons (id, label, filename)
  values (?, ?, ?)
`);

function seedSoundButtonsIfEmpty() {
  const row = countSoundButtons.get() as { count: number };
  if (row.count > 0) return;
  for (const sound of defaultSoundButtonsToSeed(src => findMediaFile(src) !== null)) {
    insertSoundButton.run(sound.id, sound.label, sound.filename);
  }
}

// Seed the defaults once at module load only. Re-seeding from the accessors
// resurrected deleted buttons on the next read.
seedSoundButtonsIfEmpty();

function normalizeSoundButtonBody(body: unknown): SoundButtonUpdate {
  const value = body as Partial<SoundButtonUpdate>;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const filename = typeof value.filename === 'string' ? value.filename.trim() : '';

  if (!label) throw new HttpRouteError(400, 'Sound label is required.');
  if (label.length > 60) throw new HttpRouteError(400, 'Sound label must be 60 characters or fewer.');
  if (!filename) throw new HttpRouteError(400, 'Sound file path is required.');
  if (filename.length > 240) throw new HttpRouteError(400, 'Sound file path must be 240 characters or fewer.');
  if (!filename.startsWith('/') && !/^https?:\/\//i.test(filename)) {
    throw new HttpRouteError(400, 'Sound file path must start with / or http(s)://.');
  }

  return { label, filename };
}

function playSound(src: string, volume = appConfig.soundVolume): SoundPlayback {
  const payload = {
    id: crypto.randomUUID(),
    src,
    volume,
  };
  broadcast('sound:play', payload);
  return payload;
}

const soundButtons = createLabeledButtonRepo<SoundButton, SoundPlayback>({
  table: 'sound_buttons',
  notFoundMessage: 'Sound button not found.',
  validate: normalizeSoundButtonBody,
  play: sound => playSound(sound.filename),
});

export function getSoundButtons(): SoundButton[] {
  return soundButtons.list();
}

export function createSoundButton(body: unknown): SoundButton {
  return soundButtons.create(body);
}

export function updateSoundButton(id: string, body: unknown): SoundButton {
  return soundButtons.update(id, body);
}

export function deleteSoundButton(id: string) {
  soundButtons.remove(id);
}

export function triggerSoundButton(id: string): SoundPlayback | null {
  return soundButtons.trigger(id);
}
