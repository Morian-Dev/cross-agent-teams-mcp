import type { FastifyInstance } from 'fastify'
import { releasePidFile } from './pid.js'

export interface WireShutdownOpts {
  graceMs?: number
  exit?: (code: number) => void
}

const DEFAULT_GRACE_MS = 5000

function resolveGraceMs(explicit: number | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return explicit < 0 ? 0 : Math.floor(explicit)
  }
  const raw = process.env.XATS_SHUTDOWN_GRACE_MS
  if (raw === undefined || raw === '') return DEFAULT_GRACE_MS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_GRACE_MS
  return n < 0 ? 0 : Math.floor(n)
}

export function wireShutdown(
  app: FastifyInstance,
  pidPath: string,
  opts: WireShutdownOpts = {}
): void {
  const graceMs = resolveGraceMs(opts.graceMs)
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  let shuttingDown = false

  const handler = (_signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      releasePidFile(pidPath)
      exit(0)
      return
    }
    shuttingDown = true
    void runDrain(app, pidPath, graceMs, exit)
  }
  process.on('SIGTERM', handler)
  process.on('SIGINT', handler)
}

async function runDrain(
  app: FastifyInstance,
  pidPath: string,
  graceMs: number,
  exit: (code: number) => void
): Promise<void> {
  if (graceMs <= 0) {
    try { app.server.closeAllConnections() } catch { /* best-effort */ }
    try { await app.close() } catch { /* ignore */ }
    releasePidFile(pidPath)
    exit(0)
    return
  }

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), graceMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  const closed = app.close().then(() => 'closed' as const).catch(() => 'closed' as const)

  const winner = await Promise.race([closed, deadline])
  if (winner === 'timeout') {
    try { app.server.closeAllConnections() } catch { /* best-effort */ }
    try { await app.close() } catch { /* ignore */ }
  }
  if (timer) clearTimeout(timer)
  releasePidFile(pidPath)
  exit(0)
}
