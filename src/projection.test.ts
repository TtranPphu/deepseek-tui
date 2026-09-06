import { describe, expect, it } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { LlmAttemptId, MessageId, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  applySessionEvent,
  createProjection,
  createStreamProjector,
  displayToolName,
  echoUser,
  findToolPart,
  nextFocusCallId,
  projectEvents,
  summarizeArgs,
  turnActivity,
  type AssistantPart,
  type ToolPart,
} from './projection.js'

let seq = 0
function event<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data']): SessionEvent {
  seq += 1
  return { type, seq: seq as SessionSeq, time: 1000 + seq * 10, data } as SessionEvent
}

function userMessage(text: string, source: UserMessage['source'] = { kind: 'user' }): UserMessage {
  return {
    id: `m${seq}` as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

function assistantData(turn: number, step: number, text: string): Extract<SessionEvent, { type: 'assistant/message' }>['data'] {
  return {
    turn,
    step,
    message: {
      id: `a${turn}.${step}` as MessageId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    stream: [],
  }
}

function frame(partial: Record<string, unknown>): AssistantStreamFrame {
  return { attemptId: 'att1' as LlmAttemptId, revision: 1, ...partial } as unknown as AssistantStreamFrame
}

describe('turn structure', () => {
  it('projects a full user → assistant turn', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('user/message', userMessage('hello')),
      event('step/start', { turn: 1, step: 1 }),
      event('assistant/message', assistantData(1, 1, 'hi there')),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(p.turns).toHaveLength(1)
    const turn = p.turns[0]!
    expect(turn.num).toBe(1)
    expect(turn.user).toBe('hello')
    expect(turn.userPending).toBe(false)
    expect(turn.status).toBe('done')
    expect(turn.parts).toEqual([{ kind: 'assistant', text: 'hi there', streaming: false }])
  })

  it('hides injected plugin context from user turns', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('user/message', userMessage('a file changed', { kind: 'plugin', plugin: 'watcher' })),
      event('user/message', userMessage('real prompt')),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(p.turns).toHaveLength(1)
    expect(p.turns[0]!.user).toBe('real prompt')
  })
})

describe('local echo', () => {
  it('confirms the echoed prompt instead of duplicating it', () => {
    const p = createProjection()
    echoUser(p, 'fix the bug')
    applySessionEvent(p, event('turn/start', { turn: 1 }))
    applySessionEvent(p, event('user/message', userMessage('fix the bug')))
    expect(p.turns).toHaveLength(1)
    expect(p.turns[0]!.num).toBe(1)
    expect(p.turns[0]!.userPending).toBe(false)
  })

  it('keeps a non-echoed user message as its own turn', () => {
    const p = createProjection()
    echoUser(p, 'first')
    applySessionEvent(p, event('turn/start', { turn: 1 }))
    applySessionEvent(p, event('user/message', userMessage('different text')))
    expect(p.turns).toHaveLength(2)
    expect(p.turns[1]!.user).toBe('different text')
  })
})

describe('streaming', () => {
  it('accumulates text deltas and lets the durable message finalize the part', () => {
    const p = createProjection()
    const stream = createStreamProjector(p)
    applySessionEvent(p, event('turn/start', { turn: 1 }))
    stream.apply(frame({ type: 'start', turn: 1, step: 1 }))
    stream.apply(frame({ type: 'chunk', index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'hel' } }))
    stream.apply(frame({ type: 'chunk', index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: 'lo' } }))
    const part = p.turns[0]!.parts[0] as AssistantPart
    expect(part.text).toBe('hello')
    expect(part.streaming).toBe(true)
    applySessionEvent(p, event('assistant/message', assistantData(1, 1, 'hello')))
    stream.apply(frame({ type: 'end', index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 as SessionSeq } }))
    expect(p.turns[0]!.parts).toHaveLength(1)
    expect(part.text).toBe('hello')
    expect(part.streaming).toBe(false)
  })

  it('keeps per-block deltas in block order', () => {
    const p = createProjection()
    const stream = createStreamProjector(p)
    applySessionEvent(p, event('turn/start', { turn: 1 }))
    stream.apply(frame({ type: 'start', turn: 1, step: 1 }))
    stream.apply(frame({ type: 'chunk', index: 1, time: 1, chunk: { type: 'text-delta', index: 1, text: 'world' } }))
    stream.apply(frame({ type: 'chunk', index: 0, time: 2, chunk: { type: 'text-delta', index: 0, text: 'hi' } }))
    expect((p.turns[0]!.parts[0] as AssistantPart).text).toBe('hiworld')
  })

  it('closes the streamed part when the attempt is abandoned', () => {
    const p = createProjection()
    const stream = createStreamProjector(p)
    applySessionEvent(p, event('turn/start', { turn: 1 }))
    stream.apply(frame({ type: 'start', turn: 1, step: 1 }))
    stream.apply(frame({ type: 'chunk', index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } }))
    stream.apply(frame({ type: 'end', index: 1, outcome: { kind: 'abandoned' } }))
    applySessionEvent(p, event('assistant/attempt', { turn: 1, step: 1, stream: [] }))
    const part = p.turns[0]!.parts[0] as AssistantPart
    expect(part.text).toBe('partial')
    expect(part.streaming).toBe(false)
  })
})

