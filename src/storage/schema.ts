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
    name TEXT NOT NULL,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0,
    tmux_pane_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name, role)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(event_id),
    team TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT,
    to_role TEXT,
    subject TEXT,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    team TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
    depends_on TEXT NOT NULL,
    claimed_by TEXT,
    claimed_at TEXT,
    completed_at TEXT,
    result TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    format TEXT NOT NULL CHECK(format='jsonschema'),
    schema TEXT NOT NULL,
    note TEXT,
    registered_by TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    UNIQUE(team, name, version)
  )`,
  `CREATE TABLE IF NOT EXISTS contract_subscriptions (
    agent_id TEXT NOT NULL,
    team TEXT NOT NULL,
    contract_name TEXT NOT NULL,
    subscribed_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, team, contract_name)
  )`
]

export function applySchema(db: Database.Database): void {
  for (const sql of DDL) db.exec(sql)
}
