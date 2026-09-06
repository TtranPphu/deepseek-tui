import { describe, expect, it } from 'vitest'
import { scrollWindow } from './scroll.js'
import type { Projection, ToolPart, TurnView } from './projection.js'
import { createTranscriptModel, noticeLine, turnLines } from './transcript.js'
import type { Notice, RenderLine, TranscriptView } from './transcript.js'

const VIEW: TranscriptView = { focusedCallId: null, approvalCallId: null }
const NO_NOTICES: readonly Notice[] = []

function projectionOf(...turns: TurnView[]): Projection {
  return { turns, openTurn: null }
}

function refresh(model: ReturnType<typeof createTranscriptModel>, projection: Projection, view: TranscriptView = VIEW, cols = 80): void {
  model.refresh({ notices: NO_NOTICES, projection, cols, spinner: '⠋', view })
}

function doneTurn(num: number, user: string, parts: TurnView['parts'] = []): TurnView {
  return { num, user, userPending: false, parts, status: 'done' }
}

function tool(callId: string, name: string, args: string, status: ToolPart['status'], result: string): ToolPart {
  return { kind: 'tool', callId, name, args, status, result, startedAt: 1000, ...(status === 'done' ? { durationMs: 10 } : {}) }
}

describe('turnLines golden rows', () => {
  it('renders a text turn with prompt prefix and wrapped answer', () => {
    const turn = doneTurn(1, 'hello world', [{ kind: 'assistant', text: 'one two three', streaming: false }])
    expect(turnLines(turn, 12, '⠋', VIEW)).toEqual([
      { kind: 'user', text: '❯ hello' },
      { kind: 'user', text: 'world' },
      { kind: 'assistant', text: 'one two' },
      { kind: 'assistant', text: 'three' },
    ])
  })

  it('keeps the streaming cursor on the last assistant row', () => {
    const turn = doneTurn(1, '', [{ kind: 'assistant', text: 'growing', streaming: true }])
    expect(turnLines(turn, 80, '⠋', VIEW)).toEqual([{ kind: 'assistant', text: 'growing▌' }])
  })

  it('renders a done tool step collapsed to a header plus two preview lines', () => {
    const turn = doneTurn(1, 'run tests', [tool('c1', 'bash', '{"command":"npm test"}', 'done', 'pass 1\npass 2\npass 3\npass 4')])
    expect(turnLines(turn, 80, '⠋', VIEW)).toEqual([
      { kind: 'user', text: '❯ run tests' },
      { kind: 'tool', text: '╭─ Bash · npm test ✓ 10ms', tone: undefined },
      { kind: 'result', text: '│ pass 1' },
      { kind: 'result', text: '│ pass 2' },
      { kind: 'result', text: '╰─ … +2 lines · ctrl+e expand' },
    ])
  })

  it('expands only the focused step to full arguments and result', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const turn = doneTurn(1, '', [tool('c1', 'bash', '{"command":"big"}', 'done', body)])
    const collapsed = turnLines(turn, 80, '⠋', VIEW)
    expect(collapsed).toHaveLength(4)
    expect(collapsed[3]!.text).toContain('+198 lines')
    const expanded = turnLines(turn, 80, '⠋', { focusedCallId: 'c1', approvalCallId: null })
    expect(expanded.length).toBeGreaterThan(200)
    expect(expanded[0]!.text).toBe('╭─ Bash · big ✓ 10ms')
    expect(expanded.at(-1)!.text).toBe('╰─ ctrl+e collapse')
    // The collapsed preview stays lazy: only the expanded render materializes
    // the full result rows.
    expect(collapsed.some((line) => line.text.includes('line 199'))).toBe(false)
  })

  it('renders error and aborted end states under their turns', () => {
    const error = doneTurn(1, '', [])
    error.status = 'error'
    error.error = 'auth failed'
    const aborted = doneTurn(2, '', [tool('c1', 'bash', '{}', 'aborted', '')])
    aborted.status = 'aborted'
    const lines = turnLines(error, 80, '⠋', VIEW).concat(turnLines(aborted, 80, '⠋', VIEW))
    expect(lines).toEqual([
      { kind: 'error', text: '✗ auth failed' },
      { kind: 'tool', text: '╭─ Bash · {} ■', tone: undefined },
      { kind: 'sys', text: '■ stopped' },
    ])
  })

  it('renders notices as sys rows with the error tone flag', () => {
    expect(noticeLine({ text: 'session started' })).toEqual({ kind: 'sys', text: 'session started' })
    expect(noticeLine({ text: 'boom', error: true })).toEqual({ kind: 'sys', text: 'boom', tone: 'error' })
  })
})

