// deepseek-tui app plugin: boots a terminal chat UI inside a dsh profile and
// drives the in-process agent through the harness's own services — no child
// runtime. Minimal first cut: open one session in the invoking directory,
// send typed prompts as followups, and tail session events raw. Richer
// projection of the event feed (assistant text, tool calls, approvals) is the
// next increment.
import { randomUUID } from 'node:crypto'
import { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, render, useApp, useInput } from 'ink'

export const name = 'deepseek-tui'

export const inject = ['agents']

// ponytail: minimal structural mirrors of the harness services this plugin
// uses; typed against the real @deepseek-ai packages (as devDeps from the
// sibling harness checkout) when the event projection lands. ctx.on returns a
// disposer; agents.open mirrors dsh-agent's AgentService surface.
export interface AgentSession {
  readonly id: string
}
export interface SessionAgent {
  readonly session: AgentSession
  readonly options?: { readonly model?: string; readonly provider?: string }
  followup(message: string): Promise<void>
}
export interface AgentHandle {
  readonly agent: SessionAgent
  dispose(): Promise<void>
}
export interface AgentsService {
  create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: { model?: string; provider?: string } }): Promise<AgentHandle>
}
export interface PluginContext {
  readonly agents: AgentsService
  on(event: string, listener: (...args: unknown[]) => void): () => void
}

const HISTORY_CAP = 400
const EVENT_TEXT_CAP = 240

type Line = { kind: 'user' | 'event' | 'sys'; text: string }

function summarize(event: unknown): string {
  if (typeof event !== 'object' || event === null) return String(event)
  const entries = Object.entries(event as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      let s: string
      try {
        s = JSON.stringify(v)
      } catch {
        s = String(v)
      }
      if (s.length > EVENT_TEXT_CAP) s = s.slice(0, EVENT_TEXT_CAP - 1) + '…'
      return `${k}:${s}`
    })
  const body = entries.join(' ')
  return body.length > 400 ? body.slice(0, 399) + '…' : body
}

function Chat({ ctx, onDone }: { ctx: PluginContext; onDone: () => void }): React.JSX.Element {
  const { exit } = useApp()
  const [lines, setLines] = useState<Line[]>([{ kind: 'sys', text: 'opening session…' }])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const agentRef = useRef<SessionAgent | null>(null)
  const disposerRef = useRef<(() => void) | null>(null)
  const exitRef = useRef(onDone)
  const push = (line: Line): void => setLines((prev) => [...prev, line].slice(-HISTORY_CAP))

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const handle = await ctx.agents.create({
          sessionId: randomUUID(),
          meta: { cwd: process.cwd() },
        })
        if (cancelled) {
          await handle.dispose()
          return
        }
        agentRef.current = handle.agent
        const disposer = ctx.on('session/event', (...args) => {
          const session = args[0] as { id?: string } | undefined
          if (session?.id !== handle.agent.session.id) return
          const event = args[1]
          const kind = (event as { type?: string } | undefined)?.type ?? typeof event
          push({ kind: 'event', text: `${kind} ${summarize(event)}` })
        })
        disposerRef.current = disposer
        setSessionId(handle.agent.session.id)
        push({ kind: 'sys', text: `session ${handle.agent.session.id} started` })
      } catch (error) {
        push({ kind: 'sys', text: `failed to open session: ${error instanceof Error ? error.message : String(error)}` })
      }
    })()
    return () => {
      cancelled = true
      disposerRef.current?.()
    }
  }, [ctx])

  useInput((ch, key) => {
    if (key.return) {
      const message = input.trim()
      setInput('')
      if (!message) return
      if (!agentRef.current) {
        push({ kind: 'sys', text: 'no session yet' })
        return
      }
      setBusy(true)
      push({ kind: 'user', text: message })
      void agentRef.current.followup(message).catch((error: unknown) => {
        push({ kind: 'sys', text: `turn failed: ${error instanceof Error ? error.message : String(error)}` })
      }).finally(() => setBusy(false))
    } else if (key.backspace) {
      setInput(input.slice(0, -1))
    } else if (key.escape || (key.ctrl && ch.toLowerCase() === 'c')) {
      exit()
    } else {
      setInput(input + ch)
    }
  })

  useEffect(() => {
    return () => exitRef.current()
  }, [])

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line, i) => (
          <Box key={i} flexDirection="column">
            <Text bold color={line.kind === 'user' ? 'cyan' : line.kind === 'event' ? 'yellow' : 'magenta'}>
              {line.kind === 'user' ? 'you' : line.kind === 'event' ? 'event' : 'dsh-tui'}
            </Text>
            <Text>{line.text}</Text>
          </Box>
        )}
      </Static>
      <Box>
        <Text dimColor>esc quit</Text>
        <Text dimColor> · {busy ? 'running' : sessionId ? `session ${sessionId.slice(0, 8)}` : 'connecting'}</Text>
      </Box>
      <Text color="cyan">{'>'} {input}</Text>
    </Box>
  )
}

let exited = false
function exitProcess(): void {
  if (exited) return
  exited = true
  process.exit(0)
}

export function apply(ctx: PluginContext): void {
  const instance = render(<Chat ctx={ctx} onDone={exitProcess} />)
  instance.waitUntilExit().then(exitProcess)
}
