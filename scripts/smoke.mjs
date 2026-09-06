#!/usr/bin/env node
// Smoke test: boot the real `dsh --profile tui` in a scratch PTY, drive a
// scripted interaction (open the slash palette, close it, open the help
// overlay, close the sidebar, exit), and assert rc 0 plus key markers in the
// capture. Runs the profile the way the repo docs do — the profile's own
// node_modules bundle is what boots — so a stale bundle fails loudly with
// refresh instructions instead of silently testing old code.
//
// The PTY driver is an embedded dependency-free python3 script (pty.fork +
// select), the same mechanics the harness uses for its PTY smokes. Runs are
// isolated from the developer's ~/.dsh: DSH_HOME points at a scratch home
// whose profiles/settings symlink back to the real ones.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(repoRoot, '..', 'deepseek-harness')
const homeDir = process.env.HOME ?? ''
const profileDir = join(homeDir, '.dsh', 'profiles', 'tui')
const bundleDir = join(profileDir, 'node_modules', 'deepseek-tui')
const repoLib = join(repoRoot, 'lib')
const dshEntry = join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts')
const tsxLoader = join(harnessRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')

const fail = (message) => {
  console.error(`smoke: FAIL\n\n${message}`)
  process.exit(1)
}

const newestMtime = (dir, suffix) => {
  let newest = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue
    newest = Math.max(newest, statSync(join(dir, name)).mtimeMs)
  }
  return newest
}

// --- Preflight: the booted bundle must be the current checkout ---------------
if (!existsSync(join(repoLib, 'index.js'))) {
  fail('the repo lib/ is not built.\nRun "pnpm build" in the deepseek-tui repo first.')
}
if (newestMtime(join(repoRoot, 'src'), '.ts') > newestMtime(repoLib, '.js') + 1000) {
  fail('the repo lib/ is older than the sources.\nRun "pnpm build" in the deepseek-tui repo first.')
}
if (!existsSync(join(bundleDir, 'package.json'))) {
  fail(`the tui profile bundle is not installed.\nExpected ${bundleDir}.\nRefresh it with:\n  cd ${profileDir}\n  rm -rf node_modules/deepseek-tui && pnpm update deepseek-tui --latest`)
}
if (!existsSync(dshEntry) || !existsSync(tsxLoader)) {
  fail(`the harness checkout is not where this smoke expects it.\nExpected ${harnessRoot} with apps/cli/src/bin.ts and node_modules/tsx.\nRun the smoke from the deepseek-tui repo with its harness sibling in place.`)
}
// Exact-content staleness check: the profile boots whatever bytes its bundle
// holds, so any difference from this checkout means the smoke would test old
// code. Hash the built lib file by file.
const staleFiles = []
for (const name of readdirSync(repoLib)) {
  if (!name.endsWith('.js') && !name.endsWith('.d.ts')) continue
  const repoFile = join(repoLib, name)
  const bundleFile = join(bundleDir, 'lib', name)
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  if (!existsSync(bundleFile)) staleFiles.push(`${name} (missing in the profile bundle)`)
  else if (digest(repoFile) !== digest(bundleFile)) staleFiles.push(`${name} (differs from this checkout)`)
}
if (staleFiles.length > 0) {
  fail([
    'the profile bundle at node_modules/deepseek-tui is stale — it does not match this checkout,',
    'so a boot would exercise old code. Refresh it and rerun:',
    '',
    `  cd ${profileDir}`,
    '  rm -rf node_modules/deepseek-tui && pnpm update deepseek-tui --latest',
    '',
    `stale files: ${staleFiles.join(', ')}`,
  ].join('\n'))
}

// --- PTY driver ---------------------------------------------------------------
// python3 pty.fork with a marker-gated key script: each step waits for a NEW
// occurrence of its marker in the accumulated capture (baseline counted when
// the step arms), then writes its keys. Steps without a marker wait just sleep.
const PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
executable, args_json, env_json, cwd, timeout_seconds, actions_json = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(env_json))
actions = json.loads(actions_json)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(executable, [executable, *json.loads(args_json)], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
output = bytearray()
index = 0
# A step arms at the moment the previous step fires: its marker must then
# appear ONE more time than it already has in the accumulated capture.
baselines = [0] * len(actions)
deadline = time.monotonic() + float(timeout_seconds)
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)
    while index < len(actions):
        action = actions[index]
        if action.get("wait") is not None:
            marker = action["wait"].encode()
            if output.count(marker) <= baselines[index]:
                break
        time.sleep(action.get("delay", 0.25))
        os.write(fd, action["write"].encode())
        index += 1
        if index < len(actions) and actions[index].get("wait") is not None:
            baselines[index] = output.count(actions[index]["wait"].encode())
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break
if status is None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
timed_out = status is None
if timed_out:
    status = 0
# Drain whatever the child wrote before its terminal closed (restore bytes etc).
while True:
    try:
        ready, _, _ = select.select([fd], [], [], 0.25)
        if not ready:
            break
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        output.extend(chunk)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        break
sys.stdout.buffer.write(bytes(output))
exit_code = os.waitstatus_to_exitcode(status)
sys.stderr.write("smoke driver: steps %d/%d; child_exit=%s; timed_out=%s\n" % (
    index, len(actions), exit_code, timed_out))
