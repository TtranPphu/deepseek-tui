// Pure transcript view model: the projection's turns and the controller's
// notices flattened into exact terminal rows (one RenderLine per cell row, so
// scroll math stays exact), with a per-turn line cache. Live frames stay
// cheap because a completed turn is immutable — the harness finalizes turns in
// order and only the open tail turn ever mutates — so cached rows for earlier
// turns are valid until terminal width or the expand/approval focus changes.
// The cache key is (cols, focused/approval call ids): those are the only
// inputs that can change a frozen turn's rows. The window is a pure function
// of the cached blocks; no React or ctx here.
import { clampScroll, wrapText } from './scroll.js'
import { displayToolName, summarizeArgs } from './projection.js'
import type { Projection, ToolPart, TurnPart, TurnView } from './projection.js'

export type RenderLineKind = 'user' | 'assistant' | 'tool' | 'result' | 'error' | 'sys'

/** One exact terminal row of the transcript. */
export interface RenderLine {
  readonly kind: RenderLineKind
  readonly text: string
  readonly spinner?: boolean
  /** Header tone override: error cross, amber approval marker, accent focus. */
  readonly tone?: 'error' | 'warn' | 'accent'
}

/** Transient render focus: the ctrl+e-expanded step and the approval-blocked call. */
export interface TranscriptView {
  readonly focusedCallId: string | null
  readonly approvalCallId: string | null
}

/** One controller notice; errors render in the error tone. */
export interface Notice {
  readonly text: string
  readonly error?: boolean
}

const RESULT_PREVIEW_LINES = 2

function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function toolGlyph(part: ToolPart, spinner: string): string {
  switch (part.status) {
    case 'running': return spinner
    case 'done': return '✓'
    case 'error': return '✗'
    case 'aborted': return '■'
  }
}

/**
 * One tool step as a compact bordered block with a left rail. The expanded
 * (focused) step is the only one that materializes the full argument and
 * result text; every other step renders at most `RESULT_PREVIEW_LINES`.
 */
function toolLines(part: ToolPart, cols: number, spinner: string, view: TranscriptView): RenderLine[] {
  const focused = view.focusedCallId === part.callId
  const awaiting = view.approvalCallId === part.callId
  const duration = part.durationMs === undefined ? '' : ` ${formatDuration(part.durationMs)}`
  const marker = awaiting ? ' ▲ approval' : ''
  const tone = part.status === 'error' ? 'error' : awaiting ? 'warn' : focused ? 'accent' : undefined
  const header: RenderLine = {
    kind: 'tool',
    text: `╭─ ${displayToolName(part.name)} · ${summarizeArgs(part.args)} ${toolGlyph(part, spinner)}${duration}${marker}`,
    ...(part.status === 'running' ? { spinner: true } : {}),
    ...(tone === undefined ? {} : { tone }),
  }
  const lines: RenderLine[] = [header]
  // Running and aborted steps stay header-only: no result exists yet, and an
  // aborted one carries only the harness's internal abort notice, not output.
  if (part.status === 'running' || part.status === 'aborted') return lines
  const railWidth = Math.max(8, cols - 4)
  if (focused) {
    for (const argLine of part.args.split('\n')) {
      for (const wrapped of wrapText(argLine, railWidth)) lines.push({ kind: 'result', text: `│ ${wrapped}` })
    }
    for (const resultLine of part.result.split('\n')) {
      for (const wrapped of wrapText(resultLine, railWidth)) lines.push({ kind: 'result', text: `│ ${wrapped}` })
    }
    lines.push({ kind: 'result', text: '╰─ ctrl+e collapse' })
    return lines
  }
  if (part.result !== '') {
    const resultLines = part.result.split('\n')
    for (const line of resultLines.slice(0, RESULT_PREVIEW_LINES)) lines.push({ kind: 'result', text: `│ ${line}` })
    if (resultLines.length > RESULT_PREVIEW_LINES) {
      lines.push({ kind: 'result', text: `╰─ … +${String(resultLines.length - RESULT_PREVIEW_LINES)} lines · ctrl+e expand` })
    } else {
      lines.push({ kind: 'result', text: '╰─' })
    }
  }
  return lines
}

function partLines(part: TurnPart, cols: number, spinner: string, view: TranscriptView): RenderLine[] {
  if (part.kind === 'tool') return toolLines(part, cols, spinner, view)
  const out: RenderLine[] = []
  for (const paragraph of part.text.split('\n')) {
    for (const line of wrapText(paragraph, cols)) out.push({ kind: 'assistant', text: line })
  }
  if (part.streaming) {
    const last = out.pop()
    out.push({ kind: 'assistant', text: `${last?.text ?? ''}▌` })
  }
  return out
}

