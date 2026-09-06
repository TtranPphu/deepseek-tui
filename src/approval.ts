// Pure approval-prompt state machine: a FIFO of pending human decisions over
// the harness's `approval/request` waterfall. One agent turn can hold several
// concurrent asks (parallel tool calls), so requests queue; the controller
// resolves the queue head with the user's key decision and pairs each entry
// with the promise it returned to the harness. No React, no ctx.
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'

/** The decisions the TUI answerer can return; the harness closes the union. */
export type ApprovalDecision = Extract<ApprovalOutcome, 'allowed-once' | 'rejected' | 'cancelled'>

/** One human-visible approval question. */
export interface ApprovalPrompt {
  readonly toolName: string
  /** Links the prompt to the projected tool step when the asker had one. */
  readonly callId?: string
  readonly reason?: string
}

export interface ApprovalQueue {
  /** The prompt awaiting a decision; null when idle. */
  readonly head: ApprovalPrompt | null
  readonly size: number
  /** Enqueue a freshly arrived request. */
  request(prompt: ApprovalPrompt): void
  /**
   * Pop the head for a user decision. Null on an empty queue — a late or
   * duplicate response (e.g. a key press landing after a signal-abort
   * withdrawal) is ignored instead of deciding nothing.
   */
  decide(): ApprovalPrompt | null
  /**
   * Remove a specific entry (identity match) from any position: the harness
   * withdraws a request by aborting its signal, which is not necessarily the
   * head. True when an entry was removed.
   */
  withdraw(prompt: ApprovalPrompt): boolean
  /** Drop everything (session switch); the controller settles the promises. */
  clear(): ApprovalPrompt[]
}

export function createApprovalQueue(): ApprovalQueue {
  let entries: ApprovalPrompt[] = []
  return {
    get head() {
      return entries[0] ?? null
    },
    get size() {
      return entries.length
    },
    request(prompt) {
      entries.push(prompt)
    },
    decide() {
      return entries.shift() ?? null
    },
    withdraw(prompt) {
      const before = entries.length
      entries = entries.filter((entry) => entry !== prompt)
      return entries.length !== before
    },
    clear() {
      return entries.splice(0)
    },
  }
}
