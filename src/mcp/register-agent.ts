import type Database from 'better-sqlite3'
import {
  validateDeliveryForWrite,
  type DeliverySpec,
  type DeliveryValidationReason,
} from '../lib/delivery-spec.js'
import type { AgentType } from '../lib/agent-type.js'
import { deriveDefaultTeam } from '../lib/default-team.js'
import { AgentsRepo } from '../storage/agents-repo.js'
import type { SessionOriginInfo } from '../daemon/network-origin.js'

export { deriveDefaultTeam } from '../lib/default-team.js'

export interface RegisterInput {
  connection_id: string
  agent_type?: AgentType
  agent_type_name?: string
  model?: string
  device?: string
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
  | { error: 'device_spoofing_from_loopback' }
  | { error: 'device_required_from_remote' }
  | { error: 'device_spoofing_local_label_from_remote' }
  | { error: 'invalid_device_label' }
  | { error: 'invalid_name_label' }
  | { error: 'invalid_team_label' }

function identityKey(device: string, team: string, name: string): string {
  return `${device}\u0000${team}\u0000${name}`
}

function sharedRuntimeKey(
  agentType: AgentType | undefined,
  delivery: DeliverySpec | undefined
): string | undefined {
  if (agentType !== 'codex' || delivery?.kind !== 'codex-appserver') {
    return undefined
  }
  return delivery.thread_id
}

export function validateNameLabel(name: string): { ok: string } | { error: 'invalid_name_label' } {
  if (name.includes(':') || name.includes('(') || name.includes(')')) {
    return { error: 'invalid_name_label' }
  }
  return { ok: name }
}

export function validateTeamLabel(team: string): { ok: string } | { error: 'invalid_team_label' } {
  if (team.includes('(') || team.includes(')')) {
    return { error: 'invalid_team_label' }
  }
  return { ok: team }
}

export function resolveEffectiveDevice(args: {
  requestedDevice?: string
  originInfo?: SessionOriginInfo
  localDevice: string
}):
  | { ok: string; remote_addr: string | null }
  | { error: 'device_spoofing_from_loopback' | 'device_required_from_remote' | 'device_spoofing_local_label_from_remote' | 'invalid_device_label' } {
  const origin = args.originInfo?.origin ?? 'local'
  const remote_addr = args.originInfo?.remote_addr ?? null
  const requestedDevice = args.requestedDevice?.trim()

  if (origin === 'local') {
    if (requestedDevice && requestedDevice !== args.localDevice) {
      return { error: 'device_spoofing_from_loopback' }
    }
    return { ok: args.localDevice, remote_addr: null }
  }

  if (!requestedDevice) {
    return { error: 'device_required_from_remote' }
  }
  if (requestedDevice.includes(':') || requestedDevice.length > 64) {
    return { error: 'invalid_device_label' }
  }
  // Normalize the remote-supplied label using the same rules the daemon and
  // channel-cli apply to locally-derived labels (lowercase, non-[a-z0-9_-]
  // replaced with '-'). Without this, the same physical host registers under
  // different labels depending on which path issued the register_agent call
  // (e.g. `MyMac.local` via direct register vs `mymac-local` via channel-cli).
  // requestedDevice is already trimmed and non-empty above, and `replace` (not
  // `remove`) maps every char to at least one output char, so the normalized
  // value is also non-empty.
  const normalizedDevice = requestedDevice
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  if (normalizedDevice === args.localDevice) {
    return { error: 'device_spoofing_local_label_from_remote' }
  }
  return { ok: normalizedDevice, remote_addr }
}

export interface RegisterAgentDeps {
  /**
   * Called once for each conflicting connection during a cross-session
   * takeover. Returns true when the connection was found and close was issued.
   */
  closeSessionByConnectionId?: (connectionId: string) => boolean
  /** Optional debug log sink. */
  log?: (line: string) => void
  localDevice?: string
  getSessionOrigin?: (connectionId: string) => SessionOriginInfo | undefined
}

export class RegisterAgentService {
  private readonly repo: AgentsRepo
  private connections = new Map<
    string,
    Map<string, string | undefined>
  >()
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
    const validName = validateNameLabel(input.name)
    if ('error' in validName) return validName
    if (input.team !== undefined) {
      const validTeam = validateTeamLabel(input.team)
      if ('error' in validTeam) return validTeam
    }
    const resolvedDevice = resolveEffectiveDevice({
      requestedDevice: input.device,
      originInfo: this.deps.getSessionOrigin?.(input.connection_id),
      localDevice: this.deps.localDevice ?? 'local',
    })
    if ('error' in resolvedDevice) return resolvedDevice

