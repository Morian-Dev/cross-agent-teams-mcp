import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import {
  isTmuxAvailable,
  capturePaneTail,
  loadBuffer,
  pasteBuffer,
  sendEnter
} from '../daemon/tmux-cli.js'

// allowCrossTeam is for internal auto-poke callers only; MCP tool entry MUST NOT pass it.
export interface PokeDeps {
  db: Database.Database
  callerAgentId: string | null
  allowCrossTeam?: boolean
}

export interface PokeInput {
  target_agent_id: string
  prompt: string
}

export type PokeResult =
  | { ok: true; pane_id: string; pane_tail_before: string; pane_tail_after: string }
  | { error: string; detail?: unknown }

interface TargetRow {
  agent_id: string
  team: string
  tmux_pane_id: string | null
}

export const PROMPT_MAX_BYTES = 8192
export const PASTE_SETTLE_MS = 400
export const TAIL_LINES = 8

type TmuxStage = 'capture_before' | 'load_buffer' | 'paste_buffer' | 'send_keys' | 'capture_after'

interface StageError {
  stage: TmuxStage
  cause: unknown
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorMessage(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const err = cause as { stderr?: string | Buffer; message?: string }
    if (err.stderr) {
      const s = typeof err.stderr === 'string' ? err.stderr : err.stderr.toString('utf8')
      if (s.length > 0) return s
    }
    if (err.message) return err.message
  }
  return String(cause)
}

export function classifyTmuxError(err: StageError): { error: string; detail: unknown } {
  const msg = errorMessage(err.cause)
  const lower = msg.toLowerCase()
  if (lower.includes("can't find pane") || lower.includes('pane not found') || lower.includes('no such pane')) {
    return { error: 'pane_dead', detail: msg }
  }
  return { error: 'tmux_cmd_failed', detail: { stage: err.stage, stderr: msg } }
}

async function runStage<T>(stage: TmuxStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    throw { stage, cause } as StageError
  }
}

export async function poke(deps: PokeDeps, input: PokeInput): Promise<PokeResult> {
  if (!deps.callerAgentId) return { error: 'unknown_agent' }

  const promptLen = Buffer.byteLength(input.prompt, 'utf8')
  if (promptLen > PROMPT_MAX_BYTES) {
    return { error: 'prompt_too_long', detail: { max: PROMPT_MAX_BYTES, got: promptLen } }
  }

  const target = deps.db
    .prepare(`SELECT agent_id, team, tmux_pane_id FROM agents WHERE agent_id = ?`)
    .get(input.target_agent_id) as TargetRow | undefined
  if (!target) return { error: 'unknown_target' }

  if (target.agent_id === deps.callerAgentId) return { error: 'self_poke_denied' }

  const callerRow = deps.db
    .prepare(`SELECT team FROM agents WHERE agent_id = ?`)
    .get(deps.callerAgentId) as { team: string } | undefined
  if (!callerRow) return { error: 'unknown_agent' }
  if (callerRow.team !== target.team && !deps.allowCrossTeam) {
    return { error: 'cross_team_denied' }
  }

  if (!target.tmux_pane_id) return { error: 'tmux_pane_not_set' }

  if (!(await isTmuxAvailable())) {
    return { error: 'tmux_unavailable', detail: 'tmux binary not available on PATH' }
  }

  const paneId = target.tmux_pane_id
  const bufName = `poke-${randomBytes(3).toString('hex')}`

  try {
    const pane_tail_before = await runStage('capture_before', () => capturePaneTail(paneId, TAIL_LINES))
    await runStage('load_buffer', () => loadBuffer(bufName, input.prompt))
    await runStage('paste_buffer', () => pasteBuffer(bufName, paneId))
    await delay(PASTE_SETTLE_MS)
    await runStage('send_keys', () => sendEnter(paneId))
    await delay(PASTE_SETTLE_MS)
    const pane_tail_after = await runStage('capture_after', () => capturePaneTail(paneId, TAIL_LINES))
    return { ok: true, pane_id: paneId, pane_tail_before, pane_tail_after }
  } catch (e) {
    const stageErr = e as StageError
    return classifyTmuxError(stageErr)
  }
}
