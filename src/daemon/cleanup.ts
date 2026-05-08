import type Database from 'better-sqlite3'

export interface CleanupOpts {
  maxAgeDays?: number
  now?: Date
}

// Uniform 30-day hard TTL for mailbox-derived tables. The deletion runs as a
// single SQLite transaction in child→parent order so foreign-key references
// (PRAGMA foreign_keys=ON) never become dangling mid-transaction. Cursor
// position is intentionally NOT consulted — agents that have been offline for
// more than 30 days forfeit any unread mail, which is the explicit retention
// contract.
export function runCleanup(db: Database.Database, opts: CleanupOpts = {}): { deleted: number } {
  const now = opts.now ?? new Date()
  const maxAgeDays = opts.maxAgeDays ?? 30
  const ageCutoff = new Date(now.getTime() - maxAgeDays * 86400 * 1000).toISOString()

  const deleteStatus = db.prepare(
    `DELETE FROM message_delivery_status
      WHERE message_id IN (SELECT id FROM messages WHERE sent_at < ?)`
  )
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE sent_at < ?`)
  const deleteEvents = db.prepare(`DELETE FROM events WHERE created_at < ?`)

  const tx = db.transaction(() => {
    const s = deleteStatus.run(ageCutoff)
    const m = deleteMessages.run(ageCutoff)
    const e = deleteEvents.run(ageCutoff)
    return Number(s.changes) + Number(m.changes) + Number(e.changes)
  })
  return { deleted: tx() }
}
