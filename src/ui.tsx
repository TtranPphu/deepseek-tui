// Dumb view components: projection in, JSX out. All transitions live in
// app.tsx's controller; colors and borders come only from theme tokens. Row
// flattening and the transcript window live in transcript.ts — the app hands
// each component its exact lines.
import { Box, Text } from 'ink'
import type { JSX } from 'react'
import { theme } from './theme.js'
import { APPROVAL_HINT, KEYBINDINGS } from './keys.js'
import { topWindow } from './scroll.js'
import { relativeTime, visibleStart } from './sessions.js'
import type { SidebarEntry } from './sessions.js'
import { displayToolName } from './projection.js'
import type { RenderLine } from './transcript.js'
import type { ApprovalPrompt } from './approval.js'
import type { HelpLine } from './help.js'
import type { PaletteCommand } from './commands.js'

export type SessionStatus = 'connecting' | 'idle' | 'running' | 'failed'

export interface SessionInfo {
  readonly id: string
  readonly model?: string | undefined
  readonly provider?: string | undefined
  readonly title?: string | undefined
  /** Durable session workspace; the live session's own cwd wins over this boot's. */
  readonly cwd?: string | undefined
}

/**
 * Brand-header projection: the parts of the header line for one session,
 * with the fit policy applied. Widths are exact — each part is plain text of
 * known display width and the sum with separators is `width` (≤ `cols`).
 * The header only ever carries model/provider/session/title/cwd facts, never
 * transient state, so a running turn redraws it to the same parts.
 */
export interface HeaderPart {
  readonly kind: 'brand' | 'identity' | 'model' | 'cwd'
  readonly text: string
}

export const HEADER_BRAND = '◆ deepseek-tui'
const HEADER_SEP = ' · '
const ELLIPSIS = '…'

/** Truncate from the end, keeping the width budget and leaving room for the ellipsis. */
function clip(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget <= 1) return ELLIPSIS.slice(0, budget)
  return `${text.slice(0, budget - 1)}${ELLIPSIS}`
}

/** Shorten a path from the left so its tail (the workspace name) stays readable. */
function clipPath(path: string, budget: number): string {
  if (path.length <= budget) return path
  if (budget <= 1) return ELLIPSIS.slice(0, budget)
  return `${ELLIPSIS}${path.slice(-(budget - 1))}`
}

export function projectHeader(source: SessionInfo | null, cols: number): { readonly parts: readonly HeaderPart[]; readonly width: number } {
  const join = (parts: readonly HeaderPart[]): { readonly parts: HeaderPart[]; readonly width: number } => {
    const present = parts.filter((part) => part.text.length > 0)
    const width = present.length === 0
      ? 0
      : present.reduce((sum, part) => sum + part.text.length, 0) + HEADER_SEP.length * (present.length - 1)
    return { parts: present, width }
  }
  const brand: HeaderPart = { kind: 'brand', text: HEADER_BRAND }
  const identity: HeaderPart = {
    kind: 'identity',
    text: source === null ? 'connecting…' : source.title ?? `session ${source.id.slice(0, 8)}`,
  }
  const model: HeaderPart | undefined = source === null || source.model === undefined
    ? undefined
    : { kind: 'model', text: source.provider === undefined ? source.model : `${source.model} · ${source.provider}` }
  const cwd: HeaderPart | undefined = source?.cwd === undefined ? undefined : { kind: 'cwd', text: source.cwd }
  // Parts have an order of expendability: the cwd is a nicety, the dimmed
  // model line is secondary, and the session identity only gives up its tail.
  const withModel = join([brand, identity, ...(model === undefined ? [] : [model])])
  const line = (parts: readonly HeaderPart[]): { readonly parts: HeaderPart[]; readonly width: number } => join(parts)
  if (cols >= withModel.width) {
    if (cwd === undefined) return withModel
    const full = line([...withModel.parts, cwd])
    if (cols >= full.width) return full
    const budget = cols - withModel.width - HEADER_SEP.length
    const clippedCwd = line([...withModel.parts, { kind: 'cwd', text: clipPath(cwd.text, budget) }])
    if (cols >= clippedCwd.width) return clippedCwd
    return withModel
  }
  const base = line([brand, identity])
  // A clipped identity keeps its readable prefix only with a sane budget;
  // below that the dimmed model line yields first.
  const identityBudget = cols - (withModel.width - identity.text.length)
  if (identityBudget >= 8) {
    const clippedIdentity = line([brand, { kind: 'identity', text: clip(identity.text, identityBudget) }, ...(model === undefined ? [] : [model])])
    if (cols >= clippedIdentity.width) return clippedIdentity
  }
  if (cols >= base.width) return base
  // Even without the model line a long title still needs its own truncation.
  const baseBudget = cols - (base.width - identity.text.length)
  const clippedBase = line([brand, { kind: 'identity', text: clip(identity.text, baseBudget) }])
  if (cols >= clippedBase.width) return clippedBase
  return line([{ kind: 'brand', text: clip(brand.text, cols) }])
}

