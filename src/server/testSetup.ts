import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test preload (see bunfig.toml). Runs before any test module is imported, so
// db.ts sees an in-memory path and never opens the operator's real database.
// db.ts also defaults to :memory: under NODE_ENV=test; this is a second layer of
// protection because clobbering live config is a costly, silent failure.
process.env.STREAMER_TOOLS_DB ??= ':memory:';

// Same reasoning for the media scan root. media.ts also falls back to the fixtures
// under NODE_ENV=test, but that alone is not enough: `bun test` sets NODE_ENV=test
// only when it is UNSET, so `NODE_ENV=production bun test` left the suite scanning
// the operator's gitignored public/ — which is the exact failure the fixtures exist
// to remove. Setting it here does not depend on inherited environment state.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.STREAMER_TOOLS_MEDIA_ROOT ??= path.resolve(__dirname, '__fixtures__', 'media');
