import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AgentsRepo } from '../storage/agents-repo.js'
import { EventsOutbox } from '../storage/events-outbox.js'
import { RegisterAgentService } from './register-agent.js'
import { SendMessageService } from './send-message.js'
import { BroadcastService } from './broadcast.js'
import { BroadcastToRoleService } from './broadcast-to-role.js'
import { GetInboxService } from './get-inbox.js'
import { TaskAddService } from './task-add.js'
import { TaskClaimService } from './task-claim.js'
import { TaskCompleteService } from './task-complete.js'
import { TaskListService } from './task-list.js'
import { RegisterContractService } from './register-contract.js'
import { SubscribeContractService } from './subscribe-contract.js'
import { GetContractService } from './get-contract.js'
import { DiffContractsService } from './diff-contracts.js'
import { PendingContractEventsService } from './pending-contract-events.js'
import { poke } from './poke.js'
import { wrapStorage } from '../daemon/errors.js'
import type { SseFanout } from '../daemon/sse-fanout.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { SubscribeChannelWakeService } from './subscribe-channel-wake.js'
import { BindChannelService } from './bind-channel.js'

export interface AgentIdHolder { current: string | undefined }

type TextContent = { content: Array<{ type: 'text'; text: string }> }

function toText(value: unknown): TextContent {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

const SEND_MESSAGE_DESC = [
  'Private 1→1 message to another agent.  By default auto-poke=true with quiet-guard (auto_poke:false opts out).',
  'For multi-recipient use broadcast (same-team) or broadcast_to_role (same-team, by role).',
  '除非用户明确指定 to_team, 不要跨 team 沟通 (explicitly set to_team only when user asks).',
  'Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, self); on guard_failed daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看), NOT the body — read bodies via get_inbox.',
  'to_agent_id sends are NOT filtered by online/idle — offline targets still receive the mailbox row.'
].join(' ')

const BROADCAST_DESC = [
  'Same-team broadcast to every other agent in the caller team.',
  'Auto-poke default true (quiet-guard + 30s/180s/600s retry; reports poked, poke_skip_reasons, retry_scheduled, retry_delays_s).  auto_poke:false opts out.',
  'For role filter use broadcast_to_role.  For cross-team 1→1 use send_message({to_team}).',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看) — never the body.  Read via get_inbox.',
  'Skips agents idle > 5 min (offline).'
].join(' ')

const BROADCAST_TO_ROLE_DESC = [
  'Same-team broadcast filtered by role.  Strictly same-team — no cross-team variant.',
  'For cross-team private 1→1 use send_message({to_team}).',
  'Auto-poke default true with quiet-guard + 30s/180s/600s retry (auto_poke:false opts out); injects only a SHORT wake-up hint, not the message body.  Recipients read via get_inbox.',
  'Returns unknown_recipient when no same-team agent matches to_role.'
].join(' ')

function hasUsableTransportId(args: {
  tmux_pane_id?: string; channel_session_id?: string
}): boolean {
  const tp = args.tmux_pane_id
  const cs = args.channel_session_id
  const tpOk = typeof tp === 'string' && tp.trim().length > 0
  const csOk = typeof cs === 'string' && cs.trim().length > 0
  return tpOk || csOk
}

export function buildAutoPokeHint(
  row: { name?: string | null } | undefined,
  fromAgentId: string
): string {
  const dn = row?.name
  const sender = typeof dn === 'string' && dn.length > 0
    ? `${dn} (${fromAgentId})`
    : fromAgentId.slice(0, 8)
  return `新邮件 from ${sender}, 请调 get_inbox 查看`
}

