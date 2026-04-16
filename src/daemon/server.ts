import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../storage/db.js'
import { applySchema } from '../storage/schema.js'

export interface ServerOpts { dbPath: string; token?: string }
export interface StartOpts extends ServerOpts { port: number; host?: string }

export async function buildServer(opts: ServerOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = openDb(opts.dbPath)
  applySchema(db)
  const startedAt = Date.now()
  const version = '0.1.0'
  app.get('/health', async () => ({
    ok: true,
    version,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000)
  }))
  app.addHook('onClose', async () => { db.close() })
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
