# Quotes

## Goal

A quote book: text, submitter, added-at, and a shown counter. Viewers call a quote by
number (`!quote 1`) or keyword/slug (`!quote farts`), and the Discord bot announces it
as `Quote 3: I'm hungry for pizza!`. Submitting and calling are both built out of
Actions, so cooldowns, roles, dedup, and the module system apply for free.

## Why steps, not a hard-coded command

`chat.ts` must not grow another `!command` branch (CLAUDE.md: a hard-coded command
bypasses cooldowns, roles, and dedup and is invisible to the operator). So quotes ship
as two new **Action step types** and the operator wires the commands themselves.

Steps run concurrently and cannot pass values to one another (`Promise.all` in
`actionExecutor.ts`), so a `quote_show` step cannot hand a quote to a downstream
`send_chat`/Discord step. Each quote step therefore resolves the quote AND emits the
message itself — mirroring `llm_response`, which already pipes its own output to chat.

Nothing is seeded. A seeded `!quote` would need a Discord channel id nobody has
configured yet, so it would ship broken; the operator builds it in Settings → Actions.

## Data

```sql
quotes(id text pk, number integer not null unique, slug text, text text not null,
       submitted_by text not null, submitted_by_login text not null default '',
       created_at text not null, shown_count integer not null default 0,
       last_shown_at text)
quote_sequence(id integer pk check (id = 1), next_number integer not null)
```

`number` comes from `quote_sequence`, not `max(number)+1`, so deleting the newest quote
never lets the next one reuse its number — a quote number is quoted in Discord history
forever and must not come to mean something else. Partial unique index on `slug` where
non-null; empty slug normalizes to null so many quotes can be slug-less.

## Lookup (`resolveQuote`)

1. empty query → random quote
2. all digits → by `number`, exact
3. exact `slug`, case-insensitive
4. substring match against text or slug → random among matches
5. otherwise null → the step is `skipped`, not `failed`

## Step types

- `quote_add`  — `{ textTemplate, slugTemplate, replyTemplate }`
- `quote_show` — `{ queryTemplate, messageTemplate }`

Both announce to **Twitch chat only**, through the same `sendChat` seam every other
step uses. An earlier revision carried a `destination` of `discord | chat` and a
channel id; that was cut — Narya's quote commands are Twitch-side, and requiring a
Discord channel made a freshly added step invalid until one was pasted in.

The message template renders against the invocation context **extended with quote
tokens** — `{quoteNumber} {quoteText} {quoteSlug} {quoteSubmitter} {quoteShownCount}
{quoteDate}` — added to `TemplateContext`, `resolveToken`, and `isKnownToken`.

`shown_count` increments only after the message is delivered, so a failed Discord send
does not inflate the counter.

## Surfaces

- `src/server/quotes.ts` — repo + `GET/POST/PATCH/DELETE /api/quotes`
- Settings → Quotes (`/settings/quotes`, studio group) — list, add, edit slug/text, delete

## Verification

`bun test` (new `src/server/quotes.test.ts` covering number allocation, no-reuse,
lookup precedence, counter timing), `bun run typecheck`, `bun run build`, and a live
run of both steps against a scratch DB.