/** The wordmark bar: brand, session identity, model/provider, and cwd when it fits. */
export function Header({ session, cols }: { session: SessionInfo | null; cols: number }): JSX.Element {
  const { parts, width } = projectHeader(session, cols)
  const gap = Math.max(0, cols - width)
  return (
    <Text backgroundColor={theme.colors.headerBg} wrap="truncate-end">
      {parts.map((part, index) => {
        const separator = index === 0 ? null : <Text key={`sep-${index}`} color={theme.colors.muted}>{HEADER_SEP}</Text>
        if (part.kind === 'brand') {
          // The wordmark's glyph carries the accent; the rest is the bold brand.
          const glyph = part.text.startsWith('◆') ? '◆' : ''
          const rest = part.text.slice(glyph.length).replace(/^ /, '')
          return (
            <Text key={part.kind}>
              {separator}
              <Text color={theme.colors.accent}>{glyph}</Text>
              {glyph !== '' ? <Text>{' '}</Text> : null}
              <Text bold color={theme.colors.headerFg}>{rest}</Text>
            </Text>
          )
        }
        const dim = part.kind === 'model' || part.kind === 'cwd'
        return (
          <Text key={part.kind}>
            {separator}
            <Text color={dim ? theme.colors.muted : theme.colors.headerFg}>{part.text}</Text>
          </Text>
        )
      })}
      {gap > 0 ? <Text color={theme.colors.headerFg}>{' '.repeat(gap)}</Text> : null}
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
      return <Text color={line.tone === 'error' ? theme.colors.error : theme.colors.muted} wrap="truncate-end">{line.text}</Text>
  }
}

/**
 * The transcript pane: the controller's exact window rows bottom-aligned in a
 * viewport-height column. The app slices (see transcript.ts); this component
 * never scrolls or flattens on its own.
 */
