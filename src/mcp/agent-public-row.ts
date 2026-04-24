import type { AgentListRow } from '../storage/agents-repo.js'
import type { DeliverySpec } from '../lib/delivery-spec.js'

export type PublicDelivery =
  | { kind: 'none' }
  | { kind: 'codex-appserver' }
  | { kind: 'claude-channel'; channel_session_id: string }

export interface PublicAgentListRow {
  agent_id: string
  client: AgentListRow['client']
  client_name: AgentListRow['client_name']
  team: string
  role: string
  name: string
  model: string | null
  tmux_pane_id: string | null
  delivery: PublicDelivery
  channel_session_id: string | null
  opencode_base_url: string | null
  opencode_session_id: string | null
  last_seen_at: string
  online: boolean
}

function projectDelivery(delivery: DeliverySpec): PublicDelivery {
  if (delivery.kind === 'claude-channel') {
    return {
      kind: 'claude-channel',
      channel_session_id: delivery.channel_session_id,
    }
  }
  return { kind: delivery.kind }
}

export function toPublicAgentRow(row: AgentListRow): PublicAgentListRow {
  return {
    agent_id: row.agent_id,
    client: row.client,
    client_name: row.client_name,
    team: row.team,
    role: row.role,
    name: row.name,
    model: row.model,
    tmux_pane_id: row.tmux_pane_id,
    delivery: projectDelivery(row.delivery),
    channel_session_id:
      row.delivery.kind === 'claude-channel'
        ? row.delivery.channel_session_id
        : null,
    opencode_base_url: row.opencode_base_url,
    opencode_session_id: row.opencode_session_id,
    last_seen_at: row.last_seen_at,
    online: row.online,
  }
}
