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
import type { Key } from 'ink'
import type { Agent, AgentHandle, AgentStatus, AssistantStreamFrame, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionRecord, SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { matchApprovalKey, matchKey } from './keys.js'
import { clampScroll, clampTop, composerRows, transcriptViewport } from './scroll.js'
import { commandLine, filterCommands, isFreshPosition, mergeCommands, palettePick } from './commands.js'
import type { PaletteCommand } from './commands.js'
import { helpSections, overlayLines } from './help.js'
import type { HelpLine } from './help.js'
import { applySessionEvent, createProjection, createStreamProjector, echoUser, findToolPart, nextFocusCallId, summarizeArgs, turnActivity } from './projection.js'
import type { Projection, StreamProjector } from './projection.js'
import { createApprovalQueue } from './approval.js'
import type { ApprovalDecision, ApprovalPrompt } from './approval.js'
import { confirmationPrompt, isAlreadyDeleted, moveSelection, needsConfirmation, titlesFrom, toSidebarEntries } from './sessions.js'
import type { PendingAction, SidebarEntry } from './sessions.js'
import type { TuiStartupService } from './startup.js'
import { theme } from './theme.js'
import { APPROVAL_BANNER_ROWS, ApprovalBanner, Composer, CommandPalette, Footer, Header, HELP_CHROME_ROWS, HelpOverlay, PALETTE_MAX_ROWS, SIDEBAR_WIDTH, Sidebar, Transcript, renderLines } from './ui.js'
import type { Notice, SessionInfo, SessionStatus } from './ui.js'

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
  /**
   * Loud refusal reason when the run's flag-seeded model selection cannot
   * serve (unknown model or provider); null means proceed. Only flag-seeded
   * selections are checked — composed defaults are the harness's own.
   */
  checkModelSelection(): Promise<string | null>
  listCommands(agent: Agent): readonly CommandDescriptor[]
  executeCommand(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined>
  on(event: 'session/event', listener: (session: Session, event: SessionEvent) => void): () => void
  on(event: 'agent/status', listener: (payload: { agent: Agent; status: AgentStatus }) => void): () => void
  on(event: 'agent/assistant-stream', listener: (payload: { agent: Agent; frame: AssistantStreamFrame }) => void): () => void
  /** Answer one `approval/request` waterfall ask; `next` delegates foreign agents. */
  onApproval(listener: (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>): () => void
}

type OpenRequest = { readonly kind: 'new' } | { readonly kind: 'resume'; readonly id: SessionId }

/** What one openSession attempt settled to; 'rejected' is the flag-gate refusal. */
type OpenOutcome =
  | { readonly kind: 'opened' }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
  /** A newer open or unmount superseded this attempt; its result is moot. */
  | { readonly kind: 'stale' }

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App({ services, startup, onDone }: { services: HarnessServices; startup: TuiStartupService; onDone: () => void }): JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [notices, setNotices] = useState<Notice[]>([])
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
  // Slash-command palette: query, selection, and the roster it filters.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('/')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [commands, setCommands] = useState<readonly PaletteCommand[]>(() => mergeCommands([]))
  // Help overlay: open state, the projected lines, and the scroll position.
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpLines, setHelpLines] = useState<readonly HelpLine[]>([])
  const [helpTop, setHelpTop] = useState(0)
  // A harness slash command executing without a turn (e.g. /compact).
  const [busyCommand, setBusyCommand] = useState<string | null>(null)
  const commandAbortRef = useRef<AbortController | null>(null)
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
  const startupRef = useRef(startup)
  // The workspace this boot lists and creates sessions for.
  const workspaceRef = useRef(process.cwd())
  // Stale-open guard: a slow create/resume loses to any newer request or to unmount.
  const openGenerationRef = useRef(0)
  const unmountedRef = useRef(false)
  projectionRef.current ??= createProjection()
  streamRef.current ??= createStreamProjector(projectionRef.current)
  const bump = (): void => setTick((tick) => tick + 1)
  const notify = (text: string, error = false): void => {
    setNotices((prev) => [...prev, { text, ...error ? { error: true } : {} }])
  }

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

  /** The merged harness + local roster for the active agent. */
  const currentRoster = (): readonly PaletteCommand[] => {
    const agent = agentRef.current
    if (agent === null) return mergeCommands([])
    try {
      return mergeCommands(servicesRef.current.listCommands(agent))
    } catch (error) {
      notify(`command list failed: ${errorMessage(error)}`, true)
      return mergeCommands([])
    }
  }

  const openHelp = (): void => {
    setHelpLines(overlayLines(helpSections(currentRoster())))
    setHelpTop(0)
    setHelpOpen(true)
  }

  const openPalette = (): void => {
    setCommands(currentRoster())
    setPaletteQuery('/')
    setPaletteIndex(0)
    setPaletteOpen(true)
  }

  const closePalette = (): void => setPaletteOpen(false)

  /**
   * Run one palette command. Local rows are UI actions; harness rows execute
   * through ctx.commands.execute against the active agent and surface the
   * handler's own result text as a transcript notice.
   */
  const runSlashCommand = async (command: PaletteCommand, args: string): Promise<void> => {
    if (command.source === 'local') {
      if (command.id === 'sessions') {
        if (!sidebarOpen) setSidebarOpen(true)
        void refreshSessions()
        return
      }
      openHelp()
      return
    }
    const agent = agentRef.current
    if (agent === null) {
      notify(`no session yet — /${command.name} needs the active session`, true)
      return
    }
    const controller = new AbortController()
    commandAbortRef.current = controller
    setBusyCommand(command.name)
    try {
      const execution = await servicesRef.current.executeCommand(agent, commandLine(command.name, args), controller.signal)
      const result = execution?.result
      if (result?.kind === 'success') {
        if (result.text !== undefined) notify(result.text)
      } else if (result?.kind === 'error') {
        notify(result.text, true)
      } else {
        notify(`/${command.name} is not available in this session`, true)
      }
    } catch (error) {
      // Unmount aborts the in-flight command for exit; the app is gone by the
      // time the rejection lands, so no notice may reach it.
      if (unmountedRef.current) return
      if (controller.signal.aborted) notify(`/${command.name} cancelled`)
      else notify(`/${command.name} failed: ${errorMessage(error)}`, true)
    } finally {
      commandAbortRef.current = null
      if (!unmountedRef.current) setBusyCommand(null)
    }
  }

  /** Enter in the palette: the armed command wins, else the highlighted row. */
  const runPaletteSelection = (): void => {
    const pick = palettePick(commands, paletteQuery.slice(1), paletteIndex)
    closePalette()
    if (pick === undefined) return
    void runSlashCommand(pick.command, pick.args)
  }

  const movePaletteSelection = (delta: number): void => {
    const matches = filterCommands(commands, paletteQuery.slice(1))
    setPaletteIndex((current) => moveSelection(current < 0 ? 0 : current, delta, matches.length))
  }

  /** Keys while the palette owns the composer slot. */
  const handlePaletteKey = (ch: string, key: Key): void => {
    switch (matchKey(ch, key)) {
      case 'quit':
        exit()
        return
      case 'submit':
        runPaletteSelection()
        return
      case 'interrupt':
        closePalette()
        return
      case 'scroll-up':
      case 'page-up':
        movePaletteSelection(-1)
        return
      case 'scroll-down':
      case 'page-down':
        movePaletteSelection(1)
        return
      case 'backspace':
        if (paletteQuery === '/') closePalette()
        else setPaletteQuery((query) => query.slice(0, -1))
        setPaletteIndex(0)
        return
      case 'help':
      case 'text':
        setPaletteQuery((query) => query + ch)
        setPaletteIndex(0)
        return
      default:
        return
    }
  }

  /**
   * Open (create or resume) one session and attach its event subscriptions.
   * The model gate runs BEFORE any teardown, so a refused flag selection
   * leaves a live session untouched; teardown of the previous session only
   * starts once the harness call is about to happen. Outcomes report back:
   * 'opened' after the subscriptions attach, 'rejected' for the gate, and
   * 'failed' with the harness error when create/resume itself throws (the
   * previous session is already gone by then — callers decide the next move).
   */
  const openSession = async (request: OpenRequest): Promise<OpenOutcome> => {
    const harness = servicesRef.current
    const gateReason = await harness.checkModelSelection()
    if (gateReason !== null) return { kind: 'rejected', reason: gateReason }
    const generation = ++openGenerationRef.current
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
        return { kind: 'stale' }
      }
      const agent = handle.agent
      agentRef.current = agent
      handleRef.current = handle
      const projection = projectionRef.current
      const stream = streamRef.current
      if (!projection || !stream) return { kind: 'stale' }
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
      setSession({
        id: agent.session.id,
        model: agent.options.model,
        provider: agent.options.provider,
        title,
        cwd: agent.session.header.cwd ?? workspaceRef.current,
      })
      setStatus('idle')
      bump()
      notify(request.kind === 'new' ? `session ${agent.session.id} started` : `session ${agent.session.id} resumed`)
      await refreshSessions()
      setSelectedId(agent.session.id)
      return { kind: 'opened' }
    } catch (error) {
      if (generation !== openGenerationRef.current || unmountedRef.current) return { kind: 'stale' }
      setStatus('failed')
      return { kind: 'failed', reason: errorMessage(error) }
    }
  }

  /** One failed/rejected open: the loud notice, and a failed status when no session survives. */
  const reportOpenFailure = (outcome: { readonly kind: 'rejected' | 'failed'; readonly reason: string }): void => {
    notify(`failed to open session: ${outcome.reason}`, true)
    if (agentRef.current === null) setStatus('failed')
  }

  const runAction = async (action: PendingAction): Promise<void> => {
    const runOpen = async (request: OpenRequest): Promise<void> => {
      const outcome = await openSession(request)
      if (outcome.kind === 'rejected' || outcome.kind === 'failed') reportOpenFailure(outcome)
    }
    switch (action.kind) {
      case 'new':
        await runOpen({ kind: 'new' })
        return
      case 'open':
        await runOpen({ kind: 'resume', id: action.id })
        return
      case 'delete': {
        // The active session's agent handle holds its write claim, and
        // sessionPersistence.delete refuses owned ids: switch away first so
        // the open teardown disposes the handle before the delete.
        if (agentRef.current?.session.id === action.id) {
          const next = sessions.find((entry) => entry.id !== action.id)
          await runOpen(next === undefined ? { kind: 'new' } : { kind: 'resume', id: next.id })
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
    if (busyCommand !== null) {
      notify(`/${busyCommand} is running — wait for it or press esc to cancel`)
      return
    }
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

  // Boot opens what the invocation asked for: `--resume <id>` when given, a
  // fresh session otherwise. A refused model gate stays loud with no session;
  // a failed resume (missing/invalid id) falls back to a fresh session so the
  // boot is never a dead end. Later opens come from key actions.
  useEffect(() => {
    const boot = async (): Promise<void> => {
      const initial = startupRef.current
      if (initial.resume === undefined) {
        const outcome = await openSession({ kind: 'new' })
        if (outcome.kind === 'rejected' || outcome.kind === 'failed') reportOpenFailure(outcome)
        return
      }
      const resumed = await openSession({ kind: 'resume', id: initial.resume })
      if (resumed.kind === 'opened' || resumed.kind === 'stale') return
      if (resumed.kind === 'rejected') {
        reportOpenFailure(resumed)
        return
      }
      const fresh = await openSession({ kind: 'new' })
      if (fresh.kind === 'rejected' || fresh.kind === 'failed') {
        reportOpenFailure(fresh)
        return
      }
      if (fresh.kind === 'stale') return
      notify(`session ${initial.resume} could not be resumed (${resumed.reason}) — started a fresh session`, true)
    }
    void boot()
  }, [])

  useEffect(() => {
    return () => {
      unmountedRef.current = true
      openGenerationRef.current += 1
      commandAbortRef.current?.abort()
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
    if (status !== 'running' && busyCommand === null) return
    const timer = setInterval(() => setSpinner((frame) => (frame + 1) % SPINNER_FRAMES.length), 80)
    return () => {
      clearInterval(timer)
    }
  }, [status, busyCommand])

  const mainCols = sidebarOpen ? Math.max(20, size.cols - SIDEBAR_WIDTH) : size.cols
  const paletteMatches = paletteOpen ? filterCommands(commands, paletteQuery.slice(1)) : []
  // The palette owns the composer slot while open: one query row plus the
  // match list (an empty list still shows one no-match row).
  const bottomRows = paletteOpen
    ? 1 + (paletteMatches.length === 0 ? 1 : Math.min(paletteMatches.length, PALETTE_MAX_ROWS))
    : composerRows(input, mainCols)
  const viewport = Math.max(
    1,
    transcriptViewport(size.rows, bottomRows)
      - (pending === null ? 0 : 1)
      - (approvalHead === null ? 0 : APPROVAL_BANNER_ROWS),
  )
  const helpViewportRows = Math.max(1, size.rows - HELP_CHROME_ROWS)
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
    // The help overlay owns every key except closing and quitting; composer
    // text and controller state stay untouched underneath it.
    if (helpOpen) {
      switch (matchKey(ch, key)) {
        case 'quit':
          exit()
          return
        case 'interrupt':
        case 'help':
          setHelpOpen(false)
          return
        case 'scroll-up':
          setHelpTop((top) => clampTop(top - 1, helpLines.length, helpViewportRows))
          return
        case 'scroll-down':
          setHelpTop((top) => clampTop(top + 1, helpLines.length, helpViewportRows))
          return
        case 'page-up':
          setHelpTop((top) => clampTop(top - helpViewportRows, helpLines.length, helpViewportRows))
          return
        case 'page-down':
          setHelpTop((top) => clampTop(top + helpViewportRows, helpLines.length, helpViewportRows))
          return
        default:
          return
      }
    }
    if (paletteOpen) {
      handlePaletteKey(ch, key)
      return
    }
    switch (matchKey(ch, key)) {
      case 'submit': {
        if (busyCommand !== null) {
          notify(`/${busyCommand} is running — wait for it or press esc to cancel`)
          return
        }
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
        // Esc cancels a running slash command (its signal aborts the handler).
        if (busyCommand !== null) {
          commandAbortRef.current?.abort()
          return
        }
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
      // '?' opens help at an empty input; mid-text it stays a plain character.
      case 'help':
        if (input === '' && pending === null && approvalHead === null) {
          openHelp()
          return
        }
        setInput((prev) => prev + '?')
        return
      case 'text': {
        // A fresh '/' while idle opens the command palette instead of typing.
        if (
          ch === '/' && isFreshPosition(input) && status === 'idle'
          && pending === null && approvalHead === null && busyCommand === null
        ) {
          openPalette()
          return
        }
        setInput((prev) => prev + ch)
        return
      }
      case null:
        return
    }
  })

  if (helpOpen) {
    return <HelpOverlay lines={helpLines} top={helpTop} rows={size.rows} cols={size.cols} />
  }

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
          busyCommand={busyCommand}
        />
        {paletteOpen ? (
          <CommandPalette query={paletteQuery} commands={paletteMatches} selected={paletteIndex} cols={mainCols} />
        ) : (
          <Composer input={input} busy={status === 'running' || busyCommand !== null} />
        )}
      </Box>
    </Box>
  )
}
