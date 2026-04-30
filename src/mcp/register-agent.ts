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

export class RegisterAgentService {
  private readonly repo: AgentsRepo
  private readonly connections = new Map<string, string>()

  constructor(db: Database.Database) { this.repo = new AgentsRepo(db) }

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
    if (bound && bound !== input.connection_id) return { error: 'agent_id_collision' }
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
