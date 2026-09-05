# AGENTS.md

deepseek-tui is an opencode-like interactive terminal UI that boots *inside* a DeepSeek Harness profile as an in-process Cordis plugin bundle — the same shape as `dsh-oc-tui`/`dsh-tui`. The harness (sibling repo `../deepseek-harness`) owns the agent loop, sessions, tools, and provider access; this package is a terminal frontend that opens sessions, sends followups, and renders the session events it receives over the harness's own event bus. Repo work here is mostly delegated to sub agents; this file is the shared contract they follow.

## How this app plugs into the harness

- This package is a **profile bundle**: `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; `cordis.patch.yml` inserts the app plugin into the profile tree on top of `@deepseek-ai/dsh-base`. A profile (`~/.dsh/profiles/<name>`) lists `@deepseek-ai/dsh-base` and this package in `dsh.profile.bundles` and resolves it from its own `node_modules` (`file:` dependency during development, registry/git when released).
- The plugin runs in the same process as the harness and drives it through the ctx services it declares in `inject` (`agents`, `agentDefaultModel`, `sessionQuery` today; add `sessionPersistence`, `commands`, `approval`, … as features land). It never spawns a child runtime and never reads `DEEPSEEK_API_KEY` — provider access is the harness's own.
- Events arrive on the ctx event bus: `ctx.on('session/event', …)`, `ctx.on('agent/status', …)`, `ctx.on('approval/request', …)`. Render only what these events say — never guess agent state.
- Service APIs are pre-stable. Types come from `file:` devDependencies on the sibling harness checkout (its built `lib/` carries `types`); `pnpm-workspace.yaml` rewrites those packages' internal `workspace:^` deps to the same checkout so `pnpm install` resolves outside the harness workspace. Keep every `@deepseek-ai/*` import type-only: the profile process resolves no harness modules at runtime, so a runtime value import breaks boot.
- Every exit path must dispose the agent handle and unsubscribe `ctx.on` listeners; exiting the UI exits the profile process (`process.exit(0)`), so no orphaned runtime is possible.

## Repository layout

```
cordis.patch.yml      bundle patch rows (plugin id/name) applied over the base layer
src/index.tsx         plugin entry: alt-screen setup/restore, Ink render, exit funnel
src/app.tsx           app controller: session lifecycle, event subscriptions, key dispatch
src/projection.ts     pure session-event/stream-frame → turn view model fold
src/sessions.ts       pure sidebar list model: entries, selection, confirm policy
src/ui.tsx            dumb view components (header, sidebar, transcript, footer, composer)
src/theme.ts          typed color/border tokens; the only source of styling literals
src/keys.ts           KEYBINDINGS table + matchKey; the single source for key handling
src/scroll.ts         pure layout math (scroll window, composer/viewport sizing, wrap)
src/projection.test.ts vitest spec for the event → view projection
src/sessions.test.ts  vitest spec for the sidebar list model
src/shell.test.ts     vitest spec for the key table and layout math
```

## Commands

```sh
pnpm install            # node >=22, pnpm; esbuild build approved via allowBuilds in pnpm-workspace.yaml
pnpm typecheck          # tsc --noEmit
pnpm build              # tsc emit to lib/ (lib/index.js + lib/index.d.ts)
pnpm test               # vitest run (pure key/layout logic only)
pnpm clean              # remove lib/ and *.tsbuildinfo
```

There is no standalone dev entry — run the plugin through a profile:

```sh
pnpm --dir ~/Projects/deepseek/deepseek-harness dsh --profile tui   # boot the tui profile (dev, from source)
```

## Conventions

- TypeScript `strict: true`, ESM (`"type": "module"`), NodeNext resolution, `react-jsx`, no `any` without a stated reason. Node `>=22`. Source file is `.tsx` because it embeds Ink JSX.
- Keyboard-first: every command must have a key binding; mouse is never required. Keep bindings documented in one visible place (help pane/screen), not scattered.
- Keep rendering dumb: components render state; all state transitions come from key handlers or harness events. No I/O (child process, files, network) inside render or effects without an explicit owner module that is the only place that I/O happens.
- Ink's `render()` is the only place stdin raw mode is entered; components must clean up input subscriptions on unmount. On app exit, restore the terminal and dispose the agent handle.
- Tests describe behavior, not implementation. When there is logic to test (input mapping, event → view state projection), add the smallest vitest spec that fails if the logic breaks; do not test components that only render.
- Never commit credentials or API keys. `.env` is git-ignored.
- Commits follow [CONTRIBUTING.md](CONTRIBUTING.md)'s Commit Message Conventions.
- Files end with exactly one trailing newline. TODO/FIXME markers by urgency only.
- Keep comments local and concrete; do not restate code. Prefer the harness's own naming for concepts (session, turn, event, followup) over parallel vocabulary.
