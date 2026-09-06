// The TUI's command-line provider: a small plugin row (patch id `tui-startup`,
// module `deepseek-tui/startup`) that parses the profile's app arguments —
// what the dsh launcher hands past its own flags — into the immutable
// `tuiStartup` service. Mirrors the harness's web-startup provider shape:
// inject `cmdlineArgs` (launcher-provided host values, types via the
// dsh-cmdline devDep), then publish parsed values or print and request exit.
// `--help` and parse errors are terminal: nothing is provided, so the app row
// below never activates and the exit request ends the process.
//
// The parse itself is a plain scanner, not commander: this package's profile
// process resolves no harness modules at runtime, so dsh-cmdline's commander
// adapter is out of reach; the flag family is four options, small enough to
// own. Semantics mirror commander's where they are observable: `--help`
// anywhere wins, `--flag value` and `--flag=value` both parse, a value option
// consumes the next token even when it looks like a flag, later values win,
// and unknown flags or stray positionals are usage errors.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name for the patch row. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by the app row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the app reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupService {
  /** Session to resume on boot; absent means a fresh session. */
  readonly resume?: SessionId
  /** `--model`, seeding sessions opened this run. */
  readonly model?: string
  /** `--provider`, seeding sessions opened this run. */
  readonly provider?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Parsed invocation values; provided by tui-startup only on a clean parse. */
    tuiStartup?: TuiStartupService
  }
}

/** The flag family's value-bearing options, with the display names errors use. */
const VALUE_OPTIONS: readonly { readonly names: readonly string[]; readonly label: string; readonly key: 'resume' | 'model' | 'provider' }[] = [
  { names: ['--resume', '--session'], label: '--resume <sessionId>', key: 'resume' },
  { names: ['--model'], label: '--model <model>', key: 'model' },
  { names: ['--provider'], label: '--provider <provider>', key: 'provider' },
]

/** Parse outcome: help and errors are terminal for the process. */
export type StartupParseOutcome =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'values'; readonly values: TuiStartupService }

/** The empty values an invocation with no app arguments parses to. */
export const EMPTY_STARTUP: TuiStartupService = Object.freeze({})

const separatorIndex = (token: string): number => token.indexOf('=')

/**
 * Parse the profile's app arguments into the startup service.
 * @param args - the launcher's inner arguments, in argv order.
 * @returns help (print and exit 0), an error (print and exit 1), or the values.
 */
export function parseStartupArgs(args: readonly string[]): StartupParseOutcome {
  const raw: { resume?: string; model?: string; provider?: string } = {}
  let i = 0
  while (i < args.length) {
    const token = args[i] ?? ''
    if (token === '--') {
      const extra = args[i + 1]
      if (extra !== undefined) return errorOutcome(`unexpected argument '${extra}'`)
      break
    }
    if (token === '-h' || token === '--help') return { kind: 'help' }
    const option = VALUE_OPTIONS.find((candidate) => candidate.names.includes(token))
    if (option !== undefined) {
      const value = args[i + 1]
      if (value === undefined) return errorOutcome(`option '${option.label}' argument missing`)
      if (value === '') return errorOutcome(`option '${option.label}' argument must not be empty`)
      raw[option.key] = value
      i += 2
      continue
    }
    const equals = separatorIndex(token)
    const inlineName = equals > 0 ? token.slice(0, equals) : undefined
    const inlineOption = inlineName === undefined
      ? undefined
      : VALUE_OPTIONS.find((candidate) => candidate.names.includes(inlineName))
    if (inlineOption !== undefined) {
      const value = token.slice(equals + 1)
      if (value === '') return errorOutcome(`option '${inlineOption.label}' argument must not be empty`)
      raw[inlineOption.key] = value
      i += 1
      continue
    }
    if (token.startsWith('-')) {
      const name = equals > 0 ? token.slice(0, equals) : token
      return errorOutcome(`unknown option '${name}'`)
    }
    return errorOutcome(`unexpected argument '${token}'`)
  }
  const values: TuiStartupService = {
    ...raw.resume === undefined ? {} : { resume: raw.resume as SessionId },
    ...raw.model === undefined ? {} : { model: raw.model },
    ...raw.provider === undefined ? {} : { provider: raw.provider },
  }
  return { kind: 'values', values: Object.freeze(values) }
}

function errorOutcome(message: string): StartupParseOutcome {
  return { kind: 'error', message }
}

/** Help text printed for `--help`/`-h` and echoed at the tail of usage errors. */
export const HELP_TEXT = `Usage: dsh --profile tui [options]

An opencode-style terminal chat booting inside a DeepSeek Harness profile.

Options:
  -h, --help                 display help for command
  --resume <sessionId>       resume an existing session by id
  --session <sessionId>      alias of --resume
  --model <model>            run this invocation's sessions on this model
  --provider <provider>      run this invocation's sessions on this provider route

Examples:
  dsh --profile tui                                  start a fresh session here
  dsh --profile tui --resume a2ab797b-d282-4ddd-ae11-7feec253de57
  dsh --profile tui --model deepseek-v4-pro --provider deepseek-official
`

const USAGE_HINT = `Run 'dsh --profile tui --help' for usage.`

/** Print help or a usage error, then request the bounded launcher exit. */
function requestExit(ctx: Context, code: number): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-startup: the launcher must provide ctx.appExit before the tree mounts')
  }
  exit(code)
}

/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. A clean
 * parse — including no flags at all — provides the frozen values; `--help`
 * prints {@link HELP_TEXT} and requests exit 0, and a rejected invocation
 * prints its error and requests exit 1, providing nothing in both cases.
 * @param ctx - plugin context carrying the launcher's command line.
 */
export function apply(ctx: Context): void {
  const args = ctx.get('cmdlineArgs')?.get() ?? []
  if (args.length === 0) {
    ctx.provide(TUI_STARTUP_SERVICE, EMPTY_STARTUP)
    return
  }
  const outcome = parseStartupArgs(args)
  if (outcome.kind === 'help') {
    process.stdout.write(HELP_TEXT)
    requestExit(ctx, 0)
    return
  }
  if (outcome.kind === 'error') {
    process.stderr.write(`error: ${outcome.message}\n\n${USAGE_HINT}\n`)
    requestExit(ctx, 1)
    return
  }
  ctx.provide(TUI_STARTUP_SERVICE, outcome.values)
}
