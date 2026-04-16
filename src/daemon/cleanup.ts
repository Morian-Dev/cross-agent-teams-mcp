import type Database from 'better-sqlite3'

export interface CleanupOpts {
  maxAgeDays?: number
  onlineWindowMs?: number
  now?: Date
}

export function runCleanup(db: Database.Database, opts: CleanupOpts = {}): { deleted: number } {
  const now = opts.now ?? new Date()
  const maxAgeDays = opts.maxAgeDays ?? 7
  const onlineWindowMs = opts.onlineWindowMs ?? 5 * 60 * 1000
  const threshold = new Date(now.getTime() - maxAgeDays * 86400 * 1000).toISOString()
  const onlineThreshold = new Date(now.getTime() - onlineWindowMs).toISOString()

  const online = db.prepare(
    `SELECT MIN(last_processed_event_id) AS m FROM agents WHERE last_seen_at >= ?`
  ).get(onlineThreshold) as { m: number | null }

  const floor = online.m === null || online.m === undefined ? null : Number(online.m)
  const stmt = floor === null
    ? db.prepare(`DELETE FROM events WHERE created_at < ?`)
    : db.prepare(`DELETE FROM events WHERE created_at < ? AND event_id < ?`)
  const info = floor === null ? stmt.run(threshold) : stmt.run(threshold, floor)
  return { deleted: Number(info.changes) }
}
