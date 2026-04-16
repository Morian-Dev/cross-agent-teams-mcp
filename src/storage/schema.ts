import type Database from 'better-sqlite3'

const DDL = [
  `CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_agent_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_team_eventid ON events(team, event_id)`,
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    team TEXT NOT NULL,
    role TEXT NOT NULL,
    display_name TEXT,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0
  )`
]

export function applySchema(db: Database.Database): void {
  for (const sql of DDL) db.exec(sql)
}
