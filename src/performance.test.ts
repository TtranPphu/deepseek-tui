// Baseline measurement for P6 long-session hardening: synthetic long sessions
// folded and flattened exactly like the live app does, with wall-clock timing.
// This spec asserts functional invariants only (never wall-clock — CI variance);
// its real output is the numbers it prints, which drove the windowing work.
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { MessageId, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { applySessionEvent, createProjection } from './projection.js'
import { createTranscriptModel } from './transcript.js'
import type { Notice } from './transcript.js'

let seq = 0
function event<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data']): SessionEvent {
  seq += 1
  return { type, seq: seq as SessionSeq, time: 1000 + seq * 10, data } as SessionEvent
}

function messageId(): MessageId {
  return `m${seq}` as MessageId
}

function callId(): ToolCallId {
  return `c${seq}` as ToolCallId
}

function userMessage(text: string): UserMessage {
  return {
    id: messageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Synthesize a long-lived session log in the harness event shapes the
 * projection folds: each turn is a user prompt, an assistant answer of a few
 * wrapped paragraphs, and — for `toolShare` of turns — two tool steps whose
 * results are `resultLines`-long (a `bigShare` of turns instead carry
 * `bigResultLines`, the giant-output case that dominates render cost).
 */
export function longSessionEvents(turnCount: number, options: { toolShare?: number; bigShare?: number; resultLines?: number; bigResultLines?: number } = {}): SessionEvent[] {
  const { toolShare = 0.6, bigShare = 0.08, resultLines = 40, bigResultLines = 2000 } = options
  const events: SessionEvent[] = []
  const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ')
  const paragraph = (length: number): string => Array.from({ length }, (_, i) => words[i % words.length]).join(' ')
  const bigLine = (): string => paragraph(60)
  for (let turn = 1; turn <= turnCount; turn++) {
    events.push(event('turn/start', { turn }))
    events.push(event('user/message', userMessage(paragraph(6 + (turn % 9)))))
    events.push(event('step/start', { turn, step: 1 }))
    events.push(event('request/header', {
      header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
      reason: 'initial',
    }))
    events.push(event('assistant/message', {
      turn,
      step: 1,
      message: {
        id: messageId(),
        role: 'assistant',
        content: [{ type: 'text', text: [paragraph(20), paragraph(24 + (turn % 20)), paragraph(10)].join('\n') }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
      stream: [],
    }))
    const withTools = (turn % 10) / 10 < toolShare
    if (withTools) {
      const lines = (turn % 100) / 100 < bigShare ? bigResultLines : resultLines
      for (const step of [1, 2]) {
        events.push(event('tool/call', {
          turn,
          step,
          callId: callId(),
          name: step === 1 ? 'bash' : 'fs_read',
          arguments: JSON.stringify(step === 1 ? { command: 'npm test -- --run' } : { path: '/src/index.ts', offset: 0 }),
        }))
        events.push(event('tool/result', {
          turn,
          step,
          message: {
            id: messageId(),
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: callId(),
              content: [{ type: 'text', text: Array.from({ length: lines }, (_, i) => `${bigLine()} #${i}`).join('\n') }],
            }],
            source: { kind: 'tool', callId: callId() },
          },
        }))
      }
    }
    events.push(event('step/end', { turn, step: 1 }))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return events
}

function timed<T>(label: string, work: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = work()
  return { value, ms: performance.now() - start }
}

describe('long-session windowed model (200 turns / ~1900 events)', () => {
  it('folds and renders the largest realistic replay with bounded cost', () => {
    const events = longSessionEvents(200)
    expect(events.length).toBeGreaterThanOrEqual(1800)

    const fold = timed('fold', () => {
      const projection = createProjection()
      for (const event of events) applySessionEvent(projection, event)
      return projection
    })
    const projection = fold.value
    expect(projection.turns).toHaveLength(200)

    // Cold refresh = the resume first paint: every turn flattens once.
    const coldModel = createTranscriptModel()
    const cold = timed('cold refresh (resume first paint)', () => refreshAll(coldModel, projection))
    const exact = coldModel.length
    expect(exact).toBeGreaterThan(1000)

    // Warm refresh = one live frame (stream chunk / spinner tick / keystroke):
    // frozen turns hit their row cache; only the live tail turn re-flattens.
    const frame = timed('warm per-frame refresh', () => refreshAll(coldModel, projection))
    const sliced = timed('visible slice (40-row viewport)', () => coldModel.visible(40, 0))
    expect(sliced.value.length).toBe(40)

    // eslint-disable-next-line no-console
    console.log(`[perf] events: ${events.length} | exact rows: ${exact} | fold: ${fold.ms.toFixed(1)}ms | cold refresh: ${cold.ms.toFixed(1)}ms | warm refresh/frame: ${frame.ms.toFixed(1)}ms | slice: ${sliced.ms.toFixed(2)}ms`)
  })
})

describe('long-session windowed model (stress: 1000 turns / ~9k events, giant outputs)', () => {
  it('keeps per-frame cost flat where the old full flatten was unbounded', () => {
    const events = longSessionEvents(1000, { bigShare: 0.1, bigResultLines: 4000 })
    expect(events.length).toBeGreaterThan(9000)

    const fold = timed('fold', () => {
      const projection = createProjection()
      for (const event of events) applySessionEvent(projection, event)
      return projection
    })
    const projection = fold.value

    const model = createTranscriptModel()
    const cold = timed('cold refresh (resume first paint)', () => refreshAll(model, projection))
    const frame = timed('warm per-frame refresh', () => refreshAll(model, projection))
    const sliced = timed('visible slice (40-row viewport)', () => model.visible(40, 0))
    expect(model.length).toBeGreaterThan(5000)
    expect(sliced.value.length).toBe(40)

    // eslint-disable-next-line no-console
    console.log(`[perf] events: ${events.length} | exact rows: ${model.length} | fold: ${fold.ms.toFixed(1)}ms | cold refresh: ${cold.ms.toFixed(1)}ms | warm refresh/frame: ${frame.ms.toFixed(1)}ms | slice: ${sliced.ms.toFixed(2)}ms`)
  })
})

const NOTICES: readonly Notice[] = []
const VIEW = { focusedCallId: null, approvalCallId: null }

/** One app-frame refresh: projection plus the render-only parameters. */
function refreshAll(model: ReturnType<typeof createTranscriptModel>, projection: ReturnType<typeof createProjection>): void {
  model.refresh({ notices: NOTICES, projection, cols: 100, spinner: '⠋', view: VIEW })
}
