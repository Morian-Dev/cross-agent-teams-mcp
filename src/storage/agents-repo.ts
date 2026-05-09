import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  parseDeliveryRow,
  serializeDelivery,
  type DeliverySpec,
  type DeliveryRow,
} from '../lib/delivery-spec.js'
import type { AgentType } from '../lib/agent-type.js'

export interface RegisterInput {
  agent_type?: AgentType
  agent_type_name?: string
  model?: string
  name: string
  role?: string
  team?: string
  tmux_pane_id?: string
  delivery?: DeliverySpec
  claude_ui_pid?: number
  runtime_ui_pid?: number
}

export interface AgentRow {
  agent_id: string
  agent_type: AgentType | null
  agent_type_name: string | null
  team: string
  role: string
  name: string
  model: string | null
  tmux_pane_id: string | null
  delivery: DeliverySpec
  channel_session_id: string | null
  last_seen_at: string
}

export interface AgentListRow extends AgentRow {
  online: boolean
}

export const ONLINE_MS = 5 * 60 * 1000

type DbAgentRow = {
  agent_id: string
  agent_type: AgentType | null
  agent_type_name: string | null
  team: string
  role: string
  name: string
  model: string | null
  tmux_pane_id: string | null
  last_seen_at: string
} & DeliveryRow

function toAgentRow(row: DbAgentRow): AgentRow {
  const delivery = parseDeliveryRow(row)
  return {
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    team: row.team,
    role: row.role,
    name: row.name,
    model: row.model,
    tmux_pane_id: row.tmux_pane_id,
    delivery,
    channel_session_id:
      delivery.kind === 'claude-channel' ? delivery.channel_session_id : null,
    last_seen_at: row.last_seen_at,
  }
}

export class AgentsRepo {
  constructor(private db: Database.Database) {
    // Bind hot read-paths so callers can destructure or extract method
    // references without losing `this` binding. (Tests in particular extract
    // `repo.list` to a local for type-cast purposes.)
    this.list = this.list.bind(this)
  }

  findByIdentity(args: { team: string; name: string }): { agent_id: string } | undefined {
    return this.db.prepare(
      `SELECT agent_id FROM agents WHERE team=? AND name=?`
    ).get(args.team, args.name) as { agent_id: string } | undefined
  }

  register(input: RegisterInput): {
    agent_id: string
    team: string
  } {
    const team = input.team ?? 'default'
    const role = input.role ?? 'default'
    const name = input.name
    const now = new Date().toISOString()
    const newId = randomUUID()
    const delivery = input.delivery ?? { kind: 'none' }
    const serialized = serializeDelivery(delivery)
    const preserveExistingDelivery = input.delivery === undefined ? 1 : 0
    const tx = this.db.transaction(() => {
      this.writeAgentRow({
        newId,
        input,
        team,
        role,
        name,
        now,
        serialized,
        preserveExistingDelivery,
      })
      const rebindCsid =
        role === '__channel_proxy__' &&
        input.claude_ui_pid !== undefined &&
        delivery.kind === 'claude-channel'
          ? delivery.channel_session_id
          : undefined
      if (rebindCsid !== undefined) {
        this.reactiveRebindHosts({
          team,
          claude_ui_pid: input.claude_ui_pid!,
          new_csid: rebindCsid,
        })
      }
    })
    tx()
    const row = this.db.prepare(`SELECT agent_id FROM agents WHERE team=? AND name=?`).get(team, name) as { agent_id: string }
    return { agent_id: row.agent_id, team }
  }

  private writeAgentRow(args: {
    newId: string
    input: RegisterInput
    team: string
    role: string
    name: string
    now: string
    serialized: ReturnType<typeof serializeDelivery>
    preserveExistingDelivery: number
  }): void {
    const { newId, input, team, role, name, now, serialized, preserveExistingDelivery } = args
    // Fresh INSERT initialises last_processed_event_id to MAX(event_id) so
    // newly registered agents do not see historical mail. The MAX read happens
    // inside the same SQLite transaction as the INSERT (writeAgentRow is always
    // called from `register`'s db.transaction). Reuse path preserves the
    // existing cursor — the ON CONFLICT branch deliberately does not touch
    // last_processed_event_id.
    this.db.prepare(
      `INSERT INTO agents (
         agent_id, agent_type, agent_type_name, team, role, name, model, registered_at, last_seen_at,
         tmux_pane_id, claude_ui_pid, runtime_ui_pid, delivery_kind, delivery_payload,
         last_processed_event_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               COALESCE((SELECT MAX(event_id) FROM events), 0))
       ON CONFLICT (team, name) DO UPDATE SET
         agent_type = excluded.agent_type,
         agent_type_name = excluded.agent_type_name,
         role = excluded.role,
         model = excluded.model,
         last_seen_at = excluded.last_seen_at,
         tmux_pane_id = COALESCE(excluded.tmux_pane_id, tmux_pane_id),
         claude_ui_pid = COALESCE(excluded.claude_ui_pid, claude_ui_pid),
         runtime_ui_pid = COALESCE(excluded.runtime_ui_pid, runtime_ui_pid),
         delivery_kind = CASE
           WHEN ? THEN delivery_kind
           ELSE excluded.delivery_kind
         END,
         delivery_payload = CASE
           WHEN ? THEN delivery_payload
           ELSE excluded.delivery_payload
         END`
    ).run(
      newId,
      input.agent_type ?? null,
      input.agent_type_name ?? null,
      team,
      role,
      name,
      input.model ?? null,
      now,
      now,
      input.tmux_pane_id ?? null,
      input.claude_ui_pid ?? null,
      input.runtime_ui_pid ?? null,
      serialized.delivery_kind,
      serialized.delivery_payload,
      preserveExistingDelivery,
      preserveExistingDelivery,
    )
  }