export function createAutoPokeImpl(
  db: Database.Database,
  _agents: AgentsRepo,
  channelWakeFanout?: ChannelWakeFanout
): import('./auto-poke-fanout.js').AutoPokeFn {
  return async (args) => {
    const row = db
      .prepare('SELECT name FROM agents WHERE agent_id=?')
      .get(args.fromAgentId) as { name: string | null } | undefined
    const hint = buildAutoPokeHint(row, args.fromAgentId)
    const res = await poke(
      { db, callerAgentId: args.fromAgentId, allowCrossTeam: true, channelWakeFanout },
      { target_agent_id: args.targetAgentId, prompt: hint }
    )
    if ('ok' in res && res.ok) return { ok: true }
    const err = (res as { error?: string }).error
    if (err === 'tmux_unavailable') return { ok: false, reason: 'tmux_unavailable' }
    if (err === 'tmux_pane_not_set') return { ok: false, reason: 'no_pane' }
    if (err === 'no_transport_available') return { ok: false, reason: 'no_pane' }
    if (err === 'self_poke_denied') return { ok: false, reason: 'self' }
    return { ok: false, reason: 'guard_failed' }
  }
}

export interface RegisterSuccessHook {
  (agent_id: string, team: string): void
}

export interface TransportLike {
  send(msg: Record<string, unknown>): Promise<void> | void
}

