import Fastify, { type FastifyInstance } from 'fastify'
import { openDb } from '../storage/db.js'
import { applySchema } from '../storage/schema.js'

export interface ServerOpts {
  dbPath: string
  token?: string
}

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
