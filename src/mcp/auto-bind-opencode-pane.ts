import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OpencodePanePreRegRepo, OpencodePanePreRegRow } from '../storage/opencode-pane-prereg-repo.js'
import type { BindOpencodeSessionService } from './bind-opencode-session.js'

const TMUX_LIST_TIMEOUT_MS = 3_000
const PS_LIST_TIMEOUT_MS = 3_000

export interface PaneTtyEntry {
  pane_id: string
  tty: string
}

export interface AutoBindOpencodePaneDeps {
  listPanes?: () => Promise<PaneTtyEntry[]>
  ttyProcesses?: (tty: string) => Promise<string[]>
  now?: () => Date
}

export interface AutoBindOpencodePaneInput {
  callerAgentId: string
  repo: OpencodePanePreRegRepo
  bindOpencodeSvc: BindOpencodeSessionService
}

export interface AutoBindOpencodeResult {
  ok: true
  base_url: string
  session_id: string
  pane_id: string
}

function normalizeTty(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const normalized = value.replace(/^\/dev\//, '')
  if (!normalized || normalized === '?') return undefined
  return normalized
}

async function defaultListPanes(): Promise<PaneTtyEntry[]> {
  const exec = promisify(execFile)
  const { stdout } = await exec(
    'tmux',
    ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}'],
    { timeout: TMUX_LIST_TIMEOUT_MS }
  )
  return stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const [pane_id, pane_tty] = line.split('\t')
      return {
        pane_id,
        tty: normalizeTty(pane_tty) ?? '',
      }
    })
}

async function defaultTtyProcesses(tty: string): Promise<string[]> {
  const exec = promisify(execFile)
  const { stdout } = await exec(
    'ps',
    ['-t', tty, '-o', 'pid=,ppid=,stat=,command='],
    { timeout: PS_LIST_TIMEOUT_MS }
  )
  return stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
}

function isOpencodeProcess(line: string): boolean {
  // Match bare `opencode` CLI invocations; exclude `opencode serve` so that
  // the shared server process is not matched as a client pane.
  if (!/(^|[\s/])opencode([\s]|$)/i.test(line)) return false
  if (/opencode\s+serve/i.test(line)) return false
  return true
}

interface Candidate {
  row: OpencodePanePreRegRow
  pane_id: string
}

// Test hook: allows integration tests to override the tmux/ps probes that
// would otherwise need a real tmux session.
export const __testOverrides: AutoBindOpencodePaneDeps = {}

/**
 * Scan pending opencode pre-regs, look up tmux panes and their processes, and
 * bind the caller agent row when exactly one pre-reg maps to a pane whose tty
 * is running a live `opencode` CLI process.  Consumed pre-reg rows are deleted
 * in the same transaction as the agent-row update via the service call.
 *
 * Returns a result on success; returns undefined on any failure or no match.
 */
export async function autoBindOpencodeFromPreReg(
  input: AutoBindOpencodePaneInput,
  deps: AutoBindOpencodePaneDeps = {}
): Promise<AutoBindOpencodeResult | undefined> {
  const listPanes = deps.listPanes ?? __testOverrides.listPanes ?? defaultListPanes
  const ttyProcesses = deps.ttyProcesses ?? __testOverrides.ttyProcesses ?? defaultTtyProcesses
  const now = deps.now ?? __testOverrides.now ?? (() => new Date())

  try {
    const nowIso = now().toISOString()
    input.repo.purgeExpired(nowIso)
    const pending = input.repo.listUnexpired(nowIso)
    if (pending.length === 0) return undefined

    let panes: PaneTtyEntry[]
    try {
      panes = await listPanes()
    } catch {
      return undefined
    }

    const paneIndex = new Map<string, PaneTtyEntry>()
    for (const pane of panes) {
      if (pane.pane_id) paneIndex.set(pane.pane_id, pane)
    }

    const ttyProcessCache = new Map<string, string[]>()
    const candidates: Candidate[] = []

    for (const row of pending) {
      const pane = paneIndex.get(row.pane_id)
      if (!pane || !pane.tty) continue
      let procs = ttyProcessCache.get(pane.tty)
      if (procs === undefined) {
        try {
          procs = await ttyProcesses(pane.tty)
        } catch {
          procs = []
        }
        ttyProcessCache.set(pane.tty, procs)
      }
      const matching = procs.filter(isOpencodeProcess)
      if (matching.length === 0) continue
      candidates.push({ row, pane_id: pane.pane_id })
    }

    if (candidates.length !== 1) return undefined

    const chosen = candidates[0]
    const consumed = input.repo.consume(chosen.pane_id, nowIso)
    if (!consumed) return undefined

    const bindResult = input.bindOpencodeSvc.bind({
      callerAgentId: input.callerAgentId,
      base_url: consumed.base_url,
      session_id: consumed.session_id,
    })
    if (!('ok' in bindResult) || !bindResult.ok) return undefined

    return {
      ok: true,
      base_url: consumed.base_url,
      session_id: consumed.session_id,
      pane_id: chosen.pane_id,
    }
  } catch {
    return undefined
  }
}
