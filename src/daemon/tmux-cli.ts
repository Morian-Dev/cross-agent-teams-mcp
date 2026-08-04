import { execFile, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { userInfo } from 'node:os'

const pExecFile = promisify(execFile)

let _isTmuxAvailable: boolean | null = null
let _tmuxSocketArgs: string[] = []

// Auto-detect which tmux server socket to use.  When the daemon is started from
// outside tmux (e.g. a launchd agent or a shell that is not inside a tmux
// session), the default socket has no server.  Tools like AoE create their own
// named socket (`tmux -L <name>`), so we scan /tmp/tmux-<uid>/ for available
// sockets and pick the one that answers `list-panes -a`.
export async function resolveTmuxSocket(): Promise<string[]> {
  if (_tmuxSocketArgs.length > 0) return _tmuxSocketArgs

  // Try default socket first — fast path for users who start the daemon from
  // inside a tmux session or who use the default server.
  try {
    await pExecFile('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { timeout: 3000 })
    _tmuxSocketArgs = []
    return _tmuxSocketArgs
  } catch {
    // default socket has no server — scan for alternatives
  }

  try {
    const uid = userInfo().uid
    const dir = `/private/tmp/tmux-${uid}`
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry === 'default') continue
      const socketPath = `${dir}/${entry}`
      try {
        await pExecFile(
          'tmux', ['-S', socketPath, 'list-panes', '-a', '-F', '#{pane_id}'],
          { timeout: 3000 }
        )
        _tmuxSocketArgs = ['-S', socketPath]
        return _tmuxSocketArgs
      } catch {
        // socket not answering — try next
      }
    }
  } catch {
    // can't read socket dir
  }

  _tmuxSocketArgs = []
  return _tmuxSocketArgs
}

function tmuxArgs(...args: string[]): [string, string[]] {
  return ['tmux', [..._tmuxSocketArgs, ...args]]
}

export async function isTmuxAvailable(): Promise<boolean> {
  if (_isTmuxAvailable !== null) return _isTmuxAvailable
  try {
    await pExecFile('tmux', ['-V'])
    _isTmuxAvailable = true
  } catch {
    _isTmuxAvailable = false
  }
  return _isTmuxAvailable
}

const TMUX_CAPTURE_TIMEOUT_MS = 5_000

export async function capturePaneTail(paneId: string, lines = 8): Promise<string> {
  const [bin, baseArgs] = tmuxArgs('capture-pane', '-t', paneId, '-p', '-S', `-${lines}`)
  const { stdout } = await pExecFile(bin, baseArgs, { timeout: TMUX_CAPTURE_TIMEOUT_MS })
  return stdout
}

export function loadBuffer(bufferName: string, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, baseArgs] = tmuxArgs('load-buffer', '-b', bufferName, '-')
    const child = spawn(bin, baseArgs)
    let stderr = ''
    child.on('error', reject)
    if (child.stderr) {
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    }
    child.on('close', (code: number) => {
      if (code === 0) resolve()
      else reject(new Error(`load-buffer exit ${code}: ${stderr}`))
    })
    child.stdin.write(Buffer.from(prompt, 'utf8'))
    child.stdin.end()
  })
}

export async function pasteBuffer(bufferName: string, paneId: string): Promise<void> {
  const [bin, baseArgs] = tmuxArgs('paste-buffer', '-b', bufferName, '-t', paneId, '-p', '-d')
  await pExecFile(bin, baseArgs)
}

export async function sendEnter(paneId: string): Promise<void> {
  const [bin, baseArgs] = tmuxArgs('send-keys', '-t', paneId, 'Enter')
  await pExecFile(bin, baseArgs)
}

export function _resetTmuxAvailableCache(): void {
  _isTmuxAvailable = null
}

export function _setTmuxAvailableForTest(value: boolean): void {
  _isTmuxAvailable = value
}
