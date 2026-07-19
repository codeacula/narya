# Media fixtures

The scan root `src/server/media.ts` uses when `NODE_ENV=test`.

These are **not real media** — they are a few bytes of text with media extensions.
The scan only reads a file's extension (to classify it audio or video) and its
`stat()` size, so nothing here is ever decoded or played. Keeping them as
placeholders is what lets the suite stay hermetic without committing binaries.

## Why this directory exists

`public/clips/` and `public/sounds/` are gitignored operator media, so a fresh
clone or a new `git worktree` has no `public/` at all. The media tests used to
scan it anyway, which meant 21 tests passed only on the machine that happened to
have the operator's files and failed for everyone else, CI included.

## What depends on these exact names

Adding files is safe. Renaming or removing these will break tests:

| Path | Required by |
| --- | --- |
| `clips/dinosaur.mp4` | `redeemOnce.test.ts` seeds legacy rows pointing at this exact src, and the migration validates it against the scan. |
| `sounds/quacks/quack-{1,2,3}.mp3` | `media.test.ts` asserts the scan recurses into subfolders and finds at least three. |
| at least one audio **and** one video anywhere | `mediaAssets.test.ts` derives `KNOWN_AUDIO` / `KNOWN_VIDEO` from the first of each kind. |

The `clips/` and `sounds/` subfolder names must match `MEDIA_ROOTS` in
`src/server/media.ts`.
