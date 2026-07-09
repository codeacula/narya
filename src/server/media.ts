import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MediaFile, MediaKind } from '../shared/api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', '..', 'public');

/** Folders under public/ that hold redeem-playable media. */
const MEDIA_ROOTS = ['clips', 'sounds'];

const KIND_BY_EXTENSION: Record<string, MediaKind> = {
  '.mp4': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.wav': 'audio',
};

export function mediaKindForPath(filePath: string): MediaKind | null {
  return KIND_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

function walk(absoluteDir: string, urlPrefix: string, out: MediaFile[]): void {
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolute = path.join(absoluteDir, entry.name);
    const url = `${urlPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(absolute, url, out);
      continue;
    }
    const kind = mediaKindForPath(entry.name);
    if (!kind) continue;
    out.push({
      src: url,
      label: path.basename(entry.name, path.extname(entry.name)),
      kind,
      sizeBytes: statSync(absolute).size,
    });
  }
}

/** Every playable file under public/clips and public/sounds, as URL paths. */
export function listMediaFiles(): MediaFile[] {
  const files: MediaFile[] = [];
  for (const root of MEDIA_ROOTS) {
    const absolute = path.join(publicDir, root);
    if (!existsSync(absolute)) continue;
    walk(absolute, `/${root}`, files);
  }
  return files.sort((a, b) => a.src.localeCompare(b.src));
}

/**
 * Whether a src names a file we actually serve. Bindings are checked against
 * the scanned catalog rather than pattern-matched, so a crafted path can't
 * escape public/ or point at another host.
 */
export function isKnownMediaSrc(src: string): boolean {
  return listMediaFiles().some(file => file.src === src);
}
