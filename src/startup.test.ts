// Startup flag parsing: the tui app-argument grammar and its terminal
// outcomes. Help and usage errors never provide values, mirroring the
// dsh-cmdline contract (print and request exit, provide nothing).
import { describe, expect, it } from 'vitest'
import { parseStartupArgs } from './startup.js'

const ID = 'a2ab797b-d282-4ddd-ae11-7feec253de57'

describe('parseStartupArgs', () => {
  it('no arguments parse to empty values (fresh session)', () => {
    expect(parseStartupArgs([])).toEqual({ kind: 'values', values: {} })
  })

  it('--resume and its --session alias carry the session id', () => {
    expect(parseStartupArgs(['--resume', ID])).toEqual({ kind: 'values', values: { resume: ID } })
    expect(parseStartupArgs(['--session', ID])).toEqual({ kind: 'values', values: { resume: ID } })
  })

  it('parses --model and --provider in either order, alone or combined', () => {
    expect(parseStartupArgs(['--model', 'deepseek-v4-pro'])).toEqual({
      kind: 'values',
      values: { model: 'deepseek-v4-pro' },
    })
    expect(parseStartupArgs(['--provider', 'deepseek-official', '--model', 'deepseek-v4-flash'])).toEqual({
      kind: 'values',
      values: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    expect(parseStartupArgs(['--model', 'x', '--provider', 'y'])).toEqual({
      kind: 'values',
      values: { model: 'x', provider: 'y' },
    })
  })

  it('accepts the --flag=value form', () => {
    expect(parseStartupArgs(['--resume=' + ID, '--model=deepseek-v4-pro'])).toEqual({
      kind: 'values',
      values: { resume: ID, model: 'deepseek-v4-pro' },
    })
  })

  it('later values win over earlier ones', () => {
    expect(parseStartupArgs(['--model', 'first', '--model', 'second'])).toEqual({
      kind: 'values',
      values: { model: 'second' },
    })
    expect(parseStartupArgs(['--resume', 'a', '--session', 'b'])).toEqual({
      kind: 'values',
      values: { resume: 'b' },
    })
  })

  it('--help and -h win wherever they appear and ignore the rest', () => {
    expect(parseStartupArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseStartupArgs(['-h'])).toEqual({ kind: 'help' })
    expect(parseStartupArgs(['--model', 'x', '--help', '--wat'])).toEqual({ kind: 'help' })
    expect(parseStartupArgs(['--help=value'])).not.toEqual({ kind: 'help' })
  })

  it('rejects a value option without its argument', () => {
    expect(parseStartupArgs(['--model'])).toEqual({ kind: 'error', message: "option '--model <model>' argument missing" })
    expect(parseStartupArgs(['--resume'])).toEqual({ kind: 'error', message: "option '--resume <sessionId>' argument missing" })
  })

  it('rejects empty values in both spellings', () => {
    expect(parseStartupArgs(['--model', ''])).toEqual({ kind: 'error', message: "option '--model <model>' argument must not be empty" })
    expect(parseStartupArgs(['--model='])).toEqual({ kind: 'error', message: "option '--model <model>' argument must not be empty" })
    expect(parseStartupArgs(['--provider='])).toEqual({ kind: 'error', message: "option '--provider <provider>' argument must not be empty" })
  })

  it('rejects unknown flags by their option name', () => {
    expect(parseStartupArgs(['--wat'])).toEqual({ kind: 'error', message: "unknown option '--wat'" })
    expect(parseStartupArgs(['--wat=1'])).toEqual({ kind: 'error', message: "unknown option '--wat'" })
    expect(parseStartupArgs(['-x'])).toEqual({ kind: 'error', message: "unknown option '-x'" })
  })

  it('rejects stray positionals, including after --', () => {
    expect(parseStartupArgs(['task'])).toEqual({ kind: 'error', message: "unexpected argument 'task'" })
    expect(parseStartupArgs(['--', 'task'])).toEqual({ kind: 'error', message: "unexpected argument 'task'" })
    expect(parseStartupArgs(['--', '--model', 'x'])).toEqual({ kind: 'error', message: "unexpected argument '--model'" })
  })

  it('a bare -- with nothing after parses cleanly', () => {
    expect(parseStartupArgs(['--'])).toEqual({ kind: 'values', values: {} })
  })
})
