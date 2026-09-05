// deepseek-tui app plugin: boots a fullscreen terminal UI inside a dsh profile
// and drives the in-process agent through the harness's own services — no
// child runtime. Types come from file: devDependencies on the sibling harness
// checkout; they stay type-only imports because the profile process resolves
// no harness modules at runtime.
import { render } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-query'
import { App } from './app.js'
import type { HarnessServices } from './app.js'

export const name = 'deepseek-tui'

export const inject = ['agents', 'agentDefaultModel', 'sessionQuery']

let exited = false
function exitProcess(): void {
  if (exited) return
  exited = true
  process.exit(0)
}

export function apply(ctx: Context): void {
  const stdout = process.stdout
  const isTty = stdout.isTTY === true
  if (isTty) stdout.write('\x1b[?1049h\x1b[?25l')
  let restored = false
  const restore = (): void => {
    if (restored || !isTty) return
    restored = true
    stdout.write('\x1b[?25h\x1b[?1049l')
  }
  process.on('exit', restore)
  ctx.effect(() => () => {
    process.off('exit', restore)
    restore()
  }, 'deepseek-tui.restoreTerminal()')
  const services: HarnessServices = {
    // Entry points own model selection: read the composed default at creation.
    create: (options) => ctx.agents.create({
      ...options,
      agentOptions: options.agentOptions ?? ctx.agentDefaultModel.currentSelection(),
    }),
    resume: (id) => ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: ctx.agentDefaultModel.currentSelection(),
    }),
    list: () => ctx.sessionQuery.listSessions(),
    readTitles: (ids) => ctx.sessionQuery.readTitleSnapshots(ids),
    // ponytail: the harness ships no session-deletion surface
    // (sessionPersistence exposes create/open/flush/stat/list only); the
    // delete-confirm flow stays wired and reports the gap until it lands.
    deleteSession: () => Promise.reject(new Error('the harness exposes no session deletion surface')),
    on: (event, listener) => {
      const dispose = ctx.on(event, listener)
      return () => {
        dispose()
      }
    },
  }
  const instance = render(<App services={services} onDone={exitProcess} />)
  // Exit funnels through App's onDone: its unmount cleanup awaits the agent
  // handle's dispose (a durable session-log close) before process exit.
  void instance.waitUntilExit()
}