if index != len(actions) or timed_out:
    sys.stderr.write("smoke driver: completed %d/%d steps before the child exited\n" % (index, len(actions)))
    sys.exit(124)
sys.exit(exit_code)
`

// The scripted interaction, one step per action. Esc quits in three stages:
// close the help overlay, close the sidebar, exit the app.
const ESC = '\x1b'
const BACKSPACE = '\x7f'
const actions = [
  { wait: 'started', write: '/', label: 'session started; open the slash palette' },
  { wait: '/sessions', write: ESC, label: 'palette shows its roster; close it' },
  { wait: 'ask anything', write: 'hello', label: 'palette closed; type a prompt' },
  { wait: 'hello', write: `${BACKSPACE.repeat(5)}`, label: 'composer echoes the prompt; clear it' },
  { wait: 'ask anything', write: '?', label: 'composer cleared; open the help overlay' },
  { wait: 'deepseek-tui help — esc or ? closes', write: ESC, label: 'help overlay visible; close it' },
  { wait: 'ask anything', write: ESC, delay: 0.4, label: 'help closed; close the sidebar' },
  { write: ESC, delay: 0.6, label: 'exit the app' },
]

const scratch = `${tmpdir()}/dsh-tui-smoke-${process.pid}-${Date.now()}`
const dshHome = join(scratch, '.dsh')
const cwd = join(scratch, 'work')
mkdirSync(join(dshHome, 'profiles'), { recursive: true })
mkdirSync(cwd, { recursive: true })
mkdirSync(join(scratch, '.agents'), { recursive: true })
symlinkSync(profileDir, join(dshHome, 'profiles', 'tui'))
const realSettings = join(homeDir, '.dsh', 'settings.yaml')
if (existsSync(realSettings)) symlinkSync(realSettings, join(dshHome, 'settings.yaml'))

// Launch exactly like the dev boot (source bin + tsx loader), from a scratch
// workspace so no real session storage or sidebar state is touched.
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(DEEPSEEK_API_KEY|MOONSHOT_API_KEY|.*_API_KEY)$/.test(key)) delete env[key]
}
env.DSH_HOME = dshHome
env.DSH_AGENTS_HOME = join(scratch, '.agents')
env.DSH_TELEMETRY_DISABLED = '1'
// Source-mode harness imports resolve through the harness tsconfig's paths
// (tsx picks it up from cwd otherwise); force it so the scratch cwd works.
env.TSX_TSCONFIG_PATH = join(harnessRoot, 'tsconfig.json')
env.TERM = 'xterm-256color'
env.LC_ALL = 'C.UTF-8'

const started = Date.now()
const result = spawnSync('python3', [
  '-c', PTY_DRIVER,
  process.execPath,
  JSON.stringify(['--import', `file://${tsxLoader}`, dshEntry, '--profile', 'tui']),
  JSON.stringify(env),
  cwd,
  '60',
  JSON.stringify(actions),
], { encoding: 'utf8', timeout: 75_000 })

const elapsed = ((Date.now() - started) / 1000).toFixed(1)
const capture = result.stdout ?? ''
const stderr = (result.stderr ?? '').trim()

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  // Best-effort scratch cleanup; the OS tmpdir reaper covers stragglers.
}

const problems = []
if (result.status !== 0) {
  problems.push(`the pty driver exited ${result.status === null ? '(killed)' : result.status}: the boot or interaction failed${stderr ? ` (${stderr})` : ''}`)
}
if (!capture.includes('started')) problems.push('no "session started" notice in the capture — the session did not open')
if (!capture.includes('ask anything')) problems.push('no composer placeholder in the capture — the UI did not render')
if (!capture.includes('/sessions')) problems.push('no "/sessions" roster row in the capture — the slash palette did not open')
if (!capture.includes('deepseek-tui help — esc or ? closes')) problems.push('no help overlay header in the capture — "?" did not open the overlay')
if (!capture.includes('enter runs · esc closes')) problems.push('no palette-mode footer hints in the capture — the footer did not switch modes')
if (!capture.includes('hello')) problems.push('no composer echo of the typed prompt in the capture')
if (problems.length === 0) {
  const altIn = capture.indexOf('\x1b[?1049h')
  const altOut = capture.indexOf('\x1b[?25h\x1b[?1049l')
  if (altIn === -1) problems.push('no alt-screen entry sequence in the capture')
  else if (altOut === -1 || altOut < altIn) problems.push('no alt-screen restore after entry — the terminal may be left stranded')
}

if (problems.length > 0) {
  const tail = capture.slice(-6000)
  fail([
    ...problems,
    '',
    stderr === '' ? '' : `driver stderr: ${stderr}`,
    '',
    'capture tail:',
    tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-3500),
    '',
    'If the boot itself failed, the common cause is a stale profile bundle:',
    `  cd ${profileDir}`,
    '  rm -rf node_modules/deepseek-tui && pnpm update deepseek-tui --latest',
  ].join('\n'))
}

// eslint-disable-next-line no-console
console.log(`smoke: PASS — dsh --profile tui booted, session started, slash palette, help overlay, and quit all behaved; rc 0 in ${elapsed}s`)
