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
import { BindOpencodeSessionService } from './bind-opencode-session.js'
import { BindRuntimeIdentityService } from './bind-runtime-identity.js'
import { RegisterCodexSelfService } from './register-codex-self.js'
import { detectTmuxPane } from '../daemon/tmux-pane-detect.js'
import type { DetectAgentKind } from '../daemon/tmux-pane-detect.js'
import type { ClientKind } from '../lib/client-kind.js'

export interface AgentIdHolder { current: string | undefined }

type TextContent = { content: Array<{ type: 'text'; text: string }> }

function toText(value: unknown): TextContent {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

const deliverySchema = z.object({
  kind: z.string(),
}).passthrough()

const clientSchema = z.enum(['codex', 'claude-code', 'opencode'])

const detectTmuxPaneSchema = z.object({
  agent: z.enum(['codex', 'claude-code', 'opencode', 'custom']),
  cwd: z.string().optional(),
  tty: z.string().optional(),
  title_contains: z.string().optional(),
  process_pattern: z.string().optional(),
})

const detectTmuxPaneArgsSchema = detectTmuxPaneSchema.superRefine((value, ctx) => {
  if (value.agent === 'custom' && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['process_pattern'],
      message: 'process_pattern is required when agent=custom',
    })
  }
})

const bindRuntimeIdentitySchema = z.object({
  agent: z.enum(['codex', 'claude-code', 'opencode', 'custom']),
  ui_pid: z.number().int().positive().optional(),
  ui_tty: z.string().optional(),
  tmux_pane_id: z.string().min(1).optional(),
  process_pattern: z.string().optional(),
})

const bindRuntimeIdentityArgsSchema = bindRuntimeIdentitySchema.superRefine((value, ctx) => {
  if (value.agent === 'custom' && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['process_pattern'],
      message: 'process_pattern is required when agent=custom',
    })
  }
  const hasPid = value.ui_pid !== undefined
  const hasTtyPair =
    value.ui_tty !== undefined &&
    value.ui_tty.trim().length > 0 &&
    value.tmux_pane_id !== undefined &&
    value.tmux_pane_id.trim().length > 0
  if (!hasPid && !hasTtyPair) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide ui_pid, or ui_tty together with tmux_pane_id',
    })
  }
})

