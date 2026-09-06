// deepseek-tui app plugin: boots a fullscreen terminal UI inside a dsh profile
// and drives the in-process agent through the harness's own services — no
// child runtime. Types come from file: devDependencies on the sibling harness
// checkout; they stay type-only imports because the profile process resolves
// no harness modules at runtime.
import { render } from 'ink'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { TuiStartupService } from './startup.js'
import { App } from './app.js'
import type { HarnessServices } from './app.js'

export const name = 'deepseek-tui'

export const inject = ['agents', 'agentDefaultModel', 'commands', 'llm', 'sessionPersistence', 'sessionQuery', 'tuiStartup']

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
  // ctx.tuiStartup is guaranteed by the tui-startup row in this bundle; the
  // fallback only keeps a bare-ctx boot honest.
  const startup: TuiStartupService = ctx.tuiStartup ?? {}
  // Flag overrides for this run only: the composed agent-default-model
  // selection stays the base, and --model/--provider beat it field by field.
  // Seeding happens per open in the facade, so a settings hot-reload still
  // reaches sessions opened later in the same boot.
  const runSelection = (): ModelSelection => {
    const selection = ctx.agentDefaultModel.currentSelection()
    return {
      ...selection,
      ...startup.model !== undefined && { model: startup.model },
      ...startup.provider !== undefined && { provider: startup.provider },
    }
  }
  const services: HarnessServices = {
    // Entry points own model selection: read the composed default at creation.
    create: (options) => ctx.agents.create({
      ...options,
      agentOptions: options.agentOptions ?? runSelection(),
    }),
    resume: (id) => ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: runSelection(),
    }),
    list: () => ctx.sessionQuery.listSessions(),
    readTitles: (ids) => ctx.sessionQuery.readTitleSnapshots(ids),
    deleteSession: (id) => ctx.sessionPersistence.delete(id),
    // A flag-seeded selection must fail loud when the provider does not
    // advertise the model: the entry point validates its own flags. Catalog
    // membership is advisory, so an empty catalog (or a query failure) lets
    // the harness decide instead of blocking an unlisted-but-valid model.
    checkModelSelection: async () => {
      if (startup.model === undefined && startup.provider === undefined) return null
      const selection = runSelection()
      try {
        const models = await ctx.llm.listModels(selection.provider)
        if (models.length === 0) return null
        if (models.some((model) => model.id === selection.model)) return null
        return `model "${selection.model}" is not offered by provider "${selection.provider}"`
      } catch (error) {
        return `model selection unusable: ${error instanceof Error ? error.message : String(error)}`
      }
    },
    // Slash commands resolve per agent (scoped shadowing) and run through the
    // harness registry — this UI never keeps a parallel command list.
    listCommands: (agent) => ctx.commands.list(agent),
    executeCommand: (agent, line, signal) => ctx.commands.execute(agent, line, [], signal),
    on: (event, listener) => {
      const dispose = ctx.on(event, listener)
      return () => {
        dispose()
      }
    },
    // Answering approvals makes this plugin the profile's interactive
    // answerer; the harness fails closed ('unavailable') without one.
    onApproval: (listener) => ctx.on('approval/request', listener),
  }
  const instance = render(<App services={services} startup={startup} onDone={exitProcess} />)
  // Exit funnels through App's onDone: its unmount cleanup awaits the agent
  // handle's dispose (a durable session-log close) before process exit.
  void instance.waitUntilExit()
}
