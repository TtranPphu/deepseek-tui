import { describe, expect, it } from 'vitest'
import type { Key } from 'ink'
import { KEYBINDINGS, matchApprovalKey, matchKey } from './keys.js'
import { clampScroll, composerRows, scrollWindow, transcriptViewport, wrapText } from './scroll.js'

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  }
}

describe('matchKey', () => {
  it('maps every documented binding', () => {
    expect(matchKey('\r', key({ return: true }))).toBe('submit')
    expect(matchKey('\n', key())).toBe('newline')
    expect(matchKey('\r', key({ return: true, shift: true }))).toBe('newline')
    expect(matchKey('', key({ escape: true }))).toBe('interrupt')
    expect(matchKey('c', key({ ctrl: true }))).toBe('quit')
    expect(matchKey('', key({ upArrow: true }))).toBe('scroll-up')
    expect(matchKey('', key({ downArrow: true }))).toBe('scroll-down')
    expect(matchKey('', key({ pageUp: true }))).toBe('page-up')
    expect(matchKey('', key({ pageDown: true }))).toBe('page-down')
    expect(matchKey('\t', key({ tab: true }))).toBe('toggle-sidebar')
    expect(matchKey('n', key({ ctrl: true }))).toBe('new-session')
    expect(matchKey('x', key({ ctrl: true }))).toBe('delete-session')
    expect(matchKey('e', key({ ctrl: true }))).toBe('expand-focus')
    expect(matchKey('\x7f', key({ backspace: true }))).toBe('backspace')
  })

  it('maps approval decision keys only through the contextual matcher', () => {
    expect(matchApprovalKey('a', key())).toBe('approve')
    expect(matchApprovalKey('A', key())).toBe('approve')
    expect(matchApprovalKey('d', key())).toBe('deny')
    expect(matchApprovalKey('x', key())).toBe('deny')
    expect(matchApprovalKey('b', key())).toBeNull()
    expect(matchApprovalKey('a', key({ ctrl: true }))).toBeNull()
    // Not in the global table: plain typing must stay text while idle.
    expect(matchKey('a', key())).toBe('text')
    expect(matchKey('d', key())).toBe('text')
  })

  it('treats plain characters as text and swallows unbound control keys', () => {
    expect(matchKey('a', key())).toBe('text')
    expect(matchKey('pasted run', key())).toBe('text')
    expect(matchKey('g', key({ ctrl: true }))).toBeNull()
    expect(matchKey('', key())).toBeNull()
  })

  it('keeps one footer hint per documented group', () => {
    const hinted = KEYBINDINGS.filter((binding) => binding.hint).map((binding) => binding.action)
    expect(hinted).toEqual([
      'newline',
      'submit',
      'interrupt',
      'quit',
      'toggle-sidebar',
      'new-session',
      'delete-session',
      'expand-focus',
      'scroll-up',
      'page-up',
    ])
  })
})

describe('scroll math', () => {
  const lines = Array.from({ length: 30 }, (_, i) => i)

  it('clamps offsets into the reachable range', () => {
    expect(clampScroll(-3, 30, 10)).toBe(0)
    expect(clampScroll(99, 30, 10)).toBe(20)
    expect(clampScroll(5, 8, 10)).toBe(0)
  })

  it('pins the window to the tail at offset 0 and shifts it when scrolled', () => {
    expect(scrollWindow(lines, 10, 0)).toEqual(lines.slice(20))
    expect(scrollWindow(lines, 10, 5)).toEqual(lines.slice(15, 25))
    expect(scrollWindow(lines, 10, 99)).toEqual(lines.slice(0, 10))
  })

  it('sizes the composer and transcript viewport without clipping', () => {
    expect(composerRows('', 80)).toBe(1)
    expect(composerRows('x'.repeat(73), 80)).toBe(1)
    expect(composerRows('x'.repeat(74), 80)).toBe(2)
    expect(composerRows('x'.repeat(400), 20)).toBe(29)
    expect(composerRows('one\ntwo', 80)).toBe(2)
    expect(composerRows('\n', 80)).toBe(2)
    expect(transcriptViewport(24, 1)).toBe(19)
    expect(transcriptViewport(3, 5)).toBe(1)
  })

  it('wraps text on word boundaries and hard-breaks long words', () => {
    expect(wrapText('hello world', 80)).toEqual(['hello world'])
    expect(wrapText('hello world', 5)).toEqual(['hello', 'world'])
    expect(wrapText('aa bb cc', 5)).toEqual(['aa bb', 'cc'])
    expect(wrapText('supercalifragilistic', 5)).toEqual(['super', 'calif', 'ragil', 'istic'])
    expect(wrapText('', 5)).toEqual([''])
  })
})