describe('transcript window model', () => {
  const wide = (lines: readonly RenderLine[]): string[] => lines.map((line) => line.text)

  it('keeps the exact total of all rows and matches the reference full-list window at every offset', () => {
    const turns = Array.from({ length: 30 }, (_, i) => doneTurn(i + 1, `prompt ${i}`, [{ kind: 'assistant', text: `answer ${i} `.repeat(12).trim(), streaming: false }]))
    const projection = projectionOf(...turns)
    const all = turns.flatMap((turn) => turnLines(turn, 80, '⠋', VIEW))
    const model = createTranscriptModel()
    refresh(model, projection)
    expect(model.length).toBe(all.length)
    for (let viewport = 1; viewport <= all.length + 5; viewport++) {
      for (let offset = 0; offset <= all.length + 2; offset++) {
        expect(wide(model.visible(viewport, offset))).toEqual(wide(scrollWindow(all, viewport, offset)))
      }
    }
  })

  it('grows the tail when the live turn streams, leaving frozen rows untouched', () => {
    const frozen = doneTurn(1, 'prompt one', [{ kind: 'assistant', text: 'one two three four five', streaming: false }])
    const live = doneTurn(2, 'prompt two', [{ kind: 'assistant', text: 'hello', streaming: true }])
    live.status = 'running'
    const projection = projectionOf(frozen, live)
    const model = createTranscriptModel()
    refresh(model, projection)
    const before = wide(model.visible(80, 0))
    // The streaming turn mutates in place between frames (same turn reference).
    const streamingPart = live.parts[0] as { text: string }
    streamingPart.text = 'hello there world'
    refresh(model, projection)
    const after = wide(model.visible(80, 0))
    expect(after).toEqual([...before.slice(0, -1), 'hello there world▌'])
    expect(after[0]).toBe('❯ prompt one')
  })

  it('finalizes a frozen turn into the cache and stops recomputing it', () => {
    const live = doneTurn(1, 'prompt', [{ kind: 'assistant', text: 'working', streaming: true }])
    live.status = 'running'
    const projection = projectionOf(live)
    const model = createTranscriptModel()
    refresh(model, projection)
    live.status = 'done'
    live.parts = [{ kind: 'assistant', text: 'finished', streaming: false }]
    refresh(model, projection)
    const rows = wide(model.visible(80, 0))
    expect(rows).toEqual(['❯ prompt', 'finished'])
    // A later frame with nothing new must not change the frozen rows.
    refresh(model, projection)
    expect(wide(model.visible(80, 0))).toEqual(rows)
  })

  it('sits notices at the tail above the pinned bottom', () => {
    const projection = projectionOf(doneTurn(1, 'hi', []))
    const model = createTranscriptModel()
    const notices: Notice[] = []
    model.refresh({ notices, projection, cols: 80, spinner: '⠋', view: VIEW })
    notices.push({ text: 'session deleted' })
    model.refresh({ notices: [...notices], projection, cols: 80, spinner: '⠋', view: VIEW })
    expect(wide(model.visible(80, 0))).toEqual(['❯ hi', 'session deleted'])
    expect(model.visible(1, 0)[0]!.text).toBe('session deleted')
  })

  it('re-flattens on width change and on expand focus change', () => {
    const turn = doneTurn(1, 'a b c d e f', [tool('c1', 'bash', '{"command":"x"}', 'done', 'one\ntwo\nthree')])
    const projection = projectionOf(turn)
    const model = createTranscriptModel()
    refresh(model, projection, VIEW, 80)
    const at80 = wide(model.visible(80, 0))
    refresh(model, projection, VIEW, 8)
    expect(wide(model.visible(80, 0))).not.toEqual(at80)
    expect(model.visible(80, 0).length).toBeGreaterThan(at80.length)
    // Focus change materializes the full step text for the focused call.
    refresh(model, projection, { focusedCallId: 'c1', approvalCallId: null }, 80)
    const focused = wide(model.visible(80, 0))
    expect(focused.some((text) => text === '│ two')).toBe(true)
  })
})
