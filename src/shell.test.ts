import { describe, expect, it } from 'vitest'
import type { Key } from 'ink'
import { KEYBINDINGS, matchKey } from './keys.js'
import { clampScroll, composerRows, scrollWindow, transcriptViewport } from './scroll.js'

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
    expect(matchKey('', key({ escape: true }))).toBe('interrupt')
    expect(matchKey('c', key({ ctrl: true }))).toBe('quit')
    expect(matchKey('', key({ upArrow: true }))).toBe('scroll-up')
    expect(matchKey('', key({ downArrow: true }))).toBe('scroll-down')
    expect(matchKey('', key({ pageUp: true }))).toBe('page-up')
    expect(matchKey('', key({ pageDown: true }))).toBe('page-down')
    expect(matchKey('\x7f', key({ backspace: true }))).toBe('backspace')
  })

  it('treats plain characters as text and swallows unbound control keys', () => {
    expect(matchKey('a', key())).toBe('text')
    expect(matchKey('pasted run', key())).toBe('text')
    expect(matchKey('x', key({ ctrl: true }))).toBeNull()
    expect(matchKey('', key())).toBeNull()
  })

  it('keeps one footer hint per documented group', () => {
    const hinted = KEYBINDINGS.filter((binding) => binding.hint).map((binding) => binding.action)
    expect(hinted).toEqual(['submit', 'interrupt', 'quit', 'scroll-up', 'page-up'])
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
    expect(composerRows(0, 80)).toBe(1)
    expect(composerRows(73, 80)).toBe(1)
    expect(composerRows(74, 80)).toBe(2)
    expect(composerRows(400, 20)).toBe(29)
    expect(transcriptViewport(24, 1)).toBe(19)
    expect(transcriptViewport(3, 5)).toBe(1)
  })
})
