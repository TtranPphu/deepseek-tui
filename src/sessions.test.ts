import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import type { SessionHeader, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  UNTITLED,
  confirmationPrompt,
  isAlreadyDeleted,
  moveSelection,
  needsConfirmation,
  relativeTime,
  titlesFrom,
  toSidebarEntries,
  visibleStart,
} from './sessions.js'

const CWD = '/workspace/app'

function record(id: string, overrides: Partial<SessionHeader> = {}, live = false): SessionRecord {
  return {
    header: {
      version: 2,
      id: id as SessionId,
      createdAt: 1000,
      isSeeded: false,
      cwd: CWD,
      ...overrides,
    },
    live,
    persisted: true,
  }
}

function titleResult(id: string, title?: string): SessionTitleObservationResult {
  return {
    sessionId: id as SessionId,
    status: 'fulfilled',
    value: {
      session: record(id).header,
      ...(title === undefined
        ? {}
        : { title: { title, messageSeqs: [], source: { kind: 'fallback' as const }, eventSeq: 0 as SessionSeq, updatedAt: 0 } }),
    },
  }
}

describe('titlesFrom', () => {
  it('keeps fulfilled titles and skips missing or rejected observations', () => {
    const titles = titlesFrom([
      titleResult('a', 'fix the bug'),
      titleResult('b'),
      { sessionId: 'c' as SessionId, status: 'rejected', reason: new Error('gone') },
    ])
    expect(titles.get('a' as SessionId)).toBe('fix the bug')
    expect(titles.has('b' as SessionId)).toBe(false)
    expect(titles.has('c' as SessionId)).toBe(false)
  })
})

describe('toSidebarEntries', () => {
  it('keeps only current-workspace sessions in listing order with title fallback', () => {
    const entries = toSidebarEntries(
      [record('new'), record('other', { cwd: '/elsewhere' }), record('old')],
      new Map([[('old' as SessionId), 'shipped p2']]),
      CWD,
    )
    expect(entries.map((entry) => entry.id)).toEqual(['new', 'old'])
    expect(entries[0]?.title).toBe(UNTITLED)
    expect(entries[1]?.title).toBe('shipped p2')
  })
})

describe('moveSelection', () => {
  it('clamps to the list bounds', () => {
    expect(moveSelection(0, -1, 3)).toBe(0)
    expect(moveSelection(1, 1, 3)).toBe(2)
    expect(moveSelection(2, 1, 3)).toBe(2)
    expect(moveSelection(0, 1, 0)).toBe(0)
  })
})

describe('visibleStart', () => {
  it('shows the whole list when it fits', () => {
    expect(visibleStart(4, 5, 10)).toBe(0)
  })

  it('windows around the selection when the list overflows', () => {
    expect(visibleStart(0, 20, 6)).toBe(0)
    expect(visibleStart(10, 20, 6)).toBe(7)
    expect(visibleStart(19, 20, 6)).toBe(14)
  })
})

describe('relativeTime', () => {
  const now = 1_700_000_000_000
  it('labels seconds through days, then falls back to a date', () => {
    expect(relativeTime(now, now - 5_000)).toBe('now')
    expect(relativeTime(now, now - 5 * 60_000)).toBe('5m')
    expect(relativeTime(now, now - 3 * 3_600_000)).toBe('3h')
    expect(relativeTime(now, now - 2 * 86_400_000)).toBe('2d')
    expect(relativeTime(now, now - 14 * 86_400_000)).toBe(new Date(now - 14 * 86_400_000).toISOString().slice(0, 10))
  })

  it('never goes negative for clock skew', () => {
    expect(relativeTime(now, now + 60_000)).toBe('now')
  })
})

describe('needsConfirmation', () => {
  it('always confirms delete, confirms switches only while a turn runs', () => {
    expect(needsConfirmation({ kind: 'delete', id: 'a' as SessionId }, false)).toBe(true)
    expect(needsConfirmation({ kind: 'open', id: 'a' as SessionId }, true)).toBe(true)
    expect(needsConfirmation({ kind: 'new' }, true)).toBe(true)
    expect(needsConfirmation({ kind: 'open', id: 'a' as SessionId }, false)).toBe(false)
    expect(needsConfirmation({ kind: 'new' }, false)).toBe(false)
  })
})

describe('confirmationPrompt', () => {
  it('names the destructive action for delete and the discarded turn for switches', () => {
    expect(confirmationPrompt({ kind: 'delete', id: 'a' as SessionId })).toContain('delete')
    expect(confirmationPrompt({ kind: 'open', id: 'a' as SessionId })).toContain('turn running')
    expect(confirmationPrompt({ kind: 'new' })).toContain('turn running')
  })
})

describe('isAlreadyDeleted', () => {
  it('matches only the persistence not-found error name', () => {
    const notFound = new Error('session "a" not found')
    notFound.name = 'SessionPersistenceNotFoundError'
    expect(isAlreadyDeleted(notFound)).toBe(true)
    const owned = new Error('session "a" is already owned by an active write handle')
    owned.name = 'SessionAlreadyOwnedError'
    expect(isAlreadyDeleted(owned)).toBe(false)
    expect(isAlreadyDeleted(new Error('boom'))).toBe(false)
    expect(isAlreadyDeleted('SessionPersistenceNotFoundError')).toBe(false)
  })
})