export function Transcript({ lines, viewport }: { lines: readonly RenderLine[]; viewport: number }): JSX.Element {
  return (
    <Box flexDirection="column" height={viewport} justifyContent="flex-end">
      {lines.map((line, index) => (
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

/** The keys the footer hints about change with the input surface. */
export type FooterMode = 'chat' | 'palette' | 'confirm'

/** Footer hint text per mode; chat shows the full KEYBINDINGS table. */
const MODE_HINTS: Record<FooterMode, string> = {
  chat: KEYBINDINGS.filter((binding) => binding.hint).map((binding) => binding.hint).join(' · '),
  palette: 'enter runs · esc closes · ↑/↓ pick · typing filters',
  confirm: 'enter confirms · esc cancels',
}

interface FooterProps {
  readonly status: SessionStatus
  readonly scroll: number
  /** Working state of the open turn; null when idle. */
  readonly activity: 'thinking' | 'tool' | null
  readonly awaitingApproval: boolean
  readonly spinner: string
  /** Running slash command name; overrides the working state while it runs. */
  readonly busyCommand: string | null
  /** Which surface owns Enter/Esc right now: chat, the palette, or a confirm. */
  readonly mode: FooterMode
}

export function Footer({ status, scroll, activity, awaitingApproval, spinner, busyCommand, mode }: FooterProps): JSX.Element {
  const working = busyCommand !== null
    ? `${spinner} running /${busyCommand}`
    : awaitingApproval
      ? 'awaiting approval'
      : activity === 'tool'
        ? `${spinner} tool running`
        : activity === 'thinking'
          ? `${spinner} working`
          : status
  const state = scroll > 0 ? `${working} · ↑${scroll} more` : working
  return (
    <Box justifyContent="space-between" width="100%">
      {/* The palette and confirm prompts take Enter/Esc away from the composer,
          so their modes replace the chat hints instead of lying about them. */}
      <Text color={theme.colors.muted} wrap="truncate-end">{MODE_HINTS[mode]}</Text>
      {/* truncate-end on both halves: a wrapping footer breaks the exact row math of the column above it. */}
      <Text color={theme.colors.muted} wrap="truncate-end">{state}</Text>
    </Box>
  )
}

const PLACEHOLDER = 'ask anything… · type / for commands'
const FAILED_PLACEHOLDER = 'session unavailable — ctrl+n starts a new one'

export function Composer({ input, busy, failed }: { input: string; busy: boolean; failed: boolean }): JSX.Element {
  const lines = input.split('\n')
  const placeholder = failed ? FAILED_PLACEHOLDER : PLACEHOLDER
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
          <Text color={theme.colors.muted}>{placeholder}</Text>
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

/** Rows the slash palette may show before truncation costs the user. */
export const PALETTE_MAX_ROWS = 8

/**
 * The slash-command palette: the typed query on top, the fuzzy-matched
 * roster below with the pick highlighted. Dumb — the controller owns the
 * query, the selection, and what Enter runs.
 */
export function CommandPalette({
  query,
  commands,
  selected,
  cols,
}: {
  readonly query: string
  readonly commands: readonly PaletteCommand[]
  readonly selected: number
  readonly cols: number
}): JSX.Element {
  // Window the match list around the pick (centered, like the sidebar) so the
  // highlight stays visible on rosters longer than the palette.
  const windowStart = visibleStart(Math.max(0, selected), commands.length, PALETTE_MAX_ROWS)
  const visible = commands.length === 0
    ? [{ name: '', description: 'no matching commands', source: 'local' as const }]
    : commands.slice(windowStart, windowStart + PALETTE_MAX_ROWS)
  return (
    <Box borderStyle={theme.borders.composer} borderColor={theme.colors.accent} paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.colors.accent}>{'❯ '}</Text>
        <Text bold>{query}</Text>
        <Text color={theme.colors.cursor}>▌</Text>
      </Text>
      {visible.map((command, index) => {
        const isSelected = commands.length > 0 && windowStart + index === selected
        if (command.name === '') {
          return <Text key="empty" color={theme.colors.muted} wrap="truncate-end">{command.description}</Text>
        }
        const alias = command.aliases?.length === 1 ? ` (alias /${command.aliases[0]})` : ''
        const usage = command.usage === undefined ? '' : ` ${command.usage}`
        return (
          <Text key={command.name} bold={isSelected} wrap="truncate-end"
            backgroundColor={isSelected ? theme.colors.selectedBg : undefined}>
            <Text color={isSelected ? undefined : theme.colors.muted}>{isSelected ? '› ' : '  '}</Text>
            <Text color={theme.colors.accent}>{`/${command.name}${usage}`}</Text>
            <Text color={isSelected ? undefined : theme.colors.muted}>{`${alias} — ${command.description}`}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

/** Fixed overlay chrome: 2 border rows, header and footer hint. */
export const HELP_CHROME_ROWS = 4

/**
 * Full-screen help overlay: fixed header and footer hints around a
 * top-anchored scrollable list of help lines. Dumb — the controller holds
 * the lines and the scroll position.
 */
export function HelpOverlay({
  lines,
  top,
  rows,
  cols,
}: {
  readonly lines: readonly HelpLine[]
  readonly top: number
  readonly rows: number
  readonly cols: number
}): JSX.Element {
  const viewport = Math.max(1, rows - HELP_CHROME_ROWS)
  const visible = topWindow(lines, viewport, top)
  return (
    <Box flexDirection="column" width={cols} height={rows}
      borderStyle="double" borderColor={theme.colors.accent}>
      <Box>
        <Text bold color={theme.colors.headerFg} wrap="truncate-end">{` deepseek-tui help — esc or ? closes`}</Text>
      </Box>
      {visible.map((line, index) => (
        line.kind === 'section'
          ? <Text key={index} bold color={theme.colors.accent} wrap="truncate-end">{` ${line.text}`}</Text>
          : <Text key={index} color={theme.colors.muted} wrap="truncate-end">{`  ${line.text}`}</Text>
      ))}
      <Box justifyContent="space-between">
        <Text color={theme.colors.muted} wrap="truncate-end">{' esc / ? close · ↑/↓ pgup/pgdn scroll'}</Text>
        <Text color={theme.colors.muted} wrap="truncate-end">{top > 0 ? `↑${top} more` : ''}</Text>
      </Box>
    </Box>
  )
}
