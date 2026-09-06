import { describe, expect, it } from 'vitest'
import { helpSections, overlayLines } from './help.js'
import { APPROVAL_HINT, KEYBINDINGS } from './keys.js'
import { mergeCommands } from './commands.js'

const ROSTER = mergeCommands([
  { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
  { name: 'compact', description: 'Compact older conversation history' },
])

describe('helpSections', () => {
  const sections = helpSections(ROSTER)

  it('groups sections in display order with every expected group', () => {
    expect(sections.map((section) => section.title)).toEqual([
      'Navigation & view',
      'Composer',
      'Sessions',
      'Approvals',
      'Commands',
    ])
  })

  it('documents every keybinding exactly once across the key sections', () => {
    const rows = new Set(sections.slice(0, 3).flatMap((section) => section.rows))
    const documented = KEYBINDINGS
      .map((binding) => binding.doc ?? binding.hint)
      .filter((label) => label !== '')
    for (const label of documented) {
      expect(rows.has(label), `missing help row for "${label}"`).toBe(true)
    }
    expect(rows.size).toBe(documented.length)
  })

  it('shows the navigation and composer essentials', () => {
    const navigation = sections[0]!.rows
    expect(navigation).toContain('esc stop/quit')
    expect(navigation).toContain('? help')
    expect(sections[1]!.rows).toEqual(['ctrl+j newline', 'enter send/stop', 'backspace delete'])
  })

  it('derives the approval row from the approval hint constant', () => {
    expect(sections[3]!.rows).toEqual([APPROVAL_HINT])
  })

  it('lists the palette usage and the merged command roster with usage', () => {
    const rows = sections[4]!.rows
    expect(rows[0]).toContain('type /')
    expect(rows[1]).toBe('palette keys: enter runs · esc closes · ↑/↓ pick · typing filters')
    expect(rows).toContain('/compact — Compact older conversation history')
    expect(rows).toContain('/plan [off|message] — Enter or leave plan mode')
    expect(rows).toContain('/help (alias /keybindings) — Show keybindings and slash commands')
  })

  it('flattens sections into one scrollable line stream', () => {
    const lines = overlayLines(sections)
    const sectionCount = sections.length
    expect(lines).toHaveLength(sectionCount + sections.reduce((total, section) => total + section.rows.length, 0))
    expect(lines[0]).toEqual({ kind: 'section', text: 'Navigation & view' })
    expect(lines.filter((line) => line.kind === 'section')).toHaveLength(sectionCount)
  })
})
