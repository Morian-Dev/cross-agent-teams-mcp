import type { FastifyInstance } from 'fastify'
import { releasePidFile } from './pid.js'

export function wireShutdown(app: FastifyInstance, pidPath: string): void {
  const handler = async (_signal: NodeJS.Signals) => {
    try { await app.close() } catch { /* ignore */ }
    releasePidFile(pidPath)
    process.exit(0)
  }
  process.once('SIGTERM', handler)
  process.once('SIGINT', handler)
}
