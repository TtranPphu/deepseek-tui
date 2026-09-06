import { describe, expect, it } from 'vitest'
import { createApprovalQueue } from './approval.js'
import type { ApprovalPrompt } from './approval.js'

function prompt(toolName: string, callId?: string): ApprovalPrompt {
  return callId === undefined ? { toolName } : { toolName, callId }
}

describe('approval queue', () => {
  it('pends on request and grants on approve', () => {
    const q = createApprovalQueue()
    expect(q.head).toBeNull()
    q.request(prompt('bash', 'c1'))
    expect(q.head).toEqual({ toolName: 'bash', callId: 'c1' })
    expect(q.decide()).toEqual({ toolName: 'bash', callId: 'c1' })
    expect(q.head).toBeNull()
  })

  it('decides queued requests in arrival order (deny resolves the same way)', () => {
    const q = createApprovalQueue()
    q.request(prompt('bash', 'c1'))
    q.request(prompt('fs_write', 'c2'))
    expect(q.size).toBe(2)
    expect(q.decide()?.callId).toBe('c1')
    expect(q.head?.callId).toBe('c2')
    expect(q.decide()?.callId).toBe('c2')
  })

  it('ignores late or duplicate responses on an empty queue', () => {
    const q = createApprovalQueue()
    expect(q.decide()).toBeNull()
    q.request(prompt('bash'))
    q.decide()
    expect(q.decide()).toBeNull()
    expect(q.head).toBeNull()
  })

  it('withdraws a signal-aborted request from any position', () => {
    const q = createApprovalQueue()
    const first = prompt('bash', 'c1')
    const second = prompt('fs_write', 'c2')
    q.request(first)
    q.request(second)
    expect(q.withdraw(second)).toBe(true)
    expect(q.head).toBe(first)
    expect(q.withdraw(first)).toBe(true)
    expect(q.head).toBeNull()
    expect(q.withdraw(first)).toBe(false)
  })

  it('clear returns every pending prompt for teardown settlement', () => {
    const q = createApprovalQueue()
    q.request(prompt('bash', 'c1'))
    q.request(prompt('bash', 'c2'))
    expect(q.clear()).toHaveLength(2)
    expect(q.head).toBeNull()
  })
})
