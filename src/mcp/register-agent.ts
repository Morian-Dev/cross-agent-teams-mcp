import type Database from 'better-sqlite3'
import {
  validateDeliveryForWrite,
  type DeliveryValidationReason,
} from '../lib/delivery-spec.js'
import type { AgentType } from '../lib/agent-type.js'
import { deriveDefaultTeam } from '../lib/default-team.js'
import { AgentsRepo } from '../storage/agents-repo.js'

export { deriveDefaultTeam } from '../lib/default-team.js'

export interface RegisterInput {
  connection_id: string
  agent_type?: AgentType
  agent_type_name?: string
  model?: string
  name: string
  role?: string
  team?: string
  project_dir?: string
  tmux_pane_id?: string
  delivery?: unknown
  claude_ui_pid?: number
  runtime_ui_pid?: number
}

export type RegisterResult =
  | { agent_id: string; team: string }
  | { error: 'agent_id_collision' }
  | { error: 'invalid_delivery'; reason: DeliveryValidationReason }
  | { error: 'claude_ui_pid_requires_channel_proxy' }

function identityKey(team: string, name: string): string {
  return `${team}\u0000${name}`
}

export interface RegisterAgentDeps {
  /**
   * Cross-session takeover hook. When `register_agent` re-claims a `(team, name)`
   * binding from a NEW MCP session id, the service invokes this with the OLD
   * connection_id so the transport layer can force-close the prior session.
   * Returns true when the old session id was found and a close was issued.
   */
  closeSessionByConnectionId?: (connectionId: string) => boolean
  /**
   * Debug log sink. When omitted, takeover events go through `console.debug`.
   */
  log?: (line: string) => void
}

export class RegisterAgentService {
  private readonly repo: AgentsRepo
  private readonly connections = new Map<string, string>()
  private readonly deps: RegisterAgentDeps

  constructor(db: Database.Database, deps: RegisterAgentDeps = {}) {
    this.repo = new AgentsRepo(db)
    this.deps = deps
  }

  register(input: RegisterInput): RegisterResult {
    const validated =
      input.delivery === undefined
        ? undefined
        : validateDeliveryForWrite(input.delivery)
    if (validated && 'error' in validated) return validated

    const role = input.role ?? 'default'
    if (input.claude_ui_pid !== undefined && role !== '__channel_proxy__') {
      return { error: 'claude_ui_pid_requires_channel_proxy' }
    }

    const team = deriveDefaultTeam({
      team: input.team,
      project_dir: input.project_dir,
    })
    const key = identityKey(team, input.name)
    const bound = this.connections.get(key)
    if (bound && bound !== input.connection_id) {
      // Cross-session takeover: release the old binding and force-close the
      // prior MCP transport. The old session's `onclose` chain reaps it from
      // the daemon's `sessions` Map; new session keeps its existing binding.
      let closed = false
      if (this.deps.closeSessionByConnectionId) {
        try { closed = this.deps.closeSessionByConnectionId(bound) } catch { /* best-effort */ }
      }
      const log = this.deps.log ?? ((line: string) => { console.debug(line) })
      try {
        log(`register_agent takeover: old=${bound} new=${input.connection_id} team=${team} name=${input.name} closed=${closed}`)
      } catch { /* best-effort */ }
    }
    this.connections.set(key, input.connection_id)
    return this.repo.register({
      agent_type: input.agent_type,
      agent_type_name: input.agent_type_name,
      model: input.model,
      name: input.name,
      role,
      team,
      tmux_pane_id: input.tmux_pane_id,
      delivery: validated?.ok,
      claude_ui_pid: input.claude_ui_pid,
      runtime_ui_pid: input.runtime_ui_pid,
    })
  }

  releaseConnection(agent_id: string, connection_id: string): void {
    // Release by connection_id — scan and unbind any identity key mapped to this connection.
    for (const [k, cid] of this.connections) {
      if (cid === connection_id) this.connections.delete(k)
    }
    void agent_id
  }
}
