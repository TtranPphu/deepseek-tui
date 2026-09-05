# AGENTS.md

deepseek-tui is an opencode-like interactive terminal UI that boots *inside* a DeepSeek Harness profile as an in-process Cordis plugin bundle — the same shape as `dsh-oc-tui`/`dsh-tui`. The harness (sibling repo `../deepseek-harness`) owns the agent loop, sessions, tools, and provider access; this package is a terminal frontend that opens sessions, sends followups, and renders the session events it receives over the harness's own event bus. Repo work here is mostly delegated to sub agents; this file is the shared contract they follow.

## How this app plugs into the harness

- This package is a **profile bundle**: `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; `cordis.patch.yml` inserts the app plugin into the profile tree on top of `@deepseek-ai/dsh-base`. A profile (`~/.dsh/profiles/<name>`) lists `@deepseek-ai/dsh-base` and this package in `dsh.profile.bundles` and resolves it from its own `node_modules` (`file:` dependency during development, registry/git when released).
- The plugin runs in the same process as the harness and drives it through the ctx services it declares in `inject` (`agents` today; add `sessionPersistence`, `commands`, `approval`, … as features land). It never spawns a child runtime and never reads `DEEPSEEK_API_KEY` — provider access is the harness's own.
- Events arrive on the ctx event bus: `ctx.on('session/event', …)`, `ctx.on('agent/status', …)`, `ctx.on('approval/request', …)`. Render only what these events say — never guess agent state.
- Service APIs are pre-stable. `src/index.tsx` carries small structural mirrors of the service surface with a `ponytail:` comment; replace them with devDependency types from the sibling harness checkout (`file:../deepseek-harness/packages/…`, built `lib/` carries `types`) once the renderer needs the real event types.
- Every exit path must dispose the agent handle and unsubscribe `ctx.on` listeners; exiting the UI exits the profile process (`process.exit(0)`), so no orphaned runtime is possible.

## Repository layout

```
cordis.patch.yml   bundle patch rows (plugin id/name) applied over the base layer
src/index.tsx      the app plugin: name/inject/apply exports, Ink chat UI
```

## Commands

```sh
pnpm install            # node >=22, pnpm; esbuild build approved via allowBuilds in pnpm-workspace.yaml
pnpm typecheck          # tsc --noEmit
pnpm build              # tsc emit to lib/ (lib/index.js + lib/index.d.ts)
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
