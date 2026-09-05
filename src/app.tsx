// The app controller: owns session lifecycle, harness event subscriptions, and
// every key-driven state transition. Components in ui.tsx stay dumb.
import { randomUUID } from 'node:crypto'
import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Box, useApp, useInput, useStdout } from 'ink'
import type { Agent, AgentHandle, AgentStatus, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { matchKey } from './keys.js'
import { clampScroll, composerRows, transcriptViewport } from './scroll.js'
import { Composer, Footer, Header, Transcript } from './ui.js'
import type { Line, SessionInfo, SessionStatus } from './ui.js'

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
}

const HISTORY_CAP = 400
const EVENT_TEXT_CAP = 240

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function summarizeEventData(data: unknown): string {
  let text: string
  try {
    text = JSON.stringify(data) ?? 'undefined'
  } catch {
    text = String(data)
  }
  return text.length > EVENT_TEXT_CAP ? text.slice(0, EVENT_TEXT_CAP - 1) + '…' : text
}

export function App({ services, onDone }: { services: HarnessServices; onDone: () => void }): JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [lines, setLines] = useState<Line[]>([{ kind: 'sys', text: 'opening session…' }])
  const [input, setInput] = useState('')
  const [scroll, setScroll] = useState(0)
  const [status, setStatus] = useState<SessionStatus>('connecting')
  const [session, setSession] = useState<SessionInfo | null>(null)
  // Resize re-render: Ink redraws on its own, but the viewport math reads
  // stdout.rows/columns, so track them as state to guarantee a relayout.
  // `||` catches 0: a degenerate pty (script, CI) reports 0x0 and would
  // otherwise blank every region.
  const [size, setSize] = useState({ rows: stdout?.rows || 24, cols: stdout?.columns || 80 })
  const agentRef = useRef<Agent | null>(null)
  const handleRef = useRef<AgentHandle | null>(null)
  const onDoneRef = useRef(onDone)
  const servicesRef = useRef(services)
  const push = (line: Line): void => setLines((prev) => [...prev, line].slice(-HISTORY_CAP))

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
        disposers.push(
          harness.on('session/event', (eventSession, event) => {
            if (eventSession.id !== agent.session.id) return
            push({ kind: 'event', text: `${event.type} ${summarizeEventData(event.data)}` })
          }),
          harness.on('agent/status', (payload) => {
            if (payload.agent.id !== agent.session.id) return
            setStatus(payload.status)
          }),
        )
        setSession({ id: agent.session.id, model: agent.options.model, provider: agent.options.provider })
        setStatus('idle')
        push({ kind: 'sys', text: `session ${agent.session.id} started` })
      } catch (error) {
        setStatus('failed')
        push({ kind: 'sys', text: `failed to open session: ${errorMessage(error)}` })
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

  const composerLineCount = composerRows(input.length, size.cols)
  const viewport = transcriptViewport(size.rows, composerLineCount)

  useInput((ch, key) => {
    switch (matchKey(ch, key)) {
      case 'submit': {
        const text = input.trim()
        setInput('')
        if (!text) return
        const agent = agentRef.current
        if (!agent) {
          push({ kind: 'sys', text: 'no session yet' })
          return
        }
        push({ kind: 'user', text })
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
          push({ kind: 'sys', text: `turn failed: ${errorMessage(error)}` })
        }
        return
      }
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
