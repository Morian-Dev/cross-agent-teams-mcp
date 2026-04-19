import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export interface ResolveCsidArgs {
  cacheDir: string
  team: string
  name: string
}

const SUBDIR = 'ts-agent-teams-channel'

export function resolveCacheDir(overrides?: NodeJS.ProcessEnv): string {
  const env = overrides ?? process.env
  const xdg = env.XDG_CACHE_HOME
  if (xdg && xdg.length > 0) return xdg
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (local && local.length > 0) return local
  }
  return join(homedir(), '.cache')
}

function filePath(args: ResolveCsidArgs): string {
  const safeTeam = args.team.replace(/[^A-Za-z0-9._-]/g, '_')
  const safeName = args.name.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(args.cacheDir, SUBDIR, `${safeTeam}-${safeName}.json`)
}

function readStoredCsid(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { channel_session_id?: unknown }
    const csid = parsed.channel_session_id
    if (typeof csid === 'string' && csid.trim().length > 0) return csid
  } catch {
    // malformed file → regenerate below
  }
  return null
}

function writeCsid(path: string, csid: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ channel_session_id: csid }))
}

export function resolveCsid(args: ResolveCsidArgs): string {
  const path = filePath(args)
  const existing = readStoredCsid(path)
  if (existing) return existing
  const fresh = randomUUID()
  writeCsid(path, fresh)
  return fresh
}
