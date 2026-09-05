// Pure sidebar session-list model: folds sessionQuery records and title reads
// into sidebar rows, owns selection movement/windowing, relative-time labels,
// and the confirm policy for destructive or turn-discarding actions. No React,
// no ctx — the app controller drives these from harness reads and key input.
import type { SessionRecord, SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface SidebarEntry {
  readonly id: SessionId
  /** Folded title, or the honest empty-state label. */
  readonly title: string
  readonly createdAt: number
  readonly live: boolean
}

/** Label for a session whose log has no `session/title` event yet. */
export const UNTITLED = 'new session'

/** Latest folded title per session id; rejected observations are skipped. */
export function titlesFrom(results: readonly SessionTitleObservationResult[]): ReadonlyMap<SessionId, string> {
  const titles = new Map<SessionId, string>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const title = result.value.title?.title
    if (title !== undefined) titles.set(result.sessionId, title)
  }
  return titles
}

/**
 * Sidebar rows for one workspace, in the query service's newest-first order.
 * Sessions from other working directories never appear.
 */
export function toSidebarEntries(
  records: readonly SessionRecord[],
  titles: ReadonlyMap<SessionId, string>,
  cwd: string,
): SidebarEntry[] {
  const entries: SidebarEntry[] = []
  for (const record of records) {
    if (record.header.cwd !== cwd) continue
    entries.push({
      id: record.header.id,
      title: titles.get(record.header.id) ?? UNTITLED,
      createdAt: record.header.createdAt,
      live: record.live,
    })
  }
  return entries
}

/** Clamp a selection index move; empty lists select nothing (index 0 unused). */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) return 0
  return Math.min(length - 1, Math.max(0, current + delta))
}

/**
 * First visible row of the sidebar window, keeping the selection near the
 * middle of the `capacity`-row slice.
 */
export function visibleStart(selected: number, length: number, capacity: number): number {
  if (length <= capacity) return 0
  return Math.min(length - capacity, Math.max(0, selected - Math.floor(capacity / 2)))
}

/** Compact relative age for sidebar metadata; absolute date past a week. */
export function relativeTime(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${String(days)}d`
  return new Date(then).toISOString().slice(0, 10)
}

/** A requested session action that may need a confirm step before it runs. */
export type PendingAction =
  | { readonly kind: 'open'; readonly id: SessionId }
  | { readonly kind: 'new' }
  | { readonly kind: 'delete'; readonly id: SessionId }

/**
 * Confirm policy: delete is always destructive; switching sessions mid-turn
 * discards the running turn, so it confirms too. Everything else runs at once.
 */
export function needsConfirmation(action: PendingAction, turnRunning: boolean): boolean {
  return action.kind === 'delete' || turnRunning
}

/** One-line prompt rendered while a {@link PendingAction} awaits confirmation. */
export function confirmationPrompt(action: PendingAction): string {
  switch (action.kind) {
    case 'delete':
      return 'delete this session? enter confirms, esc cancels'
    case 'open':
      return 'turn running — stop it and switch sessions? enter confirms, esc cancels'
    case 'new':
      return 'turn running — stop it and start a new session? enter confirms, esc cancels'
  }
}

/**
 * True when a delete rejection names an already-absent session, which the
 * sidebar treats as deleted. Harness error classes stay type-only imports
 * (the profile resolves no harness modules at runtime), so this matches the
 * stable `name` of SessionPersistenceNotFoundError instead of `instanceof`.
 */
export function isAlreadyDeleted(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionPersistenceNotFoundError'
}