    const team = deriveDefaultTeam({
      team: input.team,
      project_dir: input.project_dir,
    })
    const key = identityKey(resolvedDevice.ok, team, input.name)
    const runtimeKey = sharedRuntimeKey(input.agent_type, validated?.ok)
    this.bindConnection({
      key,
      connectionId: input.connection_id,
      runtimeKey,
      device: resolvedDevice.ok,
      team,
      name: input.name,
    })
    return this.repo.register({
      agent_type: input.agent_type,
      agent_type_name: input.agent_type_name,
      device: resolvedDevice.ok,
      model: input.model,
      name: input.name,
      role,
      team,
      tmux_pane_id: input.tmux_pane_id,
      delivery: validated?.ok,
      claude_ui_pid: input.claude_ui_pid,
      runtime_ui_pid: input.runtime_ui_pid,
      remote_addr: resolvedDevice.remote_addr,
    })
  }

  releaseConnection(_agent_id: string, connection_id: string): void {
    const remaining = Array.from(this.connections.entries()).flatMap(
      ([key, bindings]): Array<[
        string,
        Map<string, string | undefined>
      ]> => {
        if (!bindings.has(connection_id)) return [[key, bindings]]
        const next = new Map(
          Array.from(bindings.entries()).filter(
            ([connectionId]) => connectionId !== connection_id
          )
        )
        return next.size === 0 ? [] : [[key, next]]
      }
    )
    this.connections = new Map(remaining)
  }

  private bindConnection(input: {
    key: string
    connectionId: string
    runtimeKey: string | undefined
    device: string
    team: string
    name: string
  }): void {
    const current = this.connections.get(input.key) ?? new Map()
    const prior = Array.from(current.entries()).filter(
      ([connectionId]) => connectionId !== input.connectionId
    )
    const canShare = input.runtimeKey !== undefined && prior.every(
      ([, runtimeKey]) => runtimeKey === input.runtimeKey
    )
    if (prior.length === 0 || canShare) {
      const next = new Map([
        ...current.entries(),
        [input.connectionId, input.runtimeKey] as const,
      ])
      this.storeBindings(input.key, next)
      return
    }
    const failed = prior.flatMap(([connectionId, runtimeKey]) => {
      const close = this.closeConnection(connectionId)
      this.log(
        `register_agent takeover: old=${connectionId} ` +
        `new=${input.connectionId} device=${input.device} ` +
        `team=${input.team} name=${input.name} closed=${close.closed}`
      )
      return close.keepBinding
        ? [[connectionId, runtimeKey] as const]
        : []
    })
    this.storeBindings(
      input.key,
      new Map([
        ...failed,
        [input.connectionId, input.runtimeKey] as const,
      ])
    )
  }

  private closeConnection(connectionId: string): {
    closed: boolean
    keepBinding: boolean
  } {
    try {
      return {
        closed: this.deps.closeSessionByConnectionId?.(connectionId) ?? false,
        keepBinding: false,
      }
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
      this.log(
        `register_agent takeover close failed: old=${connectionId} ` +
        `cause=${detail}`,
        error
      )
      return { closed: false, keepBinding: true }
    }
  }

  private log(line: string, error?: unknown): void {
    try {
      this.deps.log?.(line)
    } catch (logError) {
      console.error('RegisterAgentService logger failed.', logError)
      if (error === undefined) console.error(line)
      else console.error(line, error)
      return
    }
    if (error !== undefined && this.deps.log === undefined) {
      console.error(line, error)
    }
  }

  private storeBindings(
    key: string,
    bindings: Map<string, string | undefined>
  ): void {
    const others = Array.from(this.connections.entries()).filter(
      ([existingKey]) => existingKey !== key
    )
    this.connections = new Map([...others, [key, bindings]])
  }
}