const SEND_MESSAGE_DESC = [
  'Private 1→1 message to another agent.  By default auto-poke=true with quiet-guard (auto_poke:false opts out).',
  'Provide exactly one of to_agent_id (UUID) or to_agent_name (the target\'s `name` in its team); to_agent_name is preferred when you know the target by (team, name).',
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

function suppressTmuxHint(
  args: { delivery?: { kind?: string } }
): boolean {
  return args.delivery?.kind !== undefined && args.delivery.kind !== 'none'
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

export interface SessionClientInfo {
  name?: string
  version?: string
}

function inferRuntimeAgentKind(
  args: { client?: ClientKind; delivery?: { kind?: string }; model: string },
  clientInfo: SessionClientInfo | undefined
): DetectAgentKind | undefined {
  if (args.client) return args.client
  if (args.delivery?.kind === 'codex-appserver') return 'codex'

  const raw = `${clientInfo?.name ?? ''} ${clientInfo?.version ?? ''} ${args.model}`.toLowerCase()
  if (raw.includes('codex')) return 'codex'
  if (raw.includes('gpt-')) return 'codex'
  if (raw.includes('claude')) return 'claude-code'
  if (raw.includes('opus') || raw.includes('sonnet')) return 'claude-code'
  if (raw.includes('opencode')) return 'opencode'
  return undefined
}

export function registerBusinessTools(
  server: McpServer,
  db: Database.Database,
  getCallerAgentId: () => string | undefined,
  fanout?: SseFanout,
  onRegisterSuccess?: RegisterSuccessHook,
  getSessionId?: () => string | undefined,
  channelWakeFanout?: ChannelWakeFanout,
  getTransport?: () => TransportLike,
  getSessionClientInfo?: () => SessionClientInfo | undefined
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const registerSvc = new RegisterAgentService(db)
  const bindRuntimeIdentitySvc = new BindRuntimeIdentityService(db)
  const registerCodexSelfSvc = new RegisterCodexSelfService(registerSvc)

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

  async function autoBindRuntimeIdentity(
    args: {
      client?: ClientKind
      model: string
      delivery?: { kind?: string }
      ui_pid?: number
    },
    callerAgentId: string
  ): Promise<boolean> {
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.())
    if (!inferredAgent) return false

    if (args.ui_pid !== undefined) {
      const boundByPid = await bindRuntimeIdentitySvc.bind({
        callerAgentId,
        agent: inferredAgent,
        ui_pid: args.ui_pid,
      })
      return 'ok' in boundByPid && boundByPid.ok
    }

    const detected = await detectTmuxPane({ agent: inferredAgent })
    if (!('ok' in detected) || !detected.ok) return false

    const bound = await bindRuntimeIdentitySvc.bind({
      callerAgentId,
      agent: inferredAgent,
      ui_tty: detected.pane.tty,
      tmux_pane_id: detected.pane.pane_id,
    })
    return 'ok' in bound && bound.ok
  }

  const registerAgentArgsSchema = z.object({
    model: z.string(),
    name: z.string().min(1).refine(v => v.trim().length > 0, { message: 'name must not be empty' }),
    role: z.string().optional(),
    team: z.string().optional(),
    client: clientSchema.optional(),
    ui_pid: z.number().int().positive().optional(),
    channel_session_id: z.string().min(1).optional(),
    base_url: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).refine(v => v.trim().length > 0, { message: 'thread_id must not be empty' }).optional(),
    ws_url: z.string().optional(),
    auth_token_ref: z.string().min(1).optional(),
    delivery: deliverySchema.optional(),
  }).strict().superRefine((value, ctx) => {
    const hasCodexFields =
      value.thread_id !== undefined ||
      value.ws_url !== undefined ||
      value.auth_token_ref !== undefined
    if (hasCodexFields && value.client !== 'codex') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['client'],
        message: 'client=codex is required when thread_id, ws_url, or auth_token_ref is provided',
      })
    }
    if (value.channel_session_id !== undefined && value.client !== 'claude-code') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['client'],
        message: 'client=claude-code is required when channel_session_id is provided',
      })
    }
    const hasOpencodeFields =
      value.base_url !== undefined ||
      value.session_id !== undefined
    if (hasOpencodeFields && value.client !== 'opencode') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['client'],
        message: 'client=opencode is required when base_url or session_id is provided',
      })
    }
    if ((value.base_url === undefined) !== (value.session_id === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'base_url and session_id must be provided together',
      })
    }
  })

  // register_agent — bootstrap: callable before an agents row exists for this session
  server.registerTool(
    'detect_tmux_pane',
    {
      title: 'Detect tmux pane',
      description: [
        'Detect the tmux pane that is actually hosting a coding agent UI, even when the shell calling tools lives in a different pane.',
        'The detector scans tmux panes globally, maps each pane to its tty, then inspects real tty processes instead of trusting `$TMUX_PANE` or tmux focus state alone.',
        'Use `agent` to pick a built-in matcher for Codex, Claude Code, or opencode.',
        'Optional `cwd`, `tty`, and `title_contains` narrow the search and make cross-directory multi-agent sessions much more reliable.',
        'Returns either a single best pane, or an ambiguity/not-found result with candidates for debugging.'
      ].join(' '),
      inputSchema: detectTmuxPaneSchema,
    },
    async (args: {
      agent: 'codex' | 'claude-code' | 'opencode' | 'custom'
      cwd?: string
      tty?: string
      title_contains?: string
      process_pattern?: string
    }) => run(async () => {
      const parsed = detectTmuxPaneArgsSchema.safeParse(args)
      if (!parsed.success) {
        return {
          error: 'invalid_arguments' as const,
          detail: parsed.error.issues.map(issue => issue.message).join('; '),
        }
      }
      return detectTmuxPane({
        agent: parsed.data.agent,
        cwd: parsed.data.cwd,
        tty: parsed.data.tty,
        title_contains: parsed.data.title_contains,
        process_pattern: parsed.data.process_pattern,
      })
    })
  )

  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description: [
        'Register this session as an agent in a team.',
        'This is the unified registration entry point.',
        'Calling this tool again with the same `(team, name, role)` identity reuses the existing',
        '`agent_id` and refreshes `tmux_pane_id` and `model`; no duplicate row is created.',
        'Callers may pass `client` to declare the runtime explicitly instead of relying on local-client inference.',
        'Claude Code sessions can pass `client="claude-code"` together with `channel_session_id` to bind channel delivery through this same tool.',
        'Opencode sessions can pass `client="opencode"` together with `base_url` and `session_id` to bind server delivery through this same tool.',
        'Codex sessions can pass `client="codex"` together with `thread_id` to register Codex app-server delivery through this same tool.',
        'When available, callers may pass `ui_pid` so automatic runtime binding can use verified pid → tty → pane evidence instead of heuristic pane detection.',
        'After registration, the daemon best-effort attempts runtime binding for recognized local clients so tmux-based poke delivery can come up without a second tool call.',
        'If automatic runtime binding does not converge, call `bind_runtime_identity(...)` explicitly so the daemon can verify and persist your pane binding.',
        '`detect_tmux_pane(...)` remains available as a debugging aid for ambiguous or missing matches, but it does not write registry state by itself.',
        'When registration still has no usable `tmux_pane_id`, tmux-based poke delivery stays unavailable until automatic or explicit runtime binding succeeds.'
      ].join(' '),
      inputSchema: registerAgentArgsSchema
    },
    async (args: {
      client?: ClientKind
      model: string; name: string; role?: string; team?: string;
      ui_pid?: number;
      channel_session_id?: string
      base_url?: string
      session_id?: string
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      delivery?: { kind: string; [key: string]: unknown }
    }) => {
      // connection_id for collision detection must be the stable session id,
      // NOT agentIdHolder.current (which becomes the agent_id after success).
      const connectionId = getSessionId?.() ?? caller()
      if (!connectionId) return toText({ error: 'unknown_agent' })
      return run(async () => {
        let nativeDeliveryBound = suppressTmuxHint(args)
        const bindChannelSvc = channelWakeFanout
          ? new BindChannelService(db, channelWakeFanout)
          : undefined
        const bindOpencodeSvc = new BindOpencodeSessionService(db)
        const res =
          args.client === 'codex' && args.delivery === undefined
            ? await registerCodexSelfSvc.register({
                connection_id: connectionId,
                name: args.name,
                model: args.model,
                role: args.role,
                team: args.team,
                thread_id: args.thread_id,
                ws_url: args.ws_url,
                auth_token_ref: args.auth_token_ref,
              })
            : registerSvc.register({
                connection_id: connectionId,
                client: args.client,
                model: args.model,
                name: args.name,
                role: args.role,
                team: args.team,
                delivery: args.delivery,
              })
        if ('thread_id' in res && 'agent_id' in res) {
          nativeDeliveryBound = true
        }
        if ('agent_id' in res) {
          if (onRegisterSuccess) {
            try { onRegisterSuccess(res.agent_id, res.team) } catch { /* best-effort */ }
          } else if (fanout) {
            try { fanout.rebind(res.agent_id, res.team) } catch { /* best-effort */ }
          }
          if (args.client === 'claude-code' && args.channel_session_id !== undefined) {
            const channelBind = bindChannelSvc
              ? bindChannelSvc.bind({
                  callerAgentId: res.agent_id,
                  channel_session_id: args.channel_session_id,
                })
              : { error: 'unknown_channel_session' as const }
            if ('ok' in channelBind && channelBind.ok) {
              nativeDeliveryBound = true
            } else {
              return channelBind
            }
          }
          if (args.client === 'opencode' && args.base_url !== undefined && args.session_id !== undefined) {
            const opencodeBind = bindOpencodeSvc.bind({
              callerAgentId: res.agent_id,
              base_url: args.base_url,
              session_id: args.session_id,
            })
            if ('ok' in opencodeBind && opencodeBind.ok) {
              nativeDeliveryBound = true
            } else {
              return opencodeBind
            }
          }
          const autoBound = await autoBindRuntimeIdentity(args, res.agent_id)
          if (autoBound) return res
          if (!nativeDeliveryBound) {
            return {
              ...res,
              hint: "No usable tmux_pane_id is bound yet — automatic runtime binding did not converge for this session, so cross-agent poke delivery via tmux is still off. Call `bind_runtime_identity(...)` to bind explicitly, or use `detect_tmux_pane(...)` for debugging. Claude Code users who loaded the cross-agent-teams-mcp channel plugin can also route pokes via channel_session_id — that path does not require tmux binding."
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
        to_agent_id: z.string().min(1).optional(),
        to_agent_name: z.string().min(1).optional(),
        to_team: z.string().min(1).optional(),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional()
      }).strict()
    },
    async (args: { to_agent_id?: string; to_agent_name?: string; to_team?: string; subject?: string; body: string; auto_poke?: boolean }) => {
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

  // bind_channel — self-binding: caller (Claude host) writes its own channel_session_id
  if (channelWakeFanout) {
    const bindSvc = new BindChannelService(db, channelWakeFanout)
    server.registerTool(
      'bind_channel',
      {
        title: 'Bind channel_session_id to caller',
        description: [
          'Low-level rebind tool for Claude channel delivery.',
          'Bind the caller session\'s agent row to a channel_session_id produced by the cross-agent-teams-mcp channel proxy.',
          'Most callers should prefer `register_agent({ client: "claude-code", channel_session_id, ... })` on the unified registration path.',
          'Call this when you need to rebind an already-registered row after the proxy announces a new csid.',
          'Rejects proxy callers (role=__channel_proxy__).',
          'Rejects unknown csid (no live proxy sink attached).'
        ].join(' '),
        inputSchema: {
          channel_session_id: z.string().min(1)
        }
      },
      async (args: { channel_session_id: string }) => {
        const who = requireAgent()
        if (typeof who !== 'string') return toText(who)
        return run(() => bindSvc.bind({
          callerAgentId: who,
          channel_session_id: args.channel_session_id
        }))
      }
    )
  }

  server.registerTool(
    'bind_runtime_identity',
    {
      title: 'Bind runtime identity to caller',
      description: [
        'Bind the caller session\'s agent row to a verified tmux runtime identity.',
        'Pass `agent` to choose the built-in process matcher (`codex`, `claude-code`, `opencode`), or use `custom` together with `process_pattern`.',
        'Prefer passing `ui_pid` for the visible agent UI process; the daemon verifies pid → tty → pane before persisting `tmux_pane_id`.',
        'If `ui_pid` is unavailable, pass `ui_tty` together with `tmux_pane_id` for a weaker but still verified binding path.',
        'This tool writes registry state; `detect_tmux_pane` is for debugging only.'
      ].join(' '),
      inputSchema: bindRuntimeIdentitySchema,
    },
    async (args: {
      agent: 'codex' | 'claude-code' | 'opencode' | 'custom'
      ui_pid?: number
      ui_tty?: string
      tmux_pane_id?: string
      process_pattern?: string
    }) => {
      const parsed = bindRuntimeIdentityArgsSchema.safeParse(args)
      if (!parsed.success) {
        return toText({
          error: 'invalid_arguments',
          detail: parsed.error.issues.map(issue => issue.message).join('; '),
        })
      }
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => bindRuntimeIdentitySvc.bind({
        callerAgentId: who,
        agent: parsed.data.agent,
        ui_pid: parsed.data.ui_pid,
        ui_tty: parsed.data.ui_tty,
        tmux_pane_id: parsed.data.tmux_pane_id,
        process_pattern: parsed.data.process_pattern,
      }))
    }
  )

  // subscribe_channel_wake — reserved for channel proxies (role=__channel_proxy__)
  if (channelWakeFanout) {
    const subscribeSvc = new SubscribeChannelWakeService(db, channelWakeFanout)
    server.registerTool(
      'subscribe_channel_wake',
      {
        title: 'Subscribe channel wake',
        description: [
          'Internal tool reserved for the cross-agent-teams-mcp channel proxy.',
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

  // bind_opencode_session — self-binding for opencode hosts
  const bindOpencodeSvc = new BindOpencodeSessionService(db)
  server.registerTool(
    'bind_opencode_session',
    {
      title: 'Bind opencode session to caller',
      description: [
        'Low-level rebind tool for opencode server delivery.',
        'Bind the caller session\'s agent row to an opencode server session.',
        'Most callers should prefer `register_agent({ client: "opencode", base_url, session_id, ... })` on the unified registration path.',
        'Call this when you need to rebind an already-registered row after the opencode session metadata changes.',
        'The base_url must be a loopback address (127.0.0.1, localhost, or ::1).',
        'The session_id is the opencode session identifier from the server.'
      ].join(' '),
      inputSchema: {
        base_url: z.string().min(1),
        session_id: z.string().min(1)
      }
    },
    async (args: { base_url: string; session_id: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => bindOpencodeSvc.bind({
        callerAgentId: who,
        base_url: args.base_url,
        session_id: args.session_id
      }))
    }
  )

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