describe('tool steps', () => {
  it('pairs call with result by callId and records status, result, and duration', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{"cmd":"ls"}' }),
      event('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'r1' as MessageId,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1' as ToolCallId, content: [{ type: 'text', text: 'file.txt' }] }],
          source: { kind: 'tool', callId: 'c1' as ToolCallId },
        },
      }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const tool = p.turns[0]!.parts[0] as ToolPart
    expect(tool.name).toBe('bash')
    expect(tool.status).toBe('done')
    expect(tool.result).toBe('file.txt')
    expect(tool.durationMs).toBe(10)
  })

  it('flags error results', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{}' }),
      event('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'r1' as MessageId,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1' as ToolCallId, content: [{ type: 'text', text: 'boom' }], isError: true }],
          source: { kind: 'tool', callId: 'c1' as ToolCallId },
        },
      }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect((p.turns[0]!.parts[0] as ToolPart).status).toBe('error')
  })

  it('aborts running tool steps when the turn is cancelled', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{}' }),
      event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ])
    const turn = p.turns[0]!
    expect(turn.status).toBe('aborted')
    expect((turn.parts[0] as ToolPart).status).toBe('aborted')
  })

  it('marks an AbortError result as aborted, not error (cancel settles with one)', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{"cmd":"sleep"}' }),
      event('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'r1' as MessageId,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1' as ToolCallId, content: [{ type: 'text', text: 'Error: tool call aborted' }], isError: true }],
          source: { kind: 'tool', callId: 'c1' as ToolCallId },
        },
        error: { name: 'AbortError', code: 'ABORTED' },
      }),
      event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ])
    const tool = p.turns[0]!.parts[0] as ToolPart
    expect(tool.status).toBe('aborted')
    expect(tool.durationMs).toBe(10)
  })
})

describe('tool presentation helpers', () => {
  it('title-cases tool names', () => {
    expect(displayToolName('bash')).toBe('Bash')
    expect(displayToolName('fs_read')).toBe('Fs Read')
    expect(displayToolName('str-replace-editor')).toBe('Str Replace Editor')
  })

  it('summarizes shell commands, paths, and falls back to truncated JSON', () => {
    expect(summarizeArgs('{"command":"ls -la","description":"list"}')).toBe('ls -la')
    expect(summarizeArgs('{"path":"/etc/hosts","offset":0}')).toBe('/etc/hosts')
    expect(summarizeArgs('{"foo":"bar"}')).toBe('{"foo":"bar"}')
    expect(summarizeArgs('not json')).toBe('not json')
    expect(summarizeArgs(`{"command":"${'x'.repeat(200)}"}`)).toHaveLength(80)
    expect(summarizeArgs('{"command":"a\\nb"}')).toBe('a ⏎ b')
  })

  it('keeps the raw arguments on the tool part for the expand view', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{"command":"ls"}' }),
    ])
    expect((p.turns[0]!.parts[0] as ToolPart).args).toBe('{"command":"ls"}')
    expect(findToolPart(p, 'c1')?.name).toBe('bash')
    expect(findToolPart(p, 'nope')).toBeNull()
  })

  it('cycles expand focus newest-first, then back to none', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{}' }),
      event('tool/call', { turn: 1, step: 1, callId: 'c2' as ToolCallId, name: 'bash', arguments: '{}' }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', { turn: 2 }),
      event('tool/call', { turn: 2, step: 1, callId: 'c3' as ToolCallId, name: 'bash', arguments: '{}' }),
    ])
    expect(nextFocusCallId(p, null)).toBe('c3')
    expect(nextFocusCallId(p, 'c3')).toBe('c2')
    expect(nextFocusCallId(p, 'c2')).toBe('c1')
    expect(nextFocusCallId(p, 'c1')).toBeNull()
    expect(nextFocusCallId(p, 'stale')).toBeNull()
    expect(nextFocusCallId(createProjection(), null)).toBeNull()
  })

  it('reports the open turn as thinking or tool-running', () => {
    const p = createProjection()
    expect(turnActivity(p)).toBeNull()
    applySessionEvent(p, event('turn/start', { turn: 1 }))
    expect(turnActivity(p)).toBe('thinking')
    applySessionEvent(p, event('tool/call', { turn: 1, step: 1, callId: 'c1' as ToolCallId, name: 'bash', arguments: '{}' }))
    expect(turnActivity(p)).toBe('tool')
    applySessionEvent(p, event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    expect(turnActivity(p)).toBeNull()
  })
})

describe('turn end states', () => {
  function endWith(reason: TurnEndReason): { status: string; error?: string } {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason }),
    ])
    const turn = p.turns[0]!
    return { status: turn.status, error: turn.error }
  }

  it('maps end reasons to view status', () => {
    expect(endWith({ kind: 'completed' }).status).toBe('done')
    expect(endWith({ kind: 'aborted', reason: { kind: 'user' } }).status).toBe('aborted')
    expect(endWith({ kind: 'interrupted' }).status).toBe('aborted')
    expect(endWith({ kind: 'blocked' }).status).toBe('error')
    expect(endWith({ kind: 'max-tokens' })).toEqual({ status: 'error', error: 'max tokens reached' })
    expect(endWith({ kind: 'error', error: { message: 'auth failed', code: 'UNAUTHORIZED' } }))
      .toEqual({ status: 'error', error: 'auth failed' })
  })
})

describe('replay', () => {
  it('folds multi-turn history through the same code path as live events', () => {
    const p = projectEvents([
      event('turn/start', { turn: 1 }),
      event('user/message', userMessage('one')),
      event('assistant/message', assistantData(1, 1, 'answer one')),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', { turn: 2 }),
      event('user/message', userMessage('two')),
      event('assistant/message', assistantData(2, 1, 'answer two')),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    expect(p.turns.map((t) => [t.num, t.user, t.status])).toEqual([
      [1, 'one', 'done'],
      [2, 'two', 'done'],
    ])
    expect((p.turns[1]!.parts[0] as AssistantPart).text).toBe('answer two')
  })
})
