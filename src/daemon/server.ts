import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../storage/db.js'
import { applySchema } from '../storage/schema.js'
import { makeAuthHook } from './auth.js'
import { mountMcp } from '../mcp/transport.js'
import { runCleanup } from './cleanup.js'
import { SseFanout } from './sse-fanout.js'
import { clearAllRetries } from '../mcp/poke-retry.js'

export interface ServerOpts { dbPath: string; token?: string; cleanupIntervalMs?: number; fanout?: SseFanout }
export interface StartOpts extends ServerOpts { port: number; host?: string }

const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 120_000

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export async function buildServer(opts: ServerOpts): Promise<FastifyInstance> {
  const keepAliveTimeout = parsePositiveInt(process.env.KEEP_ALIVE_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
  const app = Fastify({ logger: false, keepAliveTimeout })
  app.server.headersTimeout = keepAliveTimeout + 1000
  const db = openDb(opts.dbPath)
  applySchema(db)
  const startedAt = Date.now()
  const version = '0.1.0'
  const fanout = opts.fanout ?? new SseFanout()
  app.addHook('onRequest', makeAuthHook(opts.token))
  app.get('/health', async () => ({ ok: true, version, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000) }))
  mountMcp(app, db, fanout)

  const cleanupIntervalMs = opts.cleanupIntervalMs
    ?? Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000)
  const interval = setInterval(() => {
    try { runCleanup(db) } catch { /* best-effort */ }
  }, cleanupIntervalMs)
  if (typeof interval.unref === 'function') interval.unref()

  app.addHook('onClose', async () => {
    clearInterval(interval)
    clearAllRetries()
    fanout.stopAll()
    db.close()
  })
  return app
}

export async function startServer(opts: StartOpts): Promise<{ app: FastifyInstance; port: number; host: string }> {
  const app = await buildServer(opts)
  const host = opts.host ?? '127.0.0.1'
  await app.listen({ port: opts.port, host })
  const addr = app.server.address()
  const port = addr && typeof addr === 'object' ? addr.port : opts.port
  return { app, port, host }
}
