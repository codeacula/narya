// Test preload (see bunfig.toml). Runs before any test module is imported, so
// db.ts sees an in-memory path and never opens the operator's real database.
// db.ts also defaults to :memory: under NODE_ENV=test; this is a second layer of
// protection because clobbering live config is a costly, silent failure.
process.env.STREAMER_TOOLS_DB ??= ':memory:';
