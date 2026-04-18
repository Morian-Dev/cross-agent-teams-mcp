import { runQuietGuard } from './poke-guard.js'
import { isTmuxAvailable } from '../daemon/tmux-cli.js'

export type AutoPokeSkipReason = 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self'

export interface AutoPokeArgs {
  team: string
  fromAgentId: string
  targetAgentId: string
  paneId: string
  body: string
}

export type AutoPokeFn = (args: AutoPokeArgs) => Promise<{ ok: true } | { ok: false; reason?: AutoPokeSkipReason }>

export interface AutoPokeRecipient {
  agent_id: string
  tmux_pane_id: string | null
}

export interface FanoutDeps {
  poke?: AutoPokeFn
  tmuxAvailable?: () => Promise<boolean>
}

export interface FanoutResult {
  poked: boolean
  skipReasons: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
}

export async function fanoutAutoPoke(args: {
  team: string
  fromAgentId: string
  recipients: AutoPokeRecipient[]
  body: string
  deps: FanoutDeps
}): Promise<FanoutResult> {
  const pokeFn = args.deps.poke
  const tmuxAvail = args.deps.tmuxAvailable ?? isTmuxAvailable

  const results = await Promise.all(args.recipients.map(async (r) => {
    if (r.agent_id === args.fromAgentId) {
      return { agent_id: r.agent_id, poked: false, reason: 'self' as AutoPokeSkipReason }
    }
    if (!r.tmux_pane_id) {
      return { agent_id: r.agent_id, poked: false, reason: 'no_pane' as AutoPokeSkipReason }
    }
    if (!(await tmuxAvail())) {
      return { agent_id: r.agent_id, poked: false, reason: 'tmux_unavailable' as AutoPokeSkipReason }
    }
    if (!pokeFn) {
      return { agent_id: r.agent_id, poked: false, reason: 'tmux_unavailable' as AutoPokeSkipReason }
    }
    const guard = await runQuietGuard(r.tmux_pane_id)
    if (guard === 'fail') {
      return { agent_id: r.agent_id, poked: false, reason: 'guard_failed' as AutoPokeSkipReason }
    }
    const out = await pokeFn({
      team: args.team,
      fromAgentId: args.fromAgentId,
      targetAgentId: r.agent_id,
      paneId: r.tmux_pane_id,
      body: args.body
    })
    if (out.ok) return { agent_id: r.agent_id, poked: true, reason: undefined }
    return { agent_id: r.agent_id, poked: false, reason: (out.reason ?? 'guard_failed') as AutoPokeSkipReason }
  }))

  const poked = results.some(x => x.poked)
  const skipReasons = results
    .filter(x => !x.poked && x.reason !== undefined)
    .map(x => ({ agent_id: x.agent_id, reason: x.reason as AutoPokeSkipReason }))
  return { poked, skipReasons }
}
