# Narya — how to build with this design system

Narya is the cockpit UI for a Twitch streaming control panel: a dark, dense,
"starfield and gold" aesthetic. Components are React, exposed on
`window.Narya`. Import them by name.

## 1. Wrap everything in `.cockpit` — this is not optional

`body` has **no background** in Narya. The navy surface, the ivory foreground
colour, and the body font all come from the `.cockpit` class. A screen that
skips it renders near-invisible dark-on-white text.

```jsx
<div className="cockpit">
  {/* every Narya screen starts here */}
</div>
```

`.cockpit` sets `background: var(--bg-1)` (plus an arcane radial wash),
`color: var(--fg-1)`, and `font-family: var(--font-body)`. It expects to own its
height — `height: 100%` on a full screen, or an explicit height when embedded.

Two components need extra setup:

- **`ToastProvider`** — only if you use toasts. Wrap the app in it and call
  `useToast()` (also exported from the bundle) to get `pushToast`. Toasts render
  in a `position: fixed` stack pinned to the **top-right of the viewport**, not
  to their parent — leave that corner clear.
- **`PopWindow`** — `position: absolute`; it needs a `position: relative`
  ancestor to anchor against.

Besides the 19 components, the bundle also exports `useToast`, `useDrag`,
`MODULES`, `belongsToCurrentSession`, `mergeRecentChatters`, and
`sessionBoundaryIndex`.

## 2. The styling idiom: components + CSS variables. There is no utility system.

Narya has **no utility classes** — no `bg-*`, `p-*`, `flex-*` vocabulary. Do not
invent one, and do not reach for Tailwind. Two rules cover everything:

1. **Use the exported components** for anything they cover — panels, bars, chat,
   rosters. Their class names (`.panel`, `.navbar`, `.statbar`, `.icon-btn`,
   `.btn-primary`) are internal; you apply them by rendering the component, not
   by hand-writing markup.
2. **For your own layout glue, use `var(--*)` tokens** in inline styles or your
   own CSS. Every value you need already has a token:

| Family | Real names |
|---|---|
| Surface | `--bg-1` `--bg-2` `--bg-3` `--bg-void` `--bg-inverse` |
| Foreground | `--fg-1` `--fg-2` `--fg-3` `--fg-accent` `--fg-arcane` `--fg-inverse` |
| Border | `--border-1` `--border-2` `--border-3` |
| Brand scales | `--navy-950…500` `--ivory-50…300` `--silver-300…600` `--gold-300…700` `--arcane-400…700` |
| Status | `--success-*` `--warning-*` `--danger-*` `--info-*` `--note-*` (each `-base/-fg/-bg/-border`) |
| Type | `--font-logo` `--font-display` `--font-body` `--font-mono` |
| Scale | `--step--2` … `--step-7`, `--lh-tight/snug/body/loose`, `--track-tight/normal/wide/caps` |
| Space | `--space-1` … `--space-10` |
| Radius | `--radius-0/1/2/3/pill` |
| Shadow / glow | `--shadow-1/2/3` `--shadow-inner` `--glow-gold` `--glow-arcane` `--glow-silver` |
| Motion | `--ease-out` `--ease-in-out` `--ease-stars` `--dur-fast/base/slow/drift` |

There is also an accent trio defined alongside the components:
`--accent` (= `--gold-500`), `--accent-fg` (= `--gold-400`), and
`--accent-soft` (a 12% gold wash used for active-state backgrounds).
`--fg-accent` and `--accent-fg` both exist and are both gold — the first is the
semantic foreground token, the second the component-level accent.

Gotcha: **`--warning` (bare) is not a token.** The warning family is
`--warning-base` / `--warning-fg` / `--warning-bg` / `--warning-border`.
Tokens named `--orb`, `--reward-color`, `--overlay-text-accent`, `--clip-aspect`
and `--clip-width-from-height` are set from JS at runtime — don't author against
them.

House idiom worth matching: section headers and chips are uppercase, small, and
letter-spaced (`--font-mono` or `--font-display` + `--track-caps`); gold
(`--fg-accent`) marks the active or primary thing and is used sparingly.

## 3. Where the truth lives

- **Styling** — `_ds/<folder>/styles.css` and the files it `@import`s
  (`tokens/styles/tokens.css` is the full token table). Read them before
  inventing a value.
- **Per component** — `<Name>.d.ts` is the prop contract, `<Name>.prompt.md` is
  the usage reference. Read these rather than guessing props.
- Note that `_ds_bundle.css` is not the whole story: a few components
  (`TweaksPanel`, `TweakSection`) inject their own CSS from JS, so their classes
  do not appear in any stylesheet.

## 4. An idiomatic screen

```jsx
const { Panel, Chat, StatBar } = window.Narya;

<div className="cockpit" style={{ height: '100%' }}>
  <StatBar {...status} />
  <div style={{
    display: 'grid',
    gridTemplateColumns: '1fr 320px',
    gap: 'var(--space-4)',
    padding: 'var(--space-4)',
  }}>
    <Panel id="chat" title="Chat" popped={false} onPop={() => {}} count={128}>
      <Chat ctx={ctx} />
    </Panel>
    <aside style={{
      background: 'var(--bg-2)',
      border: '1px solid var(--border-1)',
      borderRadius: 'var(--radius-3)',
      padding: 'var(--space-4)',
      color: 'var(--fg-2)',
      fontSize: 'var(--step--1)',
    }}>
      Your own panel — tokens for the glue, components for the chrome.
    </aside>
  </div>
</div>
```
