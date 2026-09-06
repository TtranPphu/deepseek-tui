// Pure event → view projection: folds the typed session-event stream and the
// live assistant-stream frames into ordered chat turns. No React, no ctx — the
// same fold serves live events and whole-log replay. The projection is
// append-only and mutated in place; the renderer reads `turns` after each fold.
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

export type TurnStatus = 'running' | 'done' | 'aborted' | 'error'

export interface AssistantPart {
  readonly kind: 'assistant'
  text: string
  streaming: boolean
}

export interface ToolPart {
  readonly kind: 'tool'
  readonly callId: string
  readonly name: string
  /** Raw JSON arguments from `tool/call`; the expand view and summary read this. */
  readonly args: string
  status: 'running' | 'done' | 'error' | 'aborted'
  result: string
  readonly startedAt: number
  durationMs?: number
}

export type TurnPart = AssistantPart | ToolPart

export interface TurnView {
  /** Turn number from `turn/start`; null for a locally echoed prompt not yet claimed. */
  num: number | null
  /** Prompt text; empty for turns without a visible user message. */
  user: string
  /** Echoed locally, not yet confirmed by a `user/message` event. */
  userPending: boolean
  parts: TurnPart[]
  status: TurnStatus
  error?: string
}

export interface Projection {
  readonly turns: TurnView[]
  /** Turn number of the open `turn/start`, null between turns. */
  openTurn: number | null
}

export function createProjection(): Projection {
  return { turns: [], openTurn: null }
}

/** Visible text of message content: text blocks joined, reasoning/tool blocks skipped. */
export function blocksToText(blocks: readonly ContentBlock[]): string {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') texts.push(block.text)
  }
  return texts.join('\n')
}

function endStatus(reason: TurnEndReason): { status: TurnStatus; error?: string } {
  switch (reason.kind) {
    case 'completed':
      return { status: 'done' }
    case 'aborted':
    case 'interrupted':
      return { status: 'aborted' }
    case 'error':
      return { status: 'error', error: reason.error.message }
    case 'blocked':
      return { status: 'error', error: 'turn blocked' }
    case 'max-tokens':
      return { status: 'error', error: 'max tokens reached' }
    default:
      return { status: 'error' }
  }
}

/** The turn view currently receiving content, creating or renumbering as needed. */
function ensureTurn(projection: Projection, num: number): TurnView {
  const last = projection.turns[projection.turns.length - 1]
  if (last && (last.num === null || last.num === num)) {
    last.num = num
    return last
  }
  const turn: TurnView = { num, user: '', userPending: false, parts: [], status: 'running' }
  projection.turns.push(turn)
  return turn
}

function finalizeTurn(turn: TurnView, status: TurnStatus, error?: string): void {
  turn.status = status
  if (error !== undefined) turn.error = error
  for (const part of turn.parts) {
    if (part.kind === 'assistant') part.streaming = false
    else if (part.status === 'running') part.status = status === 'done' ? 'done' : 'aborted'
  }
}

/** Local echo of the submitted prompt; confirmed by the later `user/message`. */
export function echoUser(projection: Projection, text: string): void {
  projection.turns.push({ num: null, user: text, userPending: true, parts: [], status: 'running' })
}

/** Fold one durable session event. Unknown merge-extended types are ignored. */
export function applySessionEvent(projection: Projection, event: SessionEvent): void {
  switch (event.type) {
    case 'turn/start':
      projection.openTurn = event.data.turn
      ensureTurn(projection, event.data.turn)
      return
    case 'user/message': {
      // ponytail: only human prompts render as user turns; injected plugin
      // context (kind 'plugin' notices/snapshots) stays hidden until the UI
      // grows a notice surface.
      if (event.data.source.kind !== 'user') return
      const text = blocksToText(event.data.content)
      const last = projection.turns[projection.turns.length - 1]
      if (last?.userPending && last.user === text) {
        last.userPending = false
        return
      }
      // A `turn/start`-opened turn still empty takes this message as its prompt.
      if (last && last.user === '' && last.parts.length === 0 && last.status === 'running') {
        last.user = text
        return
      }
      projection.turns.push({
        num: projection.openTurn,
        user: text,
        userPending: false,
        parts: [],
        status: 'running',
      })
      return
    }
    case 'assistant/message': {
      const turn = ensureTurn(projection, event.data.turn)
      const text = blocksToText(event.data.message.content)
      const lastPart = turn.parts[turn.parts.length - 1]
      if (lastPart?.kind === 'assistant' && lastPart.streaming) {
        lastPart.text = text
        lastPart.streaming = false
      } else {
        turn.parts.push({ kind: 'assistant', text, streaming: false })
      }
      return
    }
    case 'assistant/attempt': {
      // The attempt committed no surface message; keep the streamed prefix as-is.
      const turn = ensureTurn(projection, event.data.turn)
      const lastPart = turn.parts[turn.parts.length - 1]
      if (lastPart?.kind === 'assistant') lastPart.streaming = false
      return
    }
    case 'tool/call': {
      const turn = ensureTurn(projection, event.data.turn)
      turn.parts.push({
        kind: 'tool',
        callId: event.data.callId,
        name: event.data.name,
        args: event.data.arguments,
        status: 'running',
        result: '',
        startedAt: event.time,
      })
      return
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const callId: string = block.toolCallId
      for (let i = projection.turns.length - 1; i >= 0; i--) {
        const parts = projection.turns[i]?.parts ?? []
        const part = parts.find((p): p is ToolPart => p.kind === 'tool' && p.callId === callId && p.status === 'running')
        if (part) {
          // A cancelled call settles with an AbortError result (codes
          // 'ABORTED'/'ABORTED_BEFORE_DISPATCH'): the user stopped it, so the
          // step reads as aborted, never as a failure.
          part.status = event.data.error?.name === 'AbortError'
            ? 'aborted'
            : block.isError === true || event.data.error
              ? 'error'
              : 'done'
          part.result = blocksToText(block.content)
          part.durationMs = event.time - part.startedAt
          return
        }
      }
      return
    }
    case 'turn/end': {
      projection.openTurn = null
      const turn = ensureTurn(projection, event.data.turn)
      const { status, error } = endStatus(event.data.reason)
      finalizeTurn(turn, status, error)
      return
    }
    default:
      return
  }
}

