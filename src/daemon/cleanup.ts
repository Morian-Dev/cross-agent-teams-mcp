import type Database from 'better-sqlite3'

export interface CleanupOpts {
  maxAgeDays?: number
  onlineWindowMs?: number
  now?: Date
}

// Online cursor floor per destination team: an agent in team T with recent last_seen_at
// advances team T's inbox cursor. Events older than 7 days that target team T can be
// dropped once T's min cursor has moved past their event_id.
const DELETE_AGED_EVENTS_SQL = `
  WITH online_cursor AS (
    SELECT team AS to_team, MIN(last_processed_event_id) AS min_cursor
    FROM agents
    WHERE last_seen_at >= :cutoffOnline
    GROUP BY team
  )
  DELETE FROM events
  WHERE created_at < :ageCutoff
    AND (
      events.to_team NOT IN (SELECT to_team FROM online_cursor)
      OR events.event_id < (
        SELECT min_cursor FROM online_cursor WHERE online_cursor.to_team = events.to_team
      )
    )
`

export function runCleanup(db: Database.Database, opts: CleanupOpts = {}): { deleted: number } {
  const now = opts.now ?? new Date()
  const maxAgeDays = opts.maxAgeDays ?? 7
  const onlineWindowMs = opts.onlineWindowMs ?? 5 * 60 * 1000
  const ageCutoff = new Date(now.getTime() - maxAgeDays * 86400 * 1000).toISOString()
  const cutoffOnline = new Date(now.getTime() - onlineWindowMs).toISOString()

  const info = db.prepare(DELETE_AGED_EVENTS_SQL).run({ ageCutoff, cutoffOnline })
  return { deleted: Number(info.changes) }
}
