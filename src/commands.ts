// Pure slash-command layer: TUI-local command entries, the merged palette
// roster (harness `ctx.commands` descriptors + locals), fresh-position
// detection, and palette filtering/arming. No React, no ctx — the controller
// runs the merged rows through the harness `execute` service or its own local
// dispatch, and the help overlay reads the same roster the palette shows.
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

/** One palette/help row; `source` says who executes it. */
export interface PaletteCommand {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  readonly description: string
  /** Free-form argument hint the command advertises (e.g. `[off|message]`). */
  readonly usage?: string
  readonly source: 'harness' | 'local'
  /** Local dispatch id; harness rows never carry one. */
  readonly id?: string
  /** Extra names the palette matches this row by (TUI-local only). */
  readonly aliases?: readonly string[]
}

/** TUI-local commands: UI-level actions with no harness equivalent. */
export const LOCAL_COMMANDS: readonly PaletteCommand[] = [
  {
    name: 'help',
    description: 'Show keybindings and slash commands',
    aliases: ['keybindings'],
    source: 'local',
    id: 'help',
  },
  {
    name: 'sessions',
    description: 'Open the session sidebar',
    source: 'local',
    id: 'sessions',
  },
]

/**
 * Merge harness descriptors with the local roster for one agent, sorted by
 * name. A harness command always wins a name collision: locals never shadow
 * real commands a profile composes later.
 */
export function mergeCommands(harness: readonly CommandDescriptor[]): readonly PaletteCommand[] {
  const harnessNames = new Set(harness.map((command) => command.name))
  const rows: PaletteCommand[] = []
  for (const command of harness) {
    rows.push({
      name: command.name,
      description: command.description,
      ...command.input !== undefined ? { usage: command.input.hint } : {},
      source: 'harness',
    })
  }
  for (const local of LOCAL_COMMANDS) {
    if (harnessNames.has(local.name)) continue
    rows.push(local)
  }
  return [...rows].sort((left, right) => left.name < right.name ? -1 : 1)
}

/** True when typing at the end of `input` starts a fresh word. */
export function isFreshPosition(input: string): boolean {
  return input === '' || /\s$/.test(input)
}

/**
 * One command armed by an exact full name: the query's first token is a real
 * command name, and whatever follows the space is its argument text.
 */
export interface ArmedCommand {
  readonly command: PaletteCommand
  readonly args: string
}

const TOKEN = /^([a-z][a-z0-9_-]*)[ \t]*([\s\S]*)$/iu

/**
 * Resolve an exact-name command from the typed needle (query without the
 * leading slash). Matches names and aliases so `/keybindings` arms `/help`.
 * @returns the armed command, or null when no name in the query resolves.
 */
export function armCommand(commands: readonly PaletteCommand[], needle: string): ArmedCommand | null {
  const token = TOKEN.exec(needle)
  if (token === null) return null
  const name = token[1]?.toLowerCase() ?? ''
  const args = token[2] ?? ''
  const command = commands.find((row) => row.name === name || row.aliases?.includes(name))
  return command === undefined ? null : { command, args }
}

/**
 * Palette filtering: an exact armed name shows only that row (arguments keep
 * typing against it); otherwise names and aliases match by lowercase
 * subsequence, so `pln` and `keyb` narrow the roster the way fuzzy pickers
 * do. A space is an ordinary filter character once no name is armed.
 */
export function filterCommands(commands: readonly PaletteCommand[], needle: string): readonly PaletteCommand[] {
  const armed = armCommand(commands, needle)
  if (armed !== null) return [armed.command]
  const query = needle.toLowerCase()
  const matches: PaletteCommand[] = []
  for (const command of commands) {
    const candidates = [command.name, ...(command.aliases ?? [])]
    if (candidates.some((candidate) => isSubsequence(query, candidate.toLowerCase()))) matches.push(command)
  }
  return matches
}

/** Whether every query character appears in order inside the candidate. */
function isSubsequence(query: string, candidate: string): boolean {
  if (query === '') return true
  let index = 0
  for (const char of candidate) {
    if (char === query[index]) {
      index += 1
      if (index === query.length) return true
    }
  }
  return false
}

/** One row Enter resolves to, with the argument text it dispatches. */
export interface PalettePick {
  readonly command: PaletteCommand
  readonly args: string
}

/**
 * What Enter runs for a query and selection: an exact armed name always wins
 * (arguments included); otherwise the highlighted fuzzy row. A bare `/` with
 * nothing picked resolves to nothing — the roster's first row can be a
 * session-mutating harness command, so Enter must not run it by accident.
 * @returns the pick, or undefined when Enter should just close the palette.
 */
export function palettePick(
  commands: readonly PaletteCommand[],
  needle: string,
  index: number,
): PalettePick | undefined {
  const armed = armCommand(commands, needle)
  if (armed !== null) return armed
  if (needle === '' && index === 0) return undefined
  const matches = filterCommands(commands, needle)
  const row = matches[Math.min(index, matches.length - 1)]
  return row === undefined ? undefined : { command: row, args: '' }
}

/** The full slash line an armed command dispatches: `/name` plus args. */
export function commandLine(name: string, args: string): string {
  return args === '' ? `/${name}` : `/${name} ${args}`
}
