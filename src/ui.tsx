// Dumb view components: projection in, JSX out. All transitions live in
// app.tsx's controller; colors and borders come only from theme tokens.
// `turnLines` flattens the turn view model into one row per terminal line so
// the scroll window math stays exact — wrapping happens here, not in Ink.
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import { theme } from './theme.js'
import { APPROVAL_HINT, KEYBINDINGS } from './keys.js'
import { scrollWindow, wrapText } from './scroll.js'
import { relativeTime, visibleStart } from './sessions.js'
import type { SidebarEntry } from './sessions.js'
import { displayToolName, summarizeArgs } from './projection.js'
import type { Projection, ToolPart, TurnPart, TurnView } from './projection.js'
import type { ApprovalPrompt } from './approval.js'

export type SessionStatus = 'connecting' | 'idle' | 'running' | 'failed'

export interface SessionInfo {
  readonly id: string
  readonly model?: string | undefined
  readonly provider?: string | undefined
  readonly title?: string | undefined
}

export interface RenderLine {
  readonly kind: 'user' | 'assistant' | 'tool' | 'result' | 'error' | 'sys'
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

/** One tool step as a compact bordered block with a left rail. */
function toolLines(part: ToolPart, cols: number, spinner: string, view: TranscriptView): RenderLine[] {
  const focused = view.focusedCallId === part.callId
  const awaiting = view.approvalCallId === part.callId
  const duration = part.durationMs === undefined ? '' : ` ${formatDuration(part.durationMs)}`
  const marker = awaiting ? ' ▲ approval' : ''
  const header: RenderLine = {
    kind: 'tool',
    text: `╭─ ${displayToolName(part.name)} · ${summarizeArgs(part.args)} ${toolGlyph(part, spinner)}${duration}${marker}`,
    spinner: part.status === 'running',
    tone: part.status === 'error' ? 'error' : awaiting ? 'warn' : focused ? 'accent' : undefined,
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

function turnLines(turn: TurnView, cols: number, spinner: string, view: TranscriptView): RenderLine[] {
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

/** Flatten the projection into display rows: notices first, then turns in order. */
export function renderLines(
  notices: readonly string[],
  projection: Projection,
  cols: number,
  spinner: string,
  view: TranscriptView = { focusedCallId: null, approvalCallId: null },
): RenderLine[] {
  const lines: RenderLine[] = notices.map((text) => ({ kind: 'sys' as const, text }))
  for (const turn of projection.turns) lines.push(...turnLines(turn, cols, spinner, view))
  return lines
}

export function Header({ session, cols }: { session: SessionInfo | null; cols: number }): JSX.Element {
  const segments = [
    'deepseek-tui',
    session?.model,
    session?.provider,
    session ? (session.title ?? `session ${session.id.slice(0, 8)}`) : 'connecting…',
  ].filter((s): s is string => s !== undefined)
  return (
    <Text backgroundColor={theme.colors.headerBg} color={theme.colors.headerFg} bold wrap="truncate-end">
      {` ${segments.join(' · ')} `.padEnd(cols)}
    </Text>
  )
}

export const SIDEBAR_WIDTH = 28

interface SidebarProps {
  readonly entries: readonly SidebarEntry[]
  readonly selectedId: string | null
  readonly activeId: string | null
  readonly now: number
  readonly rows: number
}

function SidebarRow({ entry, selected, active, now }: { entry: SidebarEntry; selected: boolean; active: boolean; now: number }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text
        bold={selected}
        backgroundColor={selected ? theme.colors.selectedBg : undefined}
        color={active ? theme.colors.accent : undefined}
        wrap="truncate-end"
      >
        {`${selected ? '›' : ' '}${active ? '● ' : ' '}${entry.title}`}
      </Text>
      <Text color={theme.colors.muted} wrap="truncate-end">
        {`    ${relativeTime(now, entry.createdAt)}${entry.live ? ' · live' : ''}`}
      </Text>
    </Box>
  )
}

export function Sidebar({ entries, selectedId, activeId, now, rows }: SidebarProps): JSX.Element {
  // Two rows per entry plus the heading; window the list around the selection.
  const capacity = Math.max(1, Math.floor((rows - 1) / 2))
  const selectedIndex = Math.max(0, entries.findIndex((entry) => entry.id === selectedId))
  const start = visibleStart(selectedIndex, entries.length, capacity)
  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height={rows}
      borderStyle={theme.borders.sidebar}
      borderColor={theme.colors.border}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
    >
      <Text bold color={theme.colors.muted}>{' sessions'}</Text>
      {entries.length === 0 ? <Text color={theme.colors.muted}>{' none yet'}</Text> : null}
      {entries.slice(start, start + capacity).map((entry) => (
        <SidebarRow
          key={entry.id}
          entry={entry}
          selected={entry.id === selectedId}
          active={entry.id === activeId}
          now={now}
        />
      ))}
    </Box>
  )
}

function LineRow({ line }: { line: RenderLine }): JSX.Element {
  switch (line.kind) {
    case 'user':
      return <Text bold color={theme.colors.user} wrap="truncate-end">{line.text}</Text>
    case 'assistant':
      return <Text wrap="truncate-end">{line.text}</Text>
    case 'tool': {
      const color = line.tone === 'error'
        ? theme.colors.error
        : line.tone === 'warn'
          ? theme.colors.event
          : line.spinner || line.tone === 'accent'
            ? theme.colors.accent
            : theme.colors.muted
      return <Text color={color} wrap="truncate-end">{line.text}</Text>
    }
    case 'result':
      return <Text color={theme.colors.muted} wrap="truncate-end">{line.text}</Text>
    case 'error':
      return <Text color={theme.colors.error} wrap="truncate-end">{line.text}</Text>
    default:
      return <Text color={theme.colors.muted} wrap="truncate-end">{line.text}</Text>
  }
}

export function Transcript({ lines, viewport, scroll }: { lines: readonly RenderLine[]; viewport: number; scroll: number }): JSX.Element {
  const visible = scrollWindow(lines, viewport, scroll)
  return (
    <Box flexDirection="column" height={viewport} justifyContent="flex-end">
      {visible.map((line, index) => (
        <LineRow key={index} line={line} />
      ))}
    </Box>
  )
}

/** Fixed height of the approval banner so viewport math stays exact. */
export const APPROVAL_BANNER_ROWS = 3

/**
 * The approval prompt region above the composer: the tool and proposed
 * command, the asker's reason, and the decision keys. Dumb — decisions are
 * the controller's.
 */
export function ApprovalBanner({ prompt, command }: { prompt: ApprovalPrompt; command: string | null }): JSX.Element {
  const proposed = command === null ? displayToolName(prompt.toolName) : `${displayToolName(prompt.toolName)} · ${command}`
  return (
    <Box flexDirection="column" height={APPROVAL_BANNER_ROWS}>
      <Text bold color={theme.colors.event} wrap="truncate-end">{` ▲ approval required — ${proposed}`}</Text>
      <Text color={theme.colors.muted} wrap="truncate-end">{`   ${prompt.reason ?? 'the tool asks for permission'}`}</Text>
      <Text color={theme.colors.muted} wrap="truncate-end">{`   ${APPROVAL_HINT}`}</Text>
    </Box>
  )
}

interface FooterProps {
  readonly status: SessionStatus
  readonly scroll: number
  /** Working state of the open turn; null when idle. */
  readonly activity: 'thinking' | 'tool' | null
  readonly awaitingApproval: boolean
  readonly spinner: string
}

export function Footer({ status, scroll, activity, awaitingApproval, spinner }: FooterProps): JSX.Element {
  const hints = KEYBINDINGS.filter((binding) => binding.hint).map((binding) => binding.hint).join(' · ')
  const working = awaitingApproval ? 'awaiting approval' : activity === 'tool' ? `${spinner} tool running` : activity === 'thinking' ? `${spinner} working` : status
  const state = scroll > 0 ? `${working} · ↑${scroll} more` : working
  return (
    <Box justifyContent="space-between" width="100%">
      <Text color={theme.colors.muted} wrap="truncate-end">{hints}</Text>
      {/* truncate-end on both halves: a wrapping footer breaks the exact row math of the column above it. */}
      <Text color={theme.colors.muted} wrap="truncate-end">{state}</Text>
    </Box>
  )
}

const PLACEHOLDER = 'ask anything…'

export function Composer({ input, busy }: { input: string; busy: boolean }): JSX.Element {
  const lines = input.split('\n')
  return (
    <Box
      borderStyle={theme.borders.composer}
      borderColor={busy ? theme.colors.accent : theme.colors.border}
      paddingX={1}
      flexDirection="column"
    >
      {input === '' ? (
        <Text>
          <Text color={theme.colors.accent}>{'❯ '}</Text>
          <Text color={theme.colors.muted}>{PLACEHOLDER}</Text>
          <Text color={theme.colors.cursor}>▌</Text>
        </Text>
      ) : (
        lines.map((line, index) => (
          <Text key={index}>
            <Text color={theme.colors.accent}>{index === 0 ? '❯ ' : '  '}</Text>
            <Text>{line}</Text>
            {index === lines.length - 1 ? <Text color={theme.colors.cursor}>▌</Text> : null}
          </Text>
        ))
      )}
    </Box>
  )
}