  private reactiveRebindHosts(args: {
    team: string
    claude_ui_pid: number
    new_csid: string
  }): void {
    this.db.prepare(
      `UPDATE agents
       SET delivery_kind = 'claude-channel',
           delivery_payload = json_object('channel_session_id', ?)
       WHERE role != '__channel_proxy__'
         AND runtime_ui_pid IS NOT NULL
         AND runtime_ui_pid = ?
         AND team = ?
         AND (
           delivery_kind = 'none'
           OR (delivery_kind = 'claude-channel'
               AND json_extract(delivery_payload,'$.channel_session_id') != ?)
         )`
    ).run(args.new_csid, args.claude_ui_pid, args.team, args.new_csid)
  }

  setDelivery(agent_id: string, spec: DeliverySpec): void {
    const serialized = serializeDelivery(spec)
    this.db.prepare(
      `UPDATE agents
       SET delivery_kind=?, delivery_payload=?
       WHERE agent_id=?`
    ).run(serialized.delivery_kind, serialized.delivery_payload, agent_id)
  }

  setAgentType(agent_id: string, agent_type: AgentType, agent_type_name?: string | null): void {
    this.db.prepare(
      `UPDATE agents
       SET agent_type=?,
           agent_type_name=?
       WHERE agent_id=?`
    ).run(agent_type, agent_type_name ?? null, agent_id)
  }

  setRuntimeBinding(
    agent_id: string,
    args: {
      tmux_pane_id: string
      runtime_ui_pid: number | null
      runtime_tty: string
      runtime_verification_mode: string
      runtime_bound_at?: string
    }
  ): void {
    this.db.prepare(
      `UPDATE agents
       SET tmux_pane_id=?,
           runtime_ui_pid=?,
           runtime_tty=?,
           runtime_verification_mode=?,
           runtime_bound_at=?
       WHERE agent_id=?`
    ).run(
      args.tmux_pane_id,
      args.runtime_ui_pid,
      args.runtime_tty,
      args.runtime_verification_mode,
      args.runtime_bound_at ?? new Date().toISOString(),
      agent_id
    )
  }

  list(args: { team: string; excludeRoles?: string[] }): AgentListRow[] {
    const exclude = args.excludeRoles ?? []
    const baseSelect =
      `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         team,
         role,
         name,
         model,
         tmux_pane_id,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE team=?`
    const orderBy = ` ORDER BY registered_at ASC`
    let rows: DbAgentRow[]
    if (exclude.length > 0) {
      const placeholders = exclude.map(() => '?').join(',')
      rows = this.db.prepare(
        `${baseSelect} AND role NOT IN (${placeholders})${orderBy}`
      ).all(args.team, ...exclude) as DbAgentRow[]
    } else {
      rows = this.db.prepare(`${baseSelect}${orderBy}`).all(args.team) as DbAgentRow[]
    }
    const nowMs = Date.now()
    return rows.map((row) => {
      const agent = toAgentRow(row)
      return {
        ...agent,
        online: nowMs - new Date(agent.last_seen_at).getTime() < ONLINE_MS,
      }
    })
  }

  touch(agent_id: string): void {
    this.db.prepare(`UPDATE agents SET last_seen_at=? WHERE agent_id=?`).run(new Date().toISOString(), agent_id)
  }

  listClaimedInProgressTaskIds(args: { agent_id: string; team: string }): string[] {
    const rows = this.db.prepare(
      `SELECT id
       FROM tasks
       WHERE team=? AND claimed_by=? AND status='in_progress'
       ORDER BY id ASC`
    ).all(args.team, args.agent_id) as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  deleteContractSubscriptions(args: { agent_id: string; team: string }): number {
    const result = this.db.prepare(
      `DELETE FROM contract_subscriptions
       WHERE agent_id=? AND team=?`
    ).run(args.agent_id, args.team)
    return result.changes
  }

  deleteById(agent_id: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM agents
       WHERE agent_id=?`
    ).run(agent_id)
    return result.changes === 1
  }

  getById(agent_id: string): AgentRow | undefined {
    const row = this.db.prepare(
      `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         team,
         role,
         name,
         model,
         tmux_pane_id,
         delivery_kind,
         delivery_payload,
         last_seen_at
       FROM agents
       WHERE agent_id=?`
    ).get(agent_id) as DbAgentRow | undefined
    if (!row) return undefined
    return toAgentRow(row)
  }

  findById(agent_id: string): AgentRow | undefined {
    return this.getById(agent_id)
  }
}
