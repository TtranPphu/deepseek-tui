// Keybinding table: the single visible source for every key the app handles.
// The footer help line renders from this table and the input controller
// dispatches through matchKey — no key literals in handlers or components.
import type { Key } from 'ink'

export type KeyAction =
  | 'submit'
  | 'newline'
  | 'interrupt'
  | 'quit'
  | 'toggle-sidebar'
  | 'new-session'
  | 'delete-session'
  | 'expand-focus'
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
  // Newline precedes submit: shift+enter also sets key.return on terminals
  // that report it, and must not submit. Ctrl+J arrives as ch '\n'.
  { action: 'newline', hint: 'ctrl+j newline', match: (ch, key) => ch === '\n' || (key.return && key.shift) },
  { action: 'submit', hint: 'enter send/stop', match: (_ch, key) => key.return },
  { action: 'interrupt', hint: 'esc stop/quit', match: (_ch, key) => key.escape },
  { action: 'quit', hint: 'ctrl+c quit', match: (ch, key) => key.ctrl && ch.toLowerCase() === 'c' },
  { action: 'toggle-sidebar', hint: 'tab sessions', match: (_ch, key) => key.tab },
  { action: 'new-session', hint: 'ctrl+n new', match: (ch, key) => key.ctrl && ch.toLowerCase() === 'n' },
  { action: 'delete-session', hint: 'ctrl+x delete', match: (ch, key) => key.ctrl && ch.toLowerCase() === 'x' },
  // Cycles focus through tool steps (newest first); the focused step renders
  // expanded with full arguments and result. Esc unfocuses before stopping.
  { action: 'expand-focus', hint: 'ctrl+e expand tool', match: (ch, key) => key.ctrl && ch.toLowerCase() === 'e' },
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

// Approval decisions are contextual: while an approval prompt is pending the
// composer yields these keys, so they live outside the global table (typing
// 'a' must stay text when idle). The harness approval seam grants one shot
// only ('allowed-once'); there is no standing "always allow" outcome or
// policy (policies are 'ask'/'never'), so no always-permit key exists.
// Esc is NOT here on purpose: during an approval it keeps its global meaning
// (stop the turn) — agent.cancel aborts the request's signal, the harness
// settles the question 'cancelled', and the turn ends aborted, never error.
export type ApprovalKeyAction = 'approve' | 'deny'

/** Hint text rendered inside the approval banner. */
export const APPROVAL_HINT = 'a approve once · d deny · esc stop'

export const APPROVAL_KEYS: readonly { readonly action: ApprovalKeyAction; readonly match: (ch: string, key: Key) => boolean }[] = [
  { action: 'approve', match: (ch, key) => !key.ctrl && !key.meta && ch.toLowerCase() === 'a' },
  { action: 'deny', match: (ch, key) => !key.ctrl && !key.meta && ['d', 'x'].includes(ch.toLowerCase()) },
]

/**
 * Map a keypress to an approval decision while a prompt is pending.
 * @returns the decision, or null to let normal dispatch handle the key.
 */
export function matchApprovalKey(ch: string, key: Key): ApprovalKeyAction | null {
  for (const binding of APPROVAL_KEYS) {
    if (binding.match(ch, key)) return binding.action
  }
  return null
}
