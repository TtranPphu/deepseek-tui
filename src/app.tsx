// The app controller: owns session lifecycle, harness event subscriptions, and
// every key-driven state transition. Events fold into the pure projection in
// projection.ts; components in ui.tsx stay dumb.
import { randomUUID } from 'node:crypto'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Box, useApp, useInput, useStdout } from 'ink'
import type { Agent, AgentHandle, AgentStatus, AssistantStreamFrame, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { matchKey } from './keys.js'
import { clampScroll, composerRows, transcriptViewport } from './scroll.js'
import { applySessionEvent, createProjection, createStreamProjector, echoUser } from './projection.js'
import type { Projection, StreamProjector } from './projection.js'
import { Composer, Footer, Header, Transcript, renderLines } from './ui.js'
import type { SessionInfo, SessionStatus } from './ui.js'

/**
 * The harness I/O surface the controller uses. A plain facade of bound
 * functions built in index.tsx — never the raw Cordis ctx: React's dev
 * reconciler walks fiber props/deps when logging, and reading properties off
 * the ctx proxy throws without an inject declaration.
 */
export interface HarnessServices {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  on(event: 'session/event', listener: (session: Session, event: SessionEvent) => void): () => void
  on(event: 'agent/status', listener: (payload: { agent: Agent; status: AgentStatus }) => void): () => void
  on(event: 'agent/assistant-stream', listener: (payload: { agent: Agent; frame: AssistantStreamFrame }) => void): () => void
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App({ services, onDone }: { services: HarnessServices; onDone: () => void }): JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [notices, setNotices] = useState<string[]>(['opening session…'])
  const [, setTick] = useState(0)
  const [input, setInput] = useState('')
  const [scroll, setScroll] = useState(0)
  const [status, setStatus] = useState<SessionStatus>('connecting')
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [spinner, setSpinner] = useState(0)
  // Resize re-render: Ink redraws on its own, but the viewport math reads
  // stdout.rows/columns, so track them as state to guarantee a relayout.
  // `||` catches 0: a degenerate pty (script, CI) reports 0x0 and would
  // otherwise blank every region.
  const [size, setSize] = useState({ rows: stdout?.rows || 24, cols: stdout?.columns || 80 })
  const agentRef = useRef<Agent | null>(null)
  const handleRef = useRef<AgentHandle | null>(null)
  const projectionRef = useRef<Projection | null>(null)
  const streamRef = useRef<StreamProjector | null>(null)
  const onDoneRef = useRef(onDone)
  const servicesRef = useRef(services)
  projectionRef.current ??= createProjection()
  streamRef.current ??= createStreamProjector(projectionRef.current)
  const bump = (): void => setTick((tick) => tick + 1)
  const notify = (text: string): void => setNotices((prev) => [...prev, text])

  useEffect(() => {
    if (!stdout) return
    const onResize = (): void => setSize({ rows: stdout.rows || 24, cols: stdout.columns || 80 })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  useEffect(() => {
    const harness = servicesRef.current
    let cancelled = false
    const disposers: (() => void)[] = []
    void (async () => {
      try {
        const handle = await harness.create({
          sessionId: randomUUID() as SessionId,
          meta: { cwd: process.cwd() },
        })
        if (cancelled) {
          await handle.dispose()
          return
        }
        const agent = handle.agent
        agentRef.current = agent
        handleRef.current = handle
        const projection = projectionRef.current
        const stream = streamRef.current
        if (!projection || !stream) return
        // Replay the existing log through the same fold live events use.
        for (const event of agent.session.snapshotEvents()) applySessionEvent(projection, event)
        disposers.push(
          harness.on('session/event', (eventSession, event) => {
            if (eventSession.id !== agent.session.id) return
            applySessionEvent(projection, event)
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
        )
        setSession({ id: agent.session.id, model: agent.options.model, provider: agent.options.provider })
        setStatus('idle')
        bump()
        notify(`session ${agent.session.id} started`)
      } catch (error) {
        setStatus('failed')
        notify(`failed to open session: ${errorMessage(error)}`)
      }
    })()
    return () => {
      cancelled = true
      for (const dispose of disposers) dispose()
    }
  }, [])

  useEffect(() => {
    return () => {
      void handleRef.current?.dispose()
      onDoneRef.current()
    }
  }, [])

  useEffect(() => {
    if (status !== 'running') return
    const timer = setInterval(() => setSpinner((frame) => (frame + 1) % SPINNER_FRAMES.length), 80)
    return () => {
      clearInterval(timer)
    }
  }, [status])

  const composerLineCount = composerRows(input, size.cols)
  const viewport = transcriptViewport(size.rows, composerLineCount)
  const lines = renderLines(notices, projectionRef.current, size.cols, SPINNER_FRAMES[spinner] ?? '⠋')

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
    switch (matchKey(ch, key)) {
      case 'submit': {
        const agent = agentRef.current
        if (status === 'running') {
          // Submit doubles as stop while a turn runs.
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
        const agent = agentRef.current
        if (status === 'running' && agent) {
          agent.cancel({ kind: 'user' })
        } else {
          exit()
        }
        return
      }
      case 'quit':
        exit()
        return
      case 'scroll-up':
        setScroll((prev) => clampScroll(prev + 1, lines.length, viewport))
        return
      case 'scroll-down':
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
    <Box flexDirection="column" height={size.rows}>
      <Header session={session} cols={size.cols} />
      <Transcript lines={lines} viewport={viewport} scroll={scroll} />
      <Footer status={status} scroll={scroll} />
      <Composer input={input} busy={status === 'running'} />
    </Box>
  )
}
