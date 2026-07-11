# Agent Instructions

## Instruction hierarchy

Read and follow `CLAUDE.md` before working in this repository. It is the primary source for shared repository guidance, including architecture, workflow, code review, coding conventions, validation, configuration, and delivery expectations.

This file contains only additional instructions for non-Claude coding agents. Apply these instructions after `CLAUDE.md`. Treat them as additive unless they explicitly override a rule in `CLAUDE.md`; when an explicit conflict exists, this file controls agent-specific behavior. System, developer, and direct user instructions remain higher priority than either repository file.

Do not copy shared guidance from `CLAUDE.md` into this file. Update the shared rule at its source so the two documents do not drift.

## Repository discovery

- Verify paths and behavior against the current worktree; the architecture inventory in `CLAUDE.md` is a navigation aid, not proof of current behavior.
- Use `rg` and `rg --files` for repository searches when available.
- Inspect `git status --short` before editing. Preserve unrelated, user-owned changes in a dirty worktree.
- When reviewing or committing pending work, inspect `git diff --cached` whenever files are staged; a plain `git diff` does not show the staged commit payload.

## Editing

- Use patch-based edits for deliberate source and documentation changes. Use formatters only for mechanical rewrites when the repository provides one.
- Keep edits narrowly scoped to the requested outcome. Do not rewrite or normalize unrelated files.
- Preserve file encoding and Unicode content, then inspect the resulting diff for unintended changes.
- Never use destructive Git commands such as `git reset --hard` or `git checkout --` to discard work unless the user explicitly requests that exact operation.

## Browser validation

- For frontend validation, use the CachyOS system Chromium executable at `/usr/bin/chromium` with Chromium DevTools/CDP.
- Do not use Playwright or assume Google Chrome is installed.
- Launch Chromium in a normal visible window, not headless, so the user can observe the checks.
- Use Chromium DevTools for browser diagnostics and performance tracing.
- Perform browser validation only when it is relevant under the proportional verification guidance in `CLAUDE.md`.

## Validation and handoff

- Use Bun for dependency installation and repository scripts.
- Report which checks were run, which passed, and which relevant checks were skipped or blocked.
- Do not commit `.env`, SQLite runtime files, credentials, tokens, or private chat data.
- Before committing, inspect the final diff and run `git diff --check` in addition to the relevant validation from `CLAUDE.md`.
- Keep commits focused and use the semantic commit format documented in `CLAUDE.md`.
