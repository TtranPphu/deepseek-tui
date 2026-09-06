// The app controller: owns multi-session lifecycle, harness event
// subscriptions, and every key-driven state transition. Events fold into the
// pure projection in projection.ts; the sidebar list model lives in
// sessions.ts; components in ui.tsx stay dumb. Event/status subscriptions are
// scoped to the ACTIVE session only — a switch tears them down with the old
// handle and resets the projection before replaying the new log.
import { randomUUID } from 'node:crypto'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type { Agent, AgentHandle, AgentStatus, AssistantStreamFrame, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionRecord, SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { matchApprovalKey, matchKey } from './keys.js'
import { clampScroll, composerRows, transcriptViewport } from './scroll.js'
import { applySessionEvent, createProjection, createStreamProjector, echoUser, findToolPart, nextFocusCallId, summarizeArgs, turnActivity } from './projection.js'
import type { Projection, StreamProjector } from './projection.js'
import { createApprovalQueue } from './approval.js'
import type { ApprovalDecision, ApprovalPrompt } from './approval.js'
import { confirmationPrompt, isAlreadyDeleted, moveSelection, needsConfirmation, titlesFrom, toSidebarEntries } from './sessions.js'
import type { PendingAction, SidebarEntry } from './sessions.js'
import { theme } from './theme.js'
import { APPROVAL_BANNER_ROWS, ApprovalBanner, Composer, Footer, Header, SIDEBAR_WIDTH, Sidebar, Transcript, renderLines } from './ui.js'
import type { SessionInfo, SessionStatus } from './ui.js'

/**
 * The harness I/O surface the controller uses. A plain facade of bound
 * functions built in index.tsx — never the raw Cordis ctx: React's dev
 * reconciler walks fiber props/deps when logging, and reading properties off
 * the ctx proxy throws without an inject declaration.
 */
export interface HarnessServices {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(id: SessionId): Promise<AgentHandle>
  list(): Promise<readonly SessionRecord[]>
  readTitles(ids: readonly SessionId[]): Promise<readonly SessionTitleObservationResult[]>
  deleteSession(id: SessionId): Promise<void>
  on(event: 'session/event', listener: (session: Session, event: SessionEvent) => void): () => void
  on(event: 'agent/status', listener: (payload: { agent: Agent; status: AgentStatus }) => void): () => void
  on(event: 'agent/assistant-stream', listener: (payload: { agent: Agent; frame: AssistantStreamFrame }) => void): () => void
  /** Answer one `approval/request` waterfall ask; `next` delegates foreign agents. */
  onApproval(listener: (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>): () => void
}

type OpenRequest = { readonly kind: 'new' } | { readonly kind: 'resume'; readonly id: SessionId }

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App({ services, onDone }: { services: HarnessServices; onDone: () => void }): JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [notices, setNotices] = useState<string[]>([])
  const [, setTick] = useState(0)
  const [input, setInput] = useState('')
  const [scroll, setScroll] = useState(0)
  const [status, setStatus] = useState<SessionStatus>('connecting')
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [spinner, setSpinner] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessions, setSessions] = useState<readonly SidebarEntry[]>([])
  const [selectedId, setSelectedId] = useState<SessionId | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [approvalHead, setApprovalHead] = useState<ApprovalPrompt | null>(null)
  const [focusedCallId, setFocusedCallId] = useState<string | null>(null)
  // Resize re-render: Ink redraws on its own, but the viewport math reads
  // stdout.rows/columns, so track them as state to guarantee a relayout.
  // `||` catches 0: a degenerate pty (script, CI) reports 0x0 and would
  // otherwise blank every region.
  const [size, setSize] = useState({ rows: stdout?.rows || 24, cols: stdout?.columns || 80 })
  const agentRef = useRef<Agent | null>(null)
  const handleRef = useRef<AgentHandle | null>(null)
  const sessionDisposersRef = useRef<(() => void)[]>([])
  const projectionRef = useRef<Projection | null>(null)
  const streamRef = useRef<StreamProjector | null>(null)
  const approvalQueueRef = useRef(createApprovalQueue())
  // Each queued prompt pairs with the resolver of the promise the answerer
  // returned to the harness waterfall.
  const approvalResolversRef = useRef(new Map<ApprovalPrompt, (decision: ApprovalDecision) => void>())
  const onDoneRef = useRef(onDone)
  const servicesRef = useRef(services)
  // The workspace this boot lists and creates sessions for.
  const workspaceRef = useRef(process.cwd())
  // Stale-open guard: a slow create/resume loses to any newer request or to unmount.
  const openGenerationRef = useRef(0)
  const unmountedRef = useRef(false)
  projectionRef.current ??= createProjection()
  streamRef.current ??= createStreamProjector(projectionRef.current)
  const bump = (): void => setTick((tick) => tick + 1)
  const notify = (text: string): void => setNotices((prev) => [...prev, text])

  // Approval state transitions: the queue in approval.ts owns ordering; these
  // settle the paired harness promise and republish the head to the renderer.
  const resolveApproval = (prompt: ApprovalPrompt, decision: ApprovalDecision): void => {
    const resolve = approvalResolversRef.current.get(prompt)
    approvalResolversRef.current.delete(prompt)
    setApprovalHead(approvalQueueRef.current.head)
    resolve?.(decision)
  }
  /** User key decision on the queue head; null pop = late/duplicate, ignored. */
  const decideApproval = (decision: ApprovalDecision): void => {
    const prompt = approvalQueueRef.current.decide()
    if (prompt !== null) resolveApproval(prompt, decision)
  }
  /** The harness withdrew a request (its signal aborted): settle cancelled. */
  const withdrawApproval = (prompt: ApprovalPrompt): void => {
    if (approvalQueueRef.current.withdraw(prompt)) resolveApproval(prompt, 'cancelled')
  }
  /** Session teardown: settle every outstanding ask so no answerer hangs. */
  const cancelAllApprovals = (): void => {
    const leftover = approvalQueueRef.current.clear()
    for (const prompt of leftover) approvalResolversRef.current.get(prompt)?.('cancelled')
    approvalResolversRef.current.clear()
    setApprovalHead(null)
  }

  const refreshSessions = async (): Promise<void> => {
    const harness = servicesRef.current
    try {
      const records = await harness.list()
      const ids = records.filter((record) => record.header.cwd === workspaceRef.current).map((record) => record.header.id)
      const titles = titlesFrom(ids.length === 0 ? [] : await harness.readTitles(ids))
      const entries = toSidebarEntries(records, titles, workspaceRef.current)
      setSessions(entries)
      setSelectedId((prev) => {
        if (prev !== null && entries.some((entry) => entry.id === prev)) return prev
        const active = agentRef.current?.session.id
        return entries.find((entry) => entry.id === active)?.id ?? entries[0]?.id ?? null
      })
    } catch (error) {
      notify(`session list failed: ${errorMessage(error)}`)
    }
  }

  const openSession = async (request: OpenRequest): Promise<void> => {
    const generation = ++openGenerationRef.current
    const harness = servicesRef.current
    for (const dispose of sessionDisposersRef.current.splice(0)) dispose()
    const oldHandle = handleRef.current
    handleRef.current = null
    agentRef.current = null
    projectionRef.current = createProjection()
    streamRef.current = createStreamProjector(projectionRef.current)
    cancelAllApprovals()
    setPending(null)
    setFocusedCallId(null)
    setNotices([])
    setScroll(0)
    setSession(null)
    setStatus('connecting')
    bump()
    if (oldHandle !== null) await oldHandle.dispose()
    try {
      const handle = request.kind === 'new'
        ? await harness.create({ sessionId: randomUUID() as SessionId, meta: { cwd: workspaceRef.current } })
        : await harness.resume(request.id)
      if (generation !== openGenerationRef.current || unmountedRef.current) {
        await handle.dispose()
        return
      }
      const agent = handle.agent
      agentRef.current = agent
      handleRef.current = handle
      const projection = projectionRef.current
      const stream = streamRef.current
      if (!projection || !stream) return
      // Replay the persisted log through the same fold live events use.
      const events = agent.session.snapshotEvents()
      for (const event of events) applySessionEvent(projection, event)
      const title = events.findLast((event): event is SessionEvent<'session/title'> => event.type === 'session/title')?.data.title
      sessionDisposersRef.current = [
        harness.on('session/event', (eventSession, event) => {
          if (eventSession.id !== agent.session.id) return
          applySessionEvent(projection, event)
          if (event.type === 'session/title') {
            const nextTitle = event.data.title
            setSession((prev) => (prev === null ? prev : { ...prev, title: nextTitle }))
            void refreshSessions()
          }
          bump()
        }),
        harness.on('agent/assistant-stream', (payload) => {
          if (payload.agent.id !== agent.session.id) return
          stream.apply(payload.frame)
          bump()
        }),
        harness.on('agent/status', (payload) => {
          if (payload.agent.id !== agent.session.id) return
          setStatus(payload.status)
        }),
        // The TUI is the profile's approval answerer for its own agent;
        // foreign agents (subagent children) delegate down the waterfall.
        harness.onApproval((req, next) => {
          if (req.agent.id !== agent.session.id) return next()
          return new Promise<ApprovalOutcome>((resolve) => {
            const prompt: ApprovalPrompt = {
              toolName: req.toolName,
              ...req.callId !== undefined ? { callId: req.callId } : {},
              ...req.reason !== undefined ? { reason: req.reason } : {},
            }
            approvalQueueRef.current.request(prompt)
            approvalResolversRef.current.set(prompt, resolve)
            setApprovalHead(approvalQueueRef.current.head)
            // Abort = the harness withdrew the question (turn cancelled,
            // agent disposed): settle cancelled and drop the banner.
            req.signal?.addEventListener('abort', () => {
              withdrawApproval(prompt)
            }, { once: true })
          })
        }),
      ]
      setSession({ id: agent.session.id, model: agent.options.model, provider: agent.options.provider, title })
      setStatus('idle')
      bump()
      notify(request.kind === 'new' ? `session ${agent.session.id} started` : `session ${agent.session.id} resumed`)
      await refreshSessions()
      setSelectedId(agent.session.id)
    } catch (error) {
      if (generation !== openGenerationRef.current || unmountedRef.current) return
      setStatus('failed')
      notify(`failed to open session: ${errorMessage(error)}`)
    }
  }

  const runAction = async (action: PendingAction): Promise<void> => {
    switch (action.kind) {
      case 'new':
        await openSession({ kind: 'new' })
        return
      case 'open':
        await openSession({ kind: 'resume', id: action.id })
        return
      case 'delete': {
        // The active session's agent handle holds its write claim, and
        // sessionPersistence.delete refuses owned ids: switch away first so
        // the open teardown disposes the handle before the delete.
        if (agentRef.current?.session.id === action.id) {
          const next = sessions.find((entry) => entry.id !== action.id)
          await openSession(next === undefined ? { kind: 'new' } : { kind: 'resume', id: next.id })
        }
        try {
          await servicesRef.current.deleteSession(action.id)
        } catch (error) {
          if (isAlreadyDeleted(error)) {
            await refreshSessions()
            return
          }
          notify(`delete failed: ${errorMessage(error)}`)
          return
        }
        notify('session deleted')
        await refreshSessions()
        return
      }
    }
  }

  const requestAction = (action: PendingAction): void => {
    if (needsConfirmation(action, status === 'running')) {
      setPending(action)
      return
    }
    void runAction(action)
  }

  const moveSidebarSelection = (delta: number): void => {
    const current = sessions.findIndex((entry) => entry.id === selectedId)
    const next = moveSelection(current < 0 ? 0 : current, delta, sessions.length)
    setSelectedId(sessions[next]?.id ?? null)
  }

  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => setSize({ rows: stdout.rows || 24, cols: stdout.columns || 80 })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  useEffect(() => {
    void openSession({ kind: 'new' })
    // Boot opens exactly one session; later opens come from key actions.
  }, [])

  useEffect(() => {
    return () => {
      unmountedRef.current = true
      openGenerationRef.current += 1
      for (const dispose of sessionDisposersRef.current.splice(0)) dispose()
      const handle = handleRef.current
      handleRef.current = null
      // A handle close drains the session log durably; exit only after it so
      // the session materializes for the next boot's sidebar.
      const done = handle === null ? Promise.resolve() : handle.dispose()
      void done.then(() => {
        onDoneRef.current()
      })
    }
  }, [])

  useEffect(() => {
    if (status !== 'running') return
    const timer = setInterval(() => setSpinner((frame) => (frame + 1) % SPINNER_FRAMES.length), 80)
    return () => {
      clearInterval(timer)
    }
  }, [status])

  const mainCols = sidebarOpen ? Math.max(20, size.cols - SIDEBAR_WIDTH) : size.cols
  const composerLineCount = composerRows(input, mainCols)
  const viewport = Math.max(
    1,
    transcriptViewport(size.rows, composerLineCount)
      - (pending === null ? 0 : 1)
      - (approvalHead === null ? 0 : APPROVAL_BANNER_ROWS),
  )
  const spinnerGlyph = SPINNER_FRAMES[spinner] ?? '⠋'
  const projection = projectionRef.current
  const approvalTool = approvalHead?.callId !== undefined && projection ? findToolPart(projection, approvalHead.callId) : null
  const lines = renderLines(notices, projection, mainCols, spinnerGlyph, {
    focusedCallId,
    approvalCallId: approvalHead?.callId ?? null,
  })

  // Autoscroll is the default (offset 0 pins to the tail); once the user
  // scrolls up, grow their from-bottom offset with new content so the reading
  // position stays put until they scroll back down.
  const lineCountRef = useRef(lines.length)
  useEffect(() => {
    const previous = lineCountRef.current
    lineCountRef.current = lines.length
    if (scroll > 0 && lines.length > previous) {
      setScroll(clampScroll(scroll + (lines.length - previous), lines.length, viewport))
    }
  }, [lines.length, scroll, viewport])

  useInput((ch, key) => {
    // While an approval pends, its decision keys win over composer text.
    if (approvalHead !== null) {
      const decision = matchApprovalKey(ch, key)
      if (decision !== null) {
        decideApproval(decision === 'approve' ? 'allowed-once' : 'rejected')
        return
      }
    }
    switch (matchKey(ch, key)) {
      case 'submit': {
        if (pending !== null) {
          const action = pending
          setPending(null)
          void runAction(action)
          return
        }
        if (sidebarOpen) {
          const entry = sessions.find((item) => item.id === selectedId)
          if (entry !== undefined && entry.id !== agentRef.current?.session.id) {
            requestAction({ kind: 'open', id: entry.id })
            return
          }
        }
        const agent = agentRef.current
        // Submit doubles as stop while a turn runs — including one blocked on
        // an approval, mirroring Esc (the abort settles the ask 'cancelled').
        if (status === 'running' || approvalHead !== null) {
          agent?.cancel({ kind: 'user' })
          return
        }
        const text = input.trim()
        setInput('')
        if (!text) return
        if (!agent) {
          notify('no session yet')
          return
        }
        const projection = projectionRef.current
        if (!projection) return
        echoUser(projection, text)
        bump()
        // ponytail: dsh-llm's createUserMessage inlined — harness packages are
        // type-only here (the profile process resolves no harness modules), so
        // the literal mirrors the factory: fresh id, user source, frozen.
        const message: UserMessage = Object.freeze({
          id: randomUUID() as MessageId,
          role: 'user',
          content: [{ type: 'text' as const, text }],
          source: { kind: 'user' as const },
        })
        try {
          agent.followup(message)
        } catch (error) {
          notify(`turn failed: ${errorMessage(error)}`)
        }
        return
      }
      case 'newline':
        setInput((prev) => prev + '\n')
        return
      case 'interrupt': {
        if (pending !== null) {
          setPending(null)
          return
        }
        if (focusedCallId !== null) {
          setFocusedCallId(null)
          return
        }
        const agent = agentRef.current
        // Esc during an approval cancels the turn: the abort withdraws the
        // question (harness settles it 'cancelled') and the turn ends
        // aborted — a deny that never leaves a zombie turn behind.
        if ((status === 'running' || approvalHead !== null) && agent) {
          agent.cancel({ kind: 'user' })
          return
        }
        if (sidebarOpen) {
          setSidebarOpen(false)
          return
        }
        exit()
        return
      }
      case 'quit':
        exit()
        return
      case 'expand-focus': {
        const projection = projectionRef.current
        if (!projection) return
        setFocusedCallId((prev) => nextFocusCallId(projection, prev))
        return
      }
      case 'toggle-sidebar': {
        const next = !sidebarOpen
        setSidebarOpen(next)
        if (next) void refreshSessions()
        return
      }
      case 'new-session':
        requestAction({ kind: 'new' })
        return
      case 'delete-session': {
        if (!sidebarOpen) return
        const entry = sessions.find((item) => item.id === selectedId)
        if (entry !== undefined) requestAction({ kind: 'delete', id: entry.id })
        return
      }
      case 'scroll-up':
        if (sidebarOpen) {
          moveSidebarSelection(-1)
          return
        }
        setScroll((prev) => clampScroll(prev + 1, lines.length, viewport))
        return
      case 'scroll-down':
        if (sidebarOpen) {
          moveSidebarSelection(1)
          return
        }
        setScroll((prev) => clampScroll(prev - 1, lines.length, viewport))
        return
      case 'page-up':
        setScroll((prev) => clampScroll(prev + viewport - 1, lines.length, viewport))
        return
      case 'page-down':
        setScroll((prev) => clampScroll(prev - (viewport - 1), lines.length, viewport))
        return
      case 'backspace':
        setInput((prev) => prev.slice(0, -1))
        return
      case 'text':
        setInput((prev) => prev + ch)
        return
      case null:
        return
    }
  })

  return (
    <Box flexDirection="row" height={size.rows}>
      {sidebarOpen ? (
        <Sidebar
          entries={sessions}
          selectedId={selectedId}
          activeId={session?.id ?? null}
          now={Date.now()}
          rows={size.rows}
        />
      ) : null}
      <Box flexDirection="column" width={mainCols}>
        <Header session={session} cols={mainCols} />
        <Transcript lines={lines} viewport={viewport} scroll={scroll} />
        {approvalHead !== null ? (
          <ApprovalBanner prompt={approvalHead} command={approvalTool === null ? null : summarizeArgs(approvalTool.args)} />
        ) : null}
        {pending !== null ? (
          <Text color={theme.colors.error} wrap="truncate-end">{` ${confirmationPrompt(pending)}`}</Text>
        ) : null}
        <Footer
          status={status}
          scroll={scroll}
          activity={projection ? turnActivity(projection) : null}
          awaitingApproval={approvalHead !== null}
          spinner={spinnerGlyph}
        />
        <Composer input={input} busy={status === 'running'} />
      </Box>
    </Box>
  )
}
