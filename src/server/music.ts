import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MusicInfo } from '../shared/api';
import { config } from './config';
import { broadcast } from './realtime';

const execFileAsync = promisify(execFile);

let currentMusic: MusicInfo = {
  status: 'unavailable',
  playerName: null,
  artist: null,
  title: null,
  album: null,
  source: 'none',
  updatedAt: new Date().toISOString(),
};
let lastMusicFingerprint = '';
let musicPollRunning = false;
let manualMusicActive = false;

function cleanMetadata(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStatus(status: string): MusicInfo['status'] {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'playing') return 'playing';
  if (normalized === 'paused') return 'paused';
  if (normalized === 'stopped') return 'stopped';
  return 'unavailable';
}

function unavailableMusic(): MusicInfo {
  return {
    status: 'unavailable',
    playerName: null,
    artist: null,
    title: null,
    album: null,
    source: 'none',
    updatedAt: new Date().toISOString(),
  };
}

export function getCurrentMusic(): MusicInfo {
  return currentMusic;
}

export function updateMusic(nextMusic: MusicInfo) {
  currentMusic = nextMusic;

  const fingerprint = JSON.stringify({
    status: currentMusic.status,
    playerName: currentMusic.playerName,
    artist: currentMusic.artist,
    title: currentMusic.title,
    album: currentMusic.album,
    source: currentMusic.source,
  });

  if (fingerprint !== lastMusicFingerprint) {
    lastMusicFingerprint = fingerprint;
    broadcast('music:updated', currentMusic);
  }
}

async function readPlayerctlMusicForPlayer(playerName: string | null): Promise<MusicInfo> {
  const updatedAt = new Date().toISOString();
  const playerArgs = playerName ? ['--player', playerName] : [];
  const statusResult = await execFileAsync('playerctl', [...playerArgs, 'status'], { timeout: 1200 });
  const metadataResult = await execFileAsync(
    'playerctl',
    [...playerArgs, 'metadata', '--format', '{{playerName}}\t{{artist}}\t{{title}}\t{{album}}'],
    { timeout: 1200 },
  );
  const [reportedPlayerName = '', artist = '', title = '', album = ''] = metadataResult.stdout.trimEnd().split('\t');

  return {
    status: normalizeStatus(statusResult.stdout),
    playerName: cleanMetadata(reportedPlayerName) ?? playerName,
    artist: cleanMetadata(artist),
    title: cleanMetadata(title),
    album: cleanMetadata(album),
    source: 'playerctl',
    updatedAt,
  };
}

async function readPlayerctlMusic(): Promise<MusicInfo> {
  if (config.musicPlayerctlPlayer) {
    return readPlayerctlMusicForPlayer(config.musicPlayerctlPlayer);
  }

  const playersResult = await execFileAsync('playerctl', ['-l'], { timeout: 1200 });
  const players = playersResult.stdout
    .split('\n')
    .map((player) => player.trim())
    .filter(Boolean);

  if (players.length === 0) {
    return readPlayerctlMusicForPlayer(null);
  }

  const results = await Promise.allSettled(players.map((player) => readPlayerctlMusicForPlayer(player)));
  const candidates = results
    .filter((result): result is PromiseFulfilledResult<MusicInfo> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((music) => music.title);

  const playing = candidates.find((music) => music.status === 'playing');
  if (playing) return playing;

  const paused = candidates.find((music) => music.status === 'paused');
  if (paused) return paused;

  if (candidates[0]) return candidates[0];
  return readPlayerctlMusicForPlayer(null);
}

export async function pollMusic() {
  if (manualMusicActive) return;
  if (musicPollRunning) return;
  musicPollRunning = true;

  try {
    updateMusic(await readPlayerctlMusic());
  } catch (error) {
    console.error('Music: polling failed:', error);
    updateMusic(unavailableMusic());
  } finally {
    musicPollRunning = false;
  }
}

export function setManualMusic(input: Partial<Record<keyof MusicInfo, unknown>>): MusicInfo | null {
  const title = typeof input.title === 'string' ? cleanMetadata(input.title) : null;
  const artist = typeof input.artist === 'string' ? cleanMetadata(input.artist) : null;
  const album = typeof input.album === 'string' ? cleanMetadata(input.album) : null;
  const playerName = typeof input.playerName === 'string' ? cleanMetadata(input.playerName) : 'Manual';
  const status = typeof input.status === 'string' ? normalizeStatus(input.status) : title ? 'playing' : 'stopped';

  if (status === 'unavailable') return null;

  manualMusicActive = true;

  const nextMusic: MusicInfo = {
    status,
    playerName,
    artist,
    title,
    album,
    source: 'manual',
    updatedAt: new Date().toISOString(),
  };
  updateMusic(nextMusic);
  return nextMusic;
}

export async function clearManualMusic(): Promise<MusicInfo> {
  manualMusicActive = false;
  await pollMusic();
  return currentMusic;
}

export function startMusicPolling() {
  if (config.musicPollIntervalMs <= 0) return;
  void pollMusic();
  setInterval(() => void pollMusic(), config.musicPollIntervalMs);
}
