import { describe, expect, it } from 'vitest'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import {
  armCommand,
  commandLine,
  filterCommands,
  isFreshPosition,
  LOCAL_COMMANDS,
  mergeCommands,
  palettePick,
} from './commands.js'

const HARNESS: readonly CommandDescriptor[] = [
  { name: 'compact', description: 'Compact older conversation history' },
  { name: 'feedback', description: 'record feedback about this session', input: { hint: '<text>' } },
  { name: 'goal', description: 'set or view the goal for a long-running task' },
  { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
  // A future harness /help must shadow the local one, never coexist.
  ...[] as readonly CommandDescriptor[],
]

function harnessWithHelp(): readonly CommandDescriptor[] {
  return [{ name: 'help', description: 'harness-owned help' }, ...HARNESS]
}

describe('mergeCommands', () => {
  it('merges harness and local rows sorted by name', () => {
    const rows = mergeCommands(HARNESS)
    expect(rows.map((row) => row.name)).toEqual(['compact', 'feedback', 'goal', 'help', 'plan', 'sessions'])
    expect(rows.filter((row) => row.source === 'local')).toHaveLength(2)
    expect(rows.find((row) => row.name === 'goal')).toMatchObject({ source: 'harness' })
    expect(rows.find((row) => row.name === 'goal')).not.toHaveProperty('usage')
    expect(rows.find((row) => row.name === 'feedback')).toMatchObject({ source: 'harness', usage: '<text>' })
    expect(rows.find((row) => row.name === 'plan')).toMatchObject({ source: 'harness', usage: '[off|message]' })
  })

  it('keeps locals out of an empty profile instead of inventing harness rows', () => {
    const rows = mergeCommands([])
    expect(rows.map((row) => row.name)).toEqual(['help', 'sessions'])
    expect(rows).toEqual(LOCAL_COMMANDS.map((row) => ({ ...row })))
  })

  it('lets a harness command shadow a same-named local', () => {
    const rows = mergeCommands(harnessWithHelp())
    expect(rows.filter((row) => row.name === 'help')).toEqual([
      { name: 'help', description: 'harness-owned help', source: 'harness' },
    ])
  })
})

describe('isFreshPosition', () => {
  it('treats the start and post-whitespace as fresh input positions', () => {
    expect(isFreshPosition('')).toBe(true)
    expect(isFreshPosition('hello ')).toBe(true)
    expect(isFreshPosition('hello\t')).toBe(true)
    expect(isFreshPosition('one\ntwo\n')).toBe(true)
    expect(isFreshPosition('hello')).toBe(false)
    expect(isFreshPosition('h')).toBe(false)
  })
})

describe('armCommand', () => {
  const rows = mergeCommands(HARNESS)

  it('arms an exact name with no arguments', () => {
    expect(armCommand(rows, 'plan')).toEqual({ command: rows[4], args: '' })
  })

  it('arms arguments after the exact name', () => {
    expect(armCommand(rows, 'plan off')).toEqual({ command: rows[4], args: 'off' })
    expect(armCommand(rows, 'goal clear the board')).toEqual({ command: rows[2], args: 'clear the board' })
  })

  it('resolves local aliases', () => {
    expect(armCommand(rows, 'keybindings')).toEqual({ command: rows[3], args: '' })
  })

  it('matches names case-insensitively without lowercasing arguments', () => {
    expect(armCommand(rows, 'PLAN OFF')).toEqual({ command: rows[4], args: 'OFF' })
  })

  it('refuses partial names and unknown words', () => {
    expect(armCommand(rows, 'pla')).toBeNull()
    expect(armCommand(rows, 'compactnow')).toBeNull()
    expect(armCommand(rows, 'nope')).toBeNull()
  })
})

describe('filterCommands', () => {
  const rows = mergeCommands(HARNESS)

  it('shows exactly the armed row while arguments are typed', () => {
    expect(filterCommands(rows, 'plan off')).toEqual([rows[4]])
    expect(filterCommands(rows, 'goal clear')).toEqual([rows[2]])
  })

  it('fuzzy-matches names by subsequence', () => {
    expect(filterCommands(rows, 'pln').map((row) => row.name)).toEqual(['plan'])
    expect(filterCommands(rows, 'feedback').map((row) => row.name)).toEqual(['feedback'])
    expect(filterCommands(rows, 'sess').map((row) => row.name)).toEqual(['sessions'])
  })

  it('matches aliases and ignores case', () => {
    expect(filterCommands(rows, 'KEYB').map((row) => row.name)).toEqual(['help'])
    expect(filterCommands(rows, 'Keybindings').map((row) => row.name)).toEqual(['help'])
  })

  it('returns nothing for unmatched queries and spaces after partial names', () => {
    expect(filterCommands(rows, 'zzz')).toEqual([])
    expect(filterCommands(rows, 'pla ')).toEqual([])
    expect(filterCommands(rows, 'pl o')).toEqual([])
  })

  it('keeps the roster order in matches', () => {
    const names = filterCommands(rows, '').map((row) => row.name)
    expect(names).toEqual(['compact', 'feedback', 'goal', 'help', 'plan', 'sessions'])
  })
})

describe('palettePick', () => {
  const rows = mergeCommands(HARNESS)

  it('runs the armed exact name with its arguments', () => {
    expect(palettePick(rows, 'plan off', 0)).toEqual({ command: rows[4], args: 'off' })
  })

  it('runs the highlighted fuzzy row once something is typed', () => {
    expect(palettePick(rows, 'com', 0)).toEqual({ command: rows[0], args: '' })
    expect(palettePick(rows, 'pln', 0)).toEqual({ command: rows[4], args: '' })
  })

  it('runs the picked row after an explicit arrow move on a bare slash', () => {
    expect(palettePick(rows, '', 1)).toEqual({ command: rows[1], args: '' })
  })

  it('resolves nothing for a bare slash with no pick (Enter cancels)', () => {
    expect(palettePick(rows, '', 0)).toBeUndefined()
  })

  it('resolves nothing when no row matches, whatever the selection', () => {
    expect(palettePick(rows, 'zzz', 2)).toBeUndefined()
    expect(palettePick(rows, 'pla ', 0)).toBeUndefined()
  })

  it('clamps an out-of-range pick to the last match', () => {
    expect(palettePick(rows, 'com', 7)).toEqual({ command: rows[0], args: '' })
  })
})

describe('commandLine', () => {
  it('builds the exact dispatch line', () => {
    expect(commandLine('plan', '')).toBe('/plan')
    expect(commandLine('plan', 'off')).toBe('/plan off')
    expect(commandLine('goal', 'clear the board')).toBe('/goal clear the board')
  })
})
