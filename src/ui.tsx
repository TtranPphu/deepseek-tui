// Dumb view components: projection in, JSX out. All transitions live in
// app.tsx's controller; colors and borders come only from theme tokens.
// `turnLines` flattens the turn view model into one row per terminal line so
// the scroll window math stays exact — wrapping happens here, not in Ink.
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import { theme } from './theme.js'
import { KEYBINDINGS } from './keys.js'
import { scrollWindow, wrapText } from './scroll.js'
import type { Projection, ToolPart, TurnPart, TurnView } from './projection.js'

export type SessionStatus = 'connecting' | 'idle' | 'running' | 'failed'

export interface SessionInfo {
  readonly id: string
  readonly model?: string | undefined
  readonly provider?: string | undefined
}

export interface RenderLine {
  readonly kind: 'user' | 'assistant' | 'tool' | 'result' | 'error' | 'sys'
  readonly text: string
  readonly spinner?: boolean
}

const RESULT_PREVIEW_LINES = 2

function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function toolHeader(part: ToolPart, spinner: string): string {
  const glyph = part.status === 'running'
    ? spinner
    : part.status === 'done'
      ? '✓'
      : part.status === 'error'
        ? '✗'
        : '■'
  const duration = part.durationMs === undefined ? '' : ` ${formatDuration(part.durationMs)}`
  return `  ${glyph} ${part.name}${duration}`
}

function partLines(part: TurnPart, cols: number, spinner: string): RenderLine[] {
  if (part.kind === 'tool') {
    const lines: RenderLine[] = [{ kind: 'tool', text: toolHeader(part, spinner), spinner: part.status === 'running' }]
    if (part.status !== 'running' && part.result !== '') {
      const resultLines = part.result.split('\n')
      for (const line of resultLines.slice(0, RESULT_PREVIEW_LINES)) {
        lines.push({ kind: 'result', text: `    ${line}` })
      }
      if (resultLines.length > RESULT_PREVIEW_LINES) {
        lines.push({ kind: 'result', text: `    … +${String(resultLines.length - RESULT_PREVIEW_LINES)} lines` })
      }
    }
    return lines
  }
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

function turnLines(turn: TurnView, cols: number, spinner: string): RenderLine[] {
  const lines: RenderLine[] = []
  if (turn.user !== '') {
    for (const [i, line] of turn.user.split('\n').entries()) {
      const prefix = i === 0 ? '❯ ' : '  '
      for (const wrapped of wrapText(prefix + line, cols)) lines.push({ kind: 'user', text: wrapped })
    }
  }
  for (const part of turn.parts) lines.push(...partLines(part, cols, spinner))
  if (turn.status === 'error') lines.push({ kind: 'error', text: `✗ ${turn.error ?? 'turn failed'}` })
  else if (turn.status === 'aborted') lines.push({ kind: 'sys', text: '■ stopped' })
  return lines
}

/** Flatten the projection into display rows: notices first, then turns in order. */
export function renderLines(notices: readonly string[], projection: Projection, cols: number, spinner: string): RenderLine[] {
  const lines: RenderLine[] = notices.map((text) => ({ kind: 'sys' as const, text }))
  for (const turn of projection.turns) lines.push(...turnLines(turn, cols, spinner))
  return lines
}

export function Header({ session, cols }: { session: SessionInfo | null; cols: number }): JSX.Element {
  const segments = [
    'deepseek-tui',
    session?.model,
    session?.provider,
    session ? `session ${session.id.slice(0, 8)}` : 'connecting…',
  ].filter((s): s is string => s !== undefined)
  return (
    <Text backgroundColor={theme.colors.headerBg} color={theme.colors.headerFg} bold wrap="truncate-end">
      {` ${segments.join(' · ')} `.padEnd(cols)}
    </Text>
  )
}

function LineRow({ line }: { line: RenderLine }): JSX.Element {
  switch (line.kind) {
    case 'user':
      return <Text bold color={theme.colors.user} wrap="truncate-end">{line.text}</Text>
    case 'assistant':
      return <Text wrap="truncate-end">{line.text}</Text>
    case 'tool':
      return <Text color={line.spinner ? theme.colors.accent : theme.colors.muted} wrap="truncate-end">{line.text}</Text>
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

export function Footer({ status, scroll }: { status: SessionStatus; scroll: number }): JSX.Element {
  const hints = KEYBINDINGS.filter((binding) => binding.hint).map((binding) => binding.hint).join(' · ')
  const state = scroll > 0 ? `${status} · ↑${scroll} more` : status
  return (
    <Box justifyContent="space-between" width="100%">
      <Text color={theme.colors.muted} wrap="truncate-end">{hints}</Text>
      <Text color={theme.colors.muted}>{state}</Text>
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
