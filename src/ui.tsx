// Dumb view components: state in, JSX out. All transitions live in app.tsx's
// controller; colors and borders come only from theme tokens.
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import { theme } from './theme.js'
import { KEYBINDINGS } from './keys.js'
import { scrollWindow } from './scroll.js'

export type LineKind = 'user' | 'event' | 'sys'

export interface Line {
  readonly kind: LineKind
  readonly text: string
}

export type SessionStatus = 'connecting' | 'idle' | 'running' | 'failed'

export interface SessionInfo {
  readonly id: string
  readonly model?: string | undefined
  readonly provider?: string | undefined
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

function LineRow({ line }: { line: Line }): JSX.Element {
  if (line.kind === 'user') {
    return <Text bold color={theme.colors.user}>{`❯ ${line.text}`}</Text>
  }
  if (line.kind === 'event') {
    return <Text color={theme.colors.event}>{line.text}</Text>
  }
  return <Text color={theme.colors.muted}>{line.text}</Text>
}

export function Transcript({ lines, viewport, scroll }: { lines: readonly Line[]; viewport: number; scroll: number }): JSX.Element {
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

export function Composer({ input, busy }: { input: string; busy: boolean }): JSX.Element {
  return (
    <Box
      borderStyle={theme.borders.composer}
      borderColor={busy ? theme.colors.accent : theme.colors.border}
      paddingX={1}
    >
      <Text color={theme.colors.accent}>{'❯ '}</Text>
      <Text>{input}</Text>
      <Text color={theme.colors.cursor}>▌</Text>
    </Box>
  )
}
