// Keybinding table: the single visible source for every key the app handles.
// The footer help line renders from this table and the input controller
// dispatches through matchKey — no key literals in handlers or components.
import type { Key } from 'ink'

export type KeyAction =
  | 'submit'
  | 'interrupt'
  | 'quit'
  | 'scroll-up'
  | 'scroll-down'
  | 'page-up'
  | 'page-down'
  | 'backspace'
  | 'text'

export interface KeyBinding {
  readonly action: Exclude<KeyAction, 'text'>
  /** Footer help text; empty for bindings covered by a sibling's hint. */
  readonly hint: string
  readonly match: (ch: string, key: Key) => boolean
}

export const KEYBINDINGS: readonly KeyBinding[] = [
  { action: 'submit', hint: 'enter send', match: (_ch, key) => key.return },
  { action: 'interrupt', hint: 'esc stop/quit', match: (_ch, key) => key.escape },
  { action: 'quit', hint: 'ctrl+c quit', match: (ch, key) => key.ctrl && ch.toLowerCase() === 'c' },
  { action: 'scroll-up', hint: '↑/↓ scroll', match: (_ch, key) => key.upArrow },
  { action: 'scroll-down', hint: '', match: (_ch, key) => key.downArrow },
  { action: 'page-up', hint: 'pgup/pgdn page', match: (_ch, key) => key.pageUp },
  { action: 'page-down', hint: '', match: (_ch, key) => key.pageDown },
  { action: 'backspace', hint: '', match: (_ch, key) => key.backspace || key.delete },
]

/**
 * Map one raw-mode keypress to an action. Bindings win over text entry;
 * remaining non-control characters are composer text.
 * @param ch - the decoded character(s), possibly a pasted run.
 * @param key - Ink's parsed key flags.
 * @returns the bound action, 'text' for printable input, or null to swallow.
 */
export function matchKey(ch: string, key: Key): KeyAction | null {
  for (const binding of KEYBINDINGS) {
    if (binding.match(ch, key)) return binding.action
  }
  if (ch && !key.ctrl && !key.meta) return 'text'
  return null
}
