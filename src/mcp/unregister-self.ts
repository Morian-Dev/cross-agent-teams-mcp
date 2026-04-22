import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'

export type UnregisterSelfResult =
  | { ok: true; team: string; name: string; agent_id: string }
  | { error: 'unknown_agent' }
  | { error: 'tasks_in_progress'; task_ids: string[] }

export class UnregisterSelfService {
  constructor(
    private readonly db: Database.Database,
    private readonly agents: AgentsRepo
  ) {}

  unregister(args: { caller: string }): UnregisterSelfResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }

    const task_ids = this.agents.listClaimedInProgressTaskIds({
      agent_id: caller.agent_id,
      team: caller.team,
    })
    if (task_ids.length > 0) {
      return { error: 'tasks_in_progress', task_ids }
    }

    let removed = false
    const tx = this.db.transaction(() => {
      removed = this.agents.deleteById(caller.agent_id)
      if (!removed) return
      this.agents.deleteContractSubscriptions({
        agent_id: caller.agent_id,
        team: caller.team,
      })
    })
    tx()

    if (!removed) return { error: 'unknown_agent' }
    return {
      ok: true,
      team: caller.team,
      name: caller.name,
      agent_id: caller.agent_id,
    }
  }
}