export function registerBusinessTools(
  server: McpServer,
  db: Database.Database,
  getCallerAgentId: () => string | undefined,
  fanout?: SseFanout,
  onRegisterSuccess?: RegisterSuccessHook,
  getSessionId?: () => string | undefined,
  channelWakeFanout?: ChannelWakeFanout,
  getTransport?: () => TransportLike
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const registerSvc = new RegisterAgentService(db)

  const autoPokeImpl = createAutoPokeImpl(db, agents, channelWakeFanout)

  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl })
  const broadcastSvc = new BroadcastService(db, agents, sendSvc, { poke: autoPokeImpl })
  const broadcastToRoleSvc = new BroadcastToRoleService(db, agents, events, { poke: autoPokeImpl })
  const inboxSvc = new GetInboxService(db, agents)
  const taskAddSvc = new TaskAddService(db, agents, events)
  const taskClaimSvc = new TaskClaimService(db, agents, events)
  const taskCompleteSvc = new TaskCompleteService(db, agents, events)
  const taskListSvc = new TaskListService(db, agents)
  const regContractSvc = new RegisterContractService(db, agents, events)
  const subContractSvc = new SubscribeContractService(db, agents)
  const getContractSvc = new GetContractService(db, agents)
  const diffContractsSvc = new DiffContractsService(db, agents)
  const pendingEventsSvc = new PendingContractEventsService(db, agents)

  function caller(): string | undefined { return getCallerAgentId() }

  async function run(fn: () => unknown): Promise<TextContent> {
    const out = await wrapStorage(() => fn())
    touchIfRegistered()
    return toText(out)
  }

  function touchIfRegistered(): void {
    const c = caller()
    if (!c) return
    try {
      if (agents.findById(c)) agents.touch(c)
    } catch { /* best-effort */ }
  }

  function requireAgent(): string | { error: 'unknown_agent' } {
    const c = caller()
    if (!c) return { error: 'unknown_agent' }
    const row = agents.findById(c)
    if (!row) return { error: 'unknown_agent' }
    return c
  }

  // register_agent — bootstrap: callable before an agents row exists for this session
  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description: [
        'Register this session as an agent in a team.',
        'Calling this tool again with the same `(team, name, role)` identity reuses the existing',
        '`agent_id` and refreshes `tmux_pane_id` and `model`; no duplicate row is created.',
        'BEFORE calling this tool, you MUST first check whether this process is running inside tmux.',
        'Run your shell tool with `echo "$TMUX_PANE"` (this env var is set per-pane by tmux and is',
        "the RELIABLE way to get your own pane id). Do NOT use `tmux display-message -p '#{pane_id}'`",
        'as the primary source: it returns the tmux *focused* pane, which may be a different agent\'s',
        "pane if multiple clients share the session. `tmux display-message` is only acceptable as a",
        'fallback when `$TMUX_PANE` is empty.',
        'If `echo "$TMUX_PANE"` prints a pane id like `%42` (non-empty output): you ARE in tmux —',
        'include that value as `tmux_pane_id` in THIS register_agent call. Without it, `poke` cannot',
        'wake your session across tmux panes.',
        'If the variable is empty AND `tmux display-message` also errors with "not a tmux client":',
        'skip the tmux_pane_id field.',
        'Most LLM coding agents (Claude Code, opencode, codex) run inside tmux by default, so the',
        'first branch is usually the right one. Do not skip the check.'
      ].join(' '),
      inputSchema: {
        model: z.string(),
        name: z.string().min(1).refine(v => v.trim().length > 0, { message: 'name must not be empty' }),
        role: z.string().optional(),
        team: z.string().optional(),
        tmux_pane_id: z.string().optional(),
        channel_session_id: z.string().optional()
      }
    },
    async (args: {
      model: string; name: string; role?: string; team?: string;
      tmux_pane_id?: string; channel_session_id?: string
    }) => {
      // connection_id for collision detection must be the stable session id,
      // NOT agentIdHolder.current (which becomes the agent_id after success).
      const connectionId = getSessionId?.() ?? caller()
      if (!connectionId) return toText({ error: 'unknown_agent' })
      return run(() => {
        const res = registerSvc.register({
          connection_id: connectionId,
          model: args.model,
          name: args.name,
          role: args.role,
          team: args.team,
          tmux_pane_id: args.tmux_pane_id,
          channel_session_id: args.channel_session_id
        })
        if ('agent_id' in res) {
          if (onRegisterSuccess) {
            try { onRegisterSuccess(res.agent_id, res.team) } catch { /* best-effort */ }
          } else if (fanout) {
            try { fanout.rebind(res.agent_id, res.team) } catch { /* best-effort */ }
          }
          if (!hasUsableTransportId(args)) {
            return {
              ...res,
              hint: "No transport identifier provided — neither tmux_pane_id nor channel_session_id. Cross-agent poke delivery is off until you re-register with at least one. For tmux_pane_id: run `echo \"$TMUX_PANE\"` in your shell tool (the env var is set per-pane by tmux). Fall back to `tmux display-message -p '#{pane_id}'` only if $TMUX_PANE is empty. For channel_session_id: it is produced by the ts-agent-teams channel plugin when running Claude Code with `--channels plugin:ts-agent-teams-channel@dev`; the plugin's proxy writes the id via bind_channel. Most coding agents (Claude Code, opencode, codex) run inside tmux, so tmux_pane_id is usually the right field to fill."
            }
          }
        }
        return res
      })
    }
  )

  // list_agents
  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description: 'List agents in the caller\'s team',
      inputSchema: {}
    },
    async () => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      const row = agents.findById(who)!
      return run(() => ({ agents: agents.list({ team: row.team }) }))
    }
  )

  // send_message
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description: SEND_MESSAGE_DESC,
      inputSchema: z.object({
        to_agent_id: z.string().min(1),
        to_team: z.string().min(1).optional(),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional()
      }).strict()
    },
    async (args: { to_agent_id: string; to_team?: string; subject?: string; body: string; auto_poke?: boolean }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => sendSvc.send({ from: who, ...args }))
    }
  )

  // broadcast
  server.registerTool(
    'broadcast',
    {
      title: 'Broadcast message',
      description: BROADCAST_DESC,
      inputSchema: {
        subject: z.string().optional(),
        body: z.string(),
        auto_poke: z.boolean().optional()
      }
    },
    async (args: { subject?: string; body: string; auto_poke?: boolean }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => broadcastSvc.broadcast({ from: who, ...args }))
    }
  )

  // broadcast_to_role
  server.registerTool(
    'broadcast_to_role',
    {
      title: 'Broadcast to role',
      description: BROADCAST_TO_ROLE_DESC,
      inputSchema: z.object({
        to_role: z.string().min(1),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional()
      }).strict()
    },
    async (args: { to_role: string; subject?: string; body: string; auto_poke?: boolean }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => broadcastToRoleSvc.broadcast({ from: who, ...args }))
    }
  )

  // get_inbox
  server.registerTool(
    'get_inbox',
    {
      title: 'Get inbox',
      description: 'Return messages addressed to caller after since_event_id',
      inputSchema: {
        since_event_id: z.number().int().optional(),
        limit: z.number().int().optional()
      }
    },
    async (args: { since_event_id?: number; limit?: number }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => inboxSvc.get({ caller: who, ...args }))
    }
  )

  // task_add
  server.registerTool(
    'task_add',
    {
      title: 'Add task',
      description: [
        "Add a new task to the team's task list.  Any team member can claim it via `task_claim`",
        'on their next turn.  If you want a specific agent to pick it up soon, follow up with',
        '`poke({ target_agent_id, prompt: "new task <id> — please task_claim" })`; otherwise the',
        'task will sit in the pending queue until someone pulls `task_list`.  `task_add` itself',
        'does NOT poke anyone, since broadcast-poking every agent on every new task would be noisy.'
      ].join(' '),
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        depends_on: z.array(z.string()).optional()
      }
    },
    async (args: { title: string; description?: string; depends_on?: string[] }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => taskAddSvc.add({ caller: who, ...args }))
    }
  )

  // task_claim
  server.registerTool(
    'task_claim',
    {
      title: 'Claim task',
      description: 'Claim a pending task as caller',
      inputSchema: { task_id: z.string() }
    },
    async (args: { task_id: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => taskClaimSvc.claim({ caller: who, task_id: args.task_id }))
    }
  )

  // task_complete
  server.registerTool(
    'task_complete',
    {
      title: 'Complete task',
      description: 'Mark the caller\'s in-progress task as completed',
      inputSchema: {
        task_id: z.string(),
        result: z.string().optional()
      }
    },
    async (args: { task_id: string; result?: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => taskCompleteSvc.complete({ caller: who, ...args }))
    }
  )

  // task_list
  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description: 'List tasks in the caller\'s team, optionally filtered by status',
      inputSchema: {
        status: z.enum(['pending', 'in_progress', 'completed']).optional()
      }
    },
    async (args: { status?: 'pending' | 'in_progress' | 'completed' }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => taskListSvc.list({ caller: who, status: args.status }))
    }
  )

  // register_contract
  server.registerTool(
    'register_contract',
    {
      title: 'Register contract',
      description: 'Register or upgrade a contract version',
      inputSchema: {
        name: z.string(),
        schema: z.record(z.unknown()),
        format: z.literal('jsonschema').optional(),
        note: z.string().optional()
      }
    },
    async (args: { name: string; schema: Record<string, unknown>; format?: 'jsonschema'; note?: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => {
        const res = regContractSvc.register({ caller: who, ...args })
        if ('version' in res && res._meta && fanout) {
          try {
            fanout.emitContractEvent(db, {
              to_team: res._meta.team,
              contract_name: res.name,
              version: res.version,
              event_id: res._meta.event_id,
              diff: res._meta.diff
            })
          } catch { /* push failure does not roll back event */ }
        }
        if ('version' in res) {
          const { _meta: _omit, ...publicRes } = res
          return publicRes
        }
        return res
      })
    }
  )

  // subscribe_contract
  server.registerTool(
    'subscribe_contract',
    {
      title: 'Subscribe contract',
      description: 'Subscribe the caller to a contract name\'s updates',
      inputSchema: { name: z.string() }
    },
    async (args: { name: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => subContractSvc.subscribe({ caller: who, name: args.name }))
    }
  )

  // get_contract
  server.registerTool(
    'get_contract',
    {
      title: 'Get contract',
      description: 'Fetch a contract version (latest by default)',
      inputSchema: {
        name: z.string(),
        version: z.number().int().optional()
      }
    },
    async (args: { name: string; version?: number }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => getContractSvc.get({ caller: who, ...args }))
    }
  )

  // diff_contracts
  server.registerTool(
    'diff_contracts',
    {
      title: 'Diff contracts',
      description: 'Compute diff between two versions of a contract',
      inputSchema: {
        name: z.string(),
        from_version: z.number().int(),
        to_version: z.number().int()
      }
    },
    async (args: { name: string; from_version: number; to_version: number }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => diffContractsSvc.diff({ caller: who, ...args }))
    }
  )

  // poke
  server.registerTool(
    'poke',
    {
      title: 'Poke agent',
      description: [
        'Wake another agent in the same team by injecting a SHORT wake-up hint into its tmux pane.',
        'The `prompt` is NOT a content channel — do NOT paste full messages, answers, or task payloads here.',
        'Content belongs in `send_message` (which persists to mailbox and auto-pokes by default).',
        'Use `poke` only when the recipient already has the content (via mailbox / task / contract event)',
        'and you want to nudge them to act on it sooner than their next natural turn.',
        'Good prompts are imperative one-liners, ideally < 200 characters, e.g.',
        '"you have a new urgent message, check get_inbox" or "R2 judging ready, read mailbox and reply".',
        'Returns pre/post pane capture tails. Soft recommendation: retry at most 3 times per target per short window.'
      ].join(' '),
      inputSchema: {
        target_agent_id: z.string(),
        prompt: z.string()
      }
    },
    async (args: { target_agent_id: string; prompt: string }) => {
      const who = requireAgent()
      const callerAgentId = typeof who === 'string' ? who : null
      const result = await poke({ db, callerAgentId, channelWakeFanout }, args)
      touchIfRegistered()
      return toText(result)
    }
  )

  // bind_channel — reserved for channel proxies (role=__channel_proxy__)
  {
    const bindSvc = new BindChannelService(db)
    server.registerTool(
      'bind_channel',
      {
        title: 'Bind channel_session_id to agent',
        description: [
          'Internal tool reserved for the ts-agent-teams channel proxy.',
          'Writes a channel_session_id to the (team, name) agent row.',
          'Returns agent_not_registered if the row does not exist (caller should backoff and retry).'
        ].join(' '),
        inputSchema: {
          team: z.string().min(1),
          name: z.string().min(1),
          channel_session_id: z.string().min(1)
        }
      },
      async (args: { team: string; name: string; channel_session_id: string }) => {
        const who = requireAgent()
        if (typeof who !== 'string') return toText(who)
        return run(() => bindSvc.bind({
          callerAgentId: who,
          team: args.team,
          name: args.name,
          channel_session_id: args.channel_session_id
        }))
      }
    )
  }

  // subscribe_channel_wake — reserved for channel proxies (role=__channel_proxy__)
  if (channelWakeFanout) {
    const subscribeSvc = new SubscribeChannelWakeService(db, channelWakeFanout)
    server.registerTool(
      'subscribe_channel_wake',
      {
        title: 'Subscribe channel wake',
        description: [
          'Internal tool reserved for the ts-agent-teams channel proxy.',
          'Attaches the caller\'s MCP session notification sink to a channel_session_id so the',
          'daemon can emit notifications/channel_wake to it.  Requires role=__channel_proxy__.'
        ].join(' '),
        inputSchema: { channel_session_id: z.string().min(1) }
      },
      async (args: { channel_session_id: string }) => {
        const who = requireAgent()
        if (typeof who !== 'string') return toText(who)
        const sid = getSessionId?.()
        if (!sid) return toText({ error: 'unknown_session' })
        const sink = (payload: unknown) => {
          const t = getTransport?.()
          if (!t) return
          try {
            void Promise.resolve(t.send(payload as Record<string, unknown>)).catch(() => { /* best-effort */ })
          } catch { /* best-effort */ }
        }
        return run(() => subscribeSvc.subscribe({
          callerAgentId: who,
          channel_session_id: args.channel_session_id,
          sessionId: sid,
          sink
        }))
      }
    )
  }

  // pending_contract_events
  server.registerTool(
    'pending_contract_events',
    {
      title: 'Pending contract events',
      description: 'Poll contract_registered events not yet seen',
      inputSchema: {
        since_event_id: z.number().int().optional(),
        limit: z.number().int().optional()
      }
    },
    async (args: { since_event_id?: number; limit?: number }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => pendingEventsSvc.poll({ caller: who, ...args }))
    }
  )
}