/** Flatten one turn view into its exact rows (user prompt, parts, end state). */
export function turnLines(turn: TurnView, cols: number, spinner: string, view: TranscriptView): RenderLine[] {
  const lines: RenderLine[] = []
  if (turn.user !== '') {
    for (const [i, line] of turn.user.split('\n').entries()) {
      const prefix = i === 0 ? '❯ ' : '  '
      for (const wrapped of wrapText(prefix + line, cols)) lines.push({ kind: 'user', text: wrapped })
    }
  }
  for (const part of turn.parts) lines.push(...partLines(part, cols, spinner, view))
  if (turn.status === 'error') lines.push({ kind: 'error', text: `✗ ${turn.error ?? 'turn failed'}` })
  else if (turn.status === 'aborted') lines.push({ kind: 'sys', text: '■ stopped' })
  return lines
}

/** One controller notice as a transcript row (sits after the turns). */
export function noticeLine(notice: Notice): RenderLine {
  return { kind: 'sys', text: notice.text, ...notice.error === true ? { tone: 'error' } : {} }
}

/** What one refresh needs: the whole fold plus the render-only parameters. */
export interface TranscriptInput {
  readonly notices: readonly Notice[]
  readonly projection: Projection
  readonly cols: number
  readonly spinner: string
  readonly view: TranscriptView
}

/**
 * The cached transcript: block per turn plus a tail block for the notices.
 * {@link TranscriptModel.refresh} folds new content into the blocks each render —
 * frozen turns hit their cache, only the live tail turn re-flattens — and
 * {@link TranscriptModel.visible} is a pure bottom-anchored window over the blocks.
 */
export interface TranscriptModel {
  /** Total exact rows (turns + notices); the scroll offset domain. */
  readonly length: number
  refresh(input: TranscriptInput): void
  /** The visible window at a lines-from-bottom `offset` (clamped), in order. */
  visible(viewport: number, offset: number): readonly RenderLine[]
}

export function createTranscriptModel(): TranscriptModel {
  interface TurnBlock {
    readonly turn: TurnView
    /** True when the block was flattened while its turn was still running. */
    readonly running: boolean
    readonly lines: readonly RenderLine[]
  }
  let blocks: TurnBlock[] = []
  let noticeLines: readonly RenderLine[] = []
  let noticeRef: readonly Notice[] | null = null
  let total = 0
  let cols = -1
  let viewKey = ''

  const refresh = (input: TranscriptInput): void => {
    const { notices, projection, spinner, view } = input
    const nextViewKey = `${view.focusedCallId ?? ''}\u0000${view.approvalCallId ?? ''}`
    if (input.cols !== cols || nextViewKey !== viewKey) {
      // Width or focus changed: every frozen turn's rows may differ now.
      blocks = []
      noticeRef = null
      noticeLines = []
      total = 0
      cols = input.cols
      viewKey = nextViewKey
    }
    const turns = projection.turns
    if (blocks.length > turns.length) {
      // Session reset replaced the projection; drop the orphaned blocks.
      for (let i = turns.length; i < blocks.length; i++) total -= blocks[i]!.lines.length
      blocks = blocks.slice(0, turns.length)
    }
    for (let i = 0; i < turns.length; i++) {
      const block = blocks[i]
      const turn = turns[i]!
      // A block is reusable only when its turn froze before it was flattened
      // and nothing since changed its rows (status running = still live).
      if (block !== undefined && !block.running && turn.status !== 'running') continue
      const lines = turnLines(turn, cols, spinner, view)
      total += lines.length - (block?.lines.length ?? 0)
      blocks[i] = { turn, lines, running: turn.status === 'running' }
    }
    if (notices !== noticeRef) {
      noticeRef = notices
      total += notices.length - noticeLines.length
      noticeLines = notices.map(noticeLine)
    }
  }

  const visible = (viewport: number, offset: number): readonly RenderLine[] => {
    const off = clampScroll(offset, total, viewport)
    const want = Math.min(viewport, total - off)
    if (want <= 0) return []
    // Exact row range over the virtual blocks concatenation (notices tail last).
    const firstRow = total - off - want
    const out: RenderLine[] = []
    let cursor = 0
    const visit = (lines: readonly RenderLine[]): void => {
      const blockStart = cursor
      cursor += lines.length
      if (cursor <= firstRow) return
      const startIdx = Math.max(0, firstRow - blockStart)
      const count = Math.min(lines.length - startIdx, total - off - Math.max(firstRow, blockStart))
      for (let j = startIdx; j < startIdx + count; j++) out.push(lines[j]!)
    }
    for (const block of blocks) visit(block.lines)
    visit(noticeLines)
    return out
  }

  return {
    get length() {
      return total
    },
    refresh,
    visible,
  }
}