/** Live streaming state for the one in-flight attempt. */
interface OpenAttempt {
  readonly attemptId: string
  readonly part: AssistantPart
  readonly byBlock: Map<number, string>
}

export interface StreamProjector {
  apply(frame: AssistantStreamFrame): void
}

/**
 * Fold `agent/assistant-stream` frames into a streaming assistant part of the
 * current turn. Durable `assistant/message` events finalize the same part, so
 * replay (session events only) and live tailing share the one view model.
 */
export function createStreamProjector(projection: Projection): StreamProjector {
  let open: OpenAttempt | null = null
  return {
    apply(frame: AssistantStreamFrame): void {
      switch (frame.type) {
        case 'start': {
          const turn = ensureTurn(projection, frame.turn)
          const part: AssistantPart = { kind: 'assistant', text: '', streaming: true }
          turn.parts.push(part)
          open = { attemptId: frame.attemptId, part, byBlock: new Map() }
          return
        }
        case 'chunk': {
          if (!open || frame.attemptId !== open.attemptId) return
          const chunk = frame.chunk
          // ponytail: reasoning deltas and tool-call argument deltas are not
          // rendered — reasoning is hidden and tool calls arrive as durable
          // tool/call events. Add when the UI grows a reasoning surface.
          if (chunk.type === 'text-delta') {
            const { byBlock, part } = open
            byBlock.set(chunk.index, (byBlock.get(chunk.index) ?? '') + chunk.text)
            part.text = [...byBlock.keys()].sort((a, b) => a - b).map((i) => byBlock.get(i) ?? '').join('')
          }
          return
        }
        case 'end':
          if (open && frame.attemptId === open.attemptId) {
            if (frame.outcome.kind === 'abandoned') open.part.streaming = false
            open = null
          }
          return
      }
    },
  }
}

/** Replay a whole event history through the same fold as live events. */
export function projectEvents(events: readonly SessionEvent[]): Projection {
  const projection = createProjection()
  for (const event of events) applySessionEvent(projection, event)
  return projection
}

/** Tool name in the header's title case: `bash` → `Bash`, `fs_read` → `Fs Read`. */
export function displayToolName(name: string): string {
  return name
    .split(/[_-]/)
    .map((word) => (word === '' ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Terse one-line summary of a tool call's JSON arguments, in opencode's
 * style: shell tools show the command, path-taking tools show the path, and
 * everything else shows the raw arguments truncated.
 * @param argsJson - the `tool/call` arguments string.
 * @param max - maximum summary length.
 * @returns a single-line summary (no newlines).
 */
export function summarizeArgs(argsJson: string, max = 80): string {
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return truncate(argsJson.replaceAll('\n', ' '), max)
  }
  if (typeof args !== 'object' || args === null) return truncate(argsJson, max)
  const record = args as Record<string, unknown>
  for (const field of ['command', 'cmd']) {
    const value = record[field]
    if (typeof value === 'string') return truncate(value.replaceAll('\n', ' ⏎ '), max)
  }
  for (const field of ['path', 'file_path', 'filePath', 'file']) {
    const value = record[field]
    if (typeof value === 'string') return truncate(value, max)
  }
  return truncate(argsJson.replaceAll('\n', ' '), max)
}

/** Every tool callId in display order (turn order, then part order). */
export function toolCallIds(projection: Projection): string[] {
  const ids: string[] = []
  for (const turn of projection.turns) {
    for (const part of turn.parts) {
      if (part.kind === 'tool') ids.push(part.callId)
    }
  }
  return ids
}

/**
 * The expand/collapse focus cycle: from no focus to the newest tool step,
 * then step by step toward the oldest, then back to none. A focused callId
 * that left the projection (session switch) restarts the cycle.
 */
export function nextFocusCallId(projection: Projection, current: string | null): string | null {
  const ids = toolCallIds(projection)
  if (ids.length === 0) return null
  if (current === null) return ids[ids.length - 1]!
  const index = ids.indexOf(current)
  if (index <= 0) return null
  return ids[index - 1]!
}

/** Find a tool part by callId (approval banner looks up the proposed call). */
export function findToolPart(projection: Projection, callId: string): ToolPart | null {
  for (let i = projection.turns.length - 1; i >= 0; i--) {
    const part = projection.turns[i]!.parts.find((p): p is ToolPart => p.kind === 'tool' && p.callId === callId)
    if (part) return part
  }
  return null
}

/**
 * The active turn's working state for the footer: `tool` while any tool step
 * runs, `thinking` while the turn is open with nothing executing, null when
 * no turn is running.
 */
export function turnActivity(projection: Projection): 'thinking' | 'tool' | null {
  const last = projection.turns[projection.turns.length - 1]
  if (!last || last.status !== 'running') return null
  return last.parts.some((part) => part.kind === 'tool' && part.status === 'running') ? 'tool' : 'thinking'
}
