// Pure help-overlay projection: grouped rows derived from the KEYBINDINGS
// table, the approval keys constant, and the same merged command roster the
// palette filters — the overlay cannot drift from the keys that actually
// dispatch. No React, no ctx; the app controller opens the overlay with these
// lines and the overlay component renders them.
import { APPROVAL_HINT, KEYBINDINGS } from './keys.js'
import type { KeyGroup } from './keys.js'
import type { PaletteCommand } from './commands.js'

export interface HelpSection {
  readonly title: string
  readonly rows: readonly string[]
}

/** One flattened overlay line: a group heading or a doc row. */
export interface HelpLine {
  readonly kind: 'section' | 'row'
  readonly text: string
}

/** Help text for binding groups, in display order. */
export const KEY_GROUP_TITLES: readonly { readonly group: KeyGroup; readonly title: string }[] = [
  { group: 'navigation', title: 'Navigation & view' },
  { group: 'composer', title: 'Composer' },
  { group: 'sessions', title: 'Sessions' },
]

const PALETTE_DOCS: readonly string[] = [
  'type / at a fresh input position (idle only) to open the command palette',
  'palette keys: enter runs · esc closes · ↑/↓ pick · typing filters',
]

function bindingLabel(binding: (typeof KEYBINDINGS)[number]): string {
  return binding.doc ?? binding.hint
}

/**
 * Project the help sections: keybinding groups from KEYBINDINGS, the
 * contextual approval keys, and the command roster rows.
 * @param commands - the merged harness + local roster the palette shows.
 */
export function helpSections(commands: readonly PaletteCommand[]): readonly HelpSection[] {
  const sections: HelpSection[] = []
  for (const { group, title } of KEY_GROUP_TITLES) {
    const rows = KEYBINDINGS
      .filter((binding) => binding.group === group)
      .map(bindingLabel)
      .filter((label) => label !== '')
    sections.push({ title, rows })
  }
  sections.push({ title: 'Approvals', rows: [APPROVAL_HINT] })
  const commandRows = commands.map((command) => {
    const alias = command.aliases?.length === 1 ? ` (alias /${command.aliases[0]})` : ''
    return `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}${alias} — ${command.description}`
  })
  sections.push({ title: 'Commands', rows: [...PALETTE_DOCS, ...commandRows] })
  return sections
}

/** Flatten sections into one ordered line stream for the overlay window. */
export function overlayLines(sections: readonly HelpSection[]): readonly HelpLine[] {
  const lines: HelpLine[] = []
  for (const section of sections) {
    lines.push({ kind: 'section', text: section.title })
    for (const row of section.rows) lines.push({ kind: 'row', text: row })
  }
  return lines
}
