# Repository Guidelines

## Project Structure & Module Organization

This is a Bun-powered Vite + React + TypeScript app with a small backend.

- `src/client/` contains the React UI for `/dashboard`, `/tablet`, and `/overlay`.
- `src/client/styles.css` holds global UI and overlay styling.
- `src/server/` contains the Bun/Express backend split by responsibility: HTTP entrypoint/routes, config, SQLite, realtime WebSocket broadcast, Twitch chat, emotes, OBS, music, and sounds.
- `src/server/types/` contains local declarations for packages without complete TypeScript types.
- `src/shared/` contains TypeScript interfaces shared by the client and server.
- `data/` stores runtime SQLite files; only `data/.gitkeep` should be committed.

There is no dedicated test directory yet.

## Build, Test, and Development Commands

Use Bun for dependency and script execution.

```sh
bun install
bun run dev
bun run typecheck
bun run build
```

- `bun run dev` starts the backend on `4317` and Vite on `5173`.
- `bun run typecheck` runs `tsc --noEmit`.
- `bun run build` typechecks and creates the production Vite build in `dist/`.

## Coding Style & Naming Conventions

Use TypeScript with strict types. Prefer explicit domain types like `ChatMessage` and `StreamGoal` near the code that owns them. Keep React components in PascalCase and hooks in `useCamelCase`. Use camelCase for variables, functions, and JSON API fields.

CSS uses class selectors in camelCase, for example `.chatPanel` and `.overlayFrame`. Keep overlay styles browser-source friendly: transparent page background, fixed-position regions, and no app chrome.

No formatter or linter is configured yet; match the existing two-space JSON indentation and concise TypeScript style.

## Testing Guidelines

This project intentionally does not have unit tests right now. For changes, run:

```sh
bun run typecheck
bun run build
```

For backend or integration work, also smoke test the relevant endpoints, for example:

```sh
curl http://localhost:4317/api/health
curl http://localhost:4317/api/chat/recent
curl http://localhost:4317/api/music/current
```

## Commit & Pull Request Guidelines

Use semantic commit messages, for example `feat: add chat command replies` or `docs: update agent instructions`. Keep commits focused and avoid mixing unrelated UI, backend, and config changes.

As part of tidy-up before handing work back, commit completed changes unless the user explicitly asks not to commit or the work is intentionally left in progress.

Pull requests should include a short summary, verification commands run, and screenshots for visible dashboard/tablet/overlay changes. Mention any required `.env` or OBS/Twitch setup changes.

## Security & Configuration Tips

Do not commit `.env` or SQLite runtime files. Use `.env.example` for documented defaults. OBS credentials should stay local. Chat history can contain moderated content, so treat `data/streamer-tools.sqlite` as private runtime data.
