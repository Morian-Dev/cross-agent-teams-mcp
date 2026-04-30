import type Database from 'better-sqlite3'

const DDL = [
  `CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_team TEXT NOT NULL,
    to_team TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_agent_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_from_team_eventid ON events(from_team, event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_to_team_eventid ON events(to_team, event_id)`,
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    agent_type TEXT,
    agent_type_name TEXT,
    team TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0,
    tmux_pane_id TEXT,
    claude_ui_pid INTEGER,
    runtime_ui_pid INTEGER,
    runtime_tty TEXT,
    runtime_verification_mode TEXT,
    runtime_bound_at TEXT,
    channel_session_id TEXT,
    delivery_kind TEXT NOT NULL DEFAULT 'none',
    delivery_payload TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(event_id),
    from_team TEXT NOT NULL,
    to_team TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT,
    to_role TEXT,
    subject TEXT,
    body TEXT NOT NULL,
    need_reply INTEGER NOT NULL DEFAULT 1,
    sent_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message_delivery_status (
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wake_status TEXT NOT NULL CHECK(wake_status IN ('delivered','retrying','skipped','failed')),
    skip_reason TEXT,
    retry_attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    PRIMARY KEY (message_id, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_message_delivery_status_message ON message_delivery_status(message_id)`,
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
  )`,
  `CREATE TABLE IF NOT EXISTS codex_pane_pre_registrations (
    pane_id TEXT PRIMARY KEY,
    xats_agent_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`
]

function migrateAgentsDeliveryColumns(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`)
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
  const existing = new Set(cols.map(c => c.name))
  // Column-rename migration: legacy schemas have `client`/`client_name`; rename
  // them in place to `agent_type`/`agent_type_name`. Idempotent: skip if the new
  // names already exist.
  const renameClient = existing.has('client') && !existing.has('agent_type')
  const renameClientName = existing.has('client_name') && !existing.has('agent_type_name')
  if (renameClient || renameClientName) {
    const renameTx = db.transaction(() => {
      if (renameClient) {
        db.exec(`ALTER TABLE agents RENAME COLUMN client TO agent_type`)
      }
      if (renameClientName) {
        db.exec(`ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name`)
      }
    })
    renameTx()
    // Refresh column snapshot after the rename so downstream ADD COLUMN checks
    // use the new column names.
    const colsAfter = db.pragma('table_info(agents)') as Array<{ name: string }>
    existing.clear()
    for (const c of colsAfter) existing.add(c.name)
  }
  const needAgentType = !existing.has('agent_type')
  const needAgentTypeName = !existing.has('agent_type_name')
  const needKind = !existing.has('delivery_kind')
  const needPayload = !existing.has('delivery_payload')
  const needRuntimeUiPid = !existing.has('runtime_ui_pid')
  const needRuntimeTty = !existing.has('runtime_tty')
  const needRuntimeVerificationMode = !existing.has('runtime_verification_mode')
  const needRuntimeBoundAt = !existing.has('runtime_bound_at')
  const needClaudeUiPid = !existing.has('claude_ui_pid')
  if (
    !needAgentType &&
    !needAgentTypeName &&
    !needKind &&
    !needPayload &&
    !needRuntimeUiPid &&
    !needRuntimeTty &&
    !needRuntimeVerificationMode &&
    !needRuntimeBoundAt &&
    !needClaudeUiPid
  ) return
  const tx = db.transaction(() => {
    if (needAgentType) {
      db.exec(`ALTER TABLE agents ADD COLUMN agent_type TEXT`)
    }
    if (needAgentTypeName) {
      db.exec(`ALTER TABLE agents ADD COLUMN agent_type_name TEXT`)
    }
    if (needKind) {
      db.exec(`ALTER TABLE agents ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'none'`)
    }
    if (needPayload) {
      db.exec(`ALTER TABLE agents ADD COLUMN delivery_payload TEXT`)
    }
    if (needRuntimeUiPid) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_ui_pid INTEGER`)
    }
    if (needRuntimeTty) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_tty TEXT`)
    }
    if (needRuntimeVerificationMode) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_verification_mode TEXT`)
    }
    if (needRuntimeBoundAt) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_bound_at TEXT`)
    }
    if (needClaudeUiPid) {
      db.exec(`ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER`)
    }
    if (needKind || needPayload) {
      db.exec(`UPDATE agents
        SET delivery_kind = 'claude-channel',
            delivery_payload = json_object('channel_session_id', channel_session_id)
        WHERE channel_session_id IS NOT NULL AND delivery_kind = 'none'`)
    }
  })
  tx()
}

function migrateMessagesNeedReplyColumn(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`)
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma('table_info(messages)') as Array<{ name: string }>
  const existing = new Set(cols.map(c => c.name))
  if (existing.has('need_reply')) return
  db.exec(`ALTER TABLE messages ADD COLUMN need_reply INTEGER NOT NULL DEFAULT 1`)
}

export function applySchema(db: Database.Database): void {
  for (const sql of DDL) db.exec(sql)
  migrateAgentsDeliveryColumns(db)
  migrateMessagesNeedReplyColumn(db)
}
