import type Database from 'better-sqlite3'

export interface SseSink {
  send(msg: Record<string, unknown>): void
  close(): void
}

interface Session { agent_id: string; team: string; sink: SseSink }

export class SseFanout {
  private sessions = new Map<string, Session>()

  attach(agent_id: string, team: string, sink: SseSink): void {
    this.sessions.set(agent_id, { agent_id, team, sink })
  }

  rebind(agent_id: string, team: string): void {
    const s = this.sessions.get(agent_id)
    if (!s) return
    this.sessions.set(agent_id, { agent_id, team, sink: s.sink })
  }

  detach(agent_id: string): void {
    const s = this.sessions.get(agent_id)
    if (s) { try { s.sink.close() } catch { /* ignore */ } this.sessions.delete(agent_id) }
  }

  peek(): Array<{ agent_id: string; team: string }> {
    return Array.from(this.sessions.values()).map(s => ({ agent_id: s.agent_id, team: s.team }))
  }

  emitContractEvent(
    db: Database.Database,
    args: { team: string; contract_name: string; version: number; event_id: number; diff: unknown | null }
  ): void {
    const subs = db.prepare(
      `SELECT agent_id FROM contract_subscriptions WHERE team=? AND contract_name=?`
    ).all(args.team, args.contract_name) as Array<{ agent_id: string }>
    const subscribedSet = new Set(subs.map(s => s.agent_id))
    for (const session of this.sessions.values()) {
      if (session.team !== args.team) continue
      if (!subscribedSet.has(session.agent_id)) continue
      try {
        session.sink.send({
          type: 'contract_event',
          event_id: args.event_id,
          contract_name: args.contract_name,
          version: args.version,
          diff: args.diff
        })
      } catch { /* broken sink; swallow */ }
    }
  }
}
