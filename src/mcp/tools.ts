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
import { GetDeliveryStatusService } from './delivery-status.js'
import { poke } from './poke.js'
import { wrapStorage } from '../daemon/errors.js'
import type { SseFanout } from '../daemon/sse-fanout.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { SubscribeChannelWakeService } from './subscribe-channel-wake.js'
import { BindChannelService } from './bind-channel.js'
import { AutoBindChannelService } from './auto-bind-channel.js'
import { BindRuntimeIdentityService } from './bind-runtime-identity.js'
import { RegisterCodexSelfService } from './register-codex-self.js'
import { UnregisterSelfService } from './unregister-self.js'
import { toPublicAgentRow } from './agent-public-row.js'
import { detectTmuxPane } from '../daemon/tmux-pane-detect.js'
import { bindRuntimeIdentity } from '../daemon/runtime-identity.js'
import type { DetectAgentKind } from '../daemon/tmux-pane-detect.js'
import type { AgentType } from '../lib/agent-type.js'
import { CodexPanePreRegRepo } from './codex-pane-pre-register-repo.js'
import {
  PreRegisterCodexPaneService,
  preRegisterCodexPaneInputSchema,
} from './pre-register-codex-pane.js'
import { autoBindCodexPane } from './auto-bind-codex-pane.js'

export interface AgentIdHolder { current: string | undefined }

type TextContent = { content: Array<{ type: 'text'; text: string }> }

function toText(value: unknown): TextContent {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

const deliverySchema = z.object({
  kind: z.string(),
}).passthrough()

const agentTypeSchema = z.enum(['codex', 'claude-code', 'opencode', 'custom'])

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
  'Private 1→1 message to another agent by name.  By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.',
  'Set need_reply:false for FYI/no-response-needed messages; recipients see need_reply in get_inbox.',
  'to_agent_name is the target\'s `name` within its team; this is the preferred addressing form.  For UUID-based sends use send_message_by_id.',
  'For multi-recipient use broadcast (same-team) or broadcast_to_role (same-team, by role).',
  '除非用户明确指定 to_team, 不要跨 team 沟通 (explicitly set to_team only when user asks).',
  'Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, self); on guard_failed daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看), NOT the body — read bodies via get_inbox.',
  'Delivery is NOT filtered by online/idle (unlike broadcast\'s 5 min idle skip) — offline targets still receive the mailbox row.'
].join(' ')

const SEND_MESSAGE_BY_ID_DESC = [
  'Private 1→1 message to another agent by agent_id (UUID).  Use this when you already hold the target\'s agent_id; prefer send_message (by name) otherwise.',
  'Same-team only: the recipient must belong to the caller\'s team.  For cross-team sends use send_message with to_team.',
  'By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.  Set need_reply:false for FYI/no-response-needed messages.',
  'Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, self); on guard_failed daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看), NOT the body — read bodies via get_inbox.',
  'Delivery is NOT filtered by online/idle — offline targets still receive the mailbox row.'
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

function defaultClaudeSelfModel(
  clientInfo: SessionClientInfo | undefined
): string {
  const raw = `${clientInfo?.name ?? ''} ${clientInfo?.version ?? ''}`.trim()
  if (/claude/i.test(raw)) return raw
  return 'claude-code'
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

export interface UnregisterSuccessHook {
  (agent_id: string): void
}

export interface TransportLike {
  send(msg: Record<string, unknown>): Promise<void> | void
}

export interface SessionClientInfo {
  name?: string
  version?: string
}

function inferRuntimeAgentKind(
  args: { agent_type?: AgentType; delivery?: { kind?: string }; model?: string },
  clientInfo: SessionClientInfo | undefined
): DetectAgentKind | undefined {
  if (args.agent_type === 'custom') return undefined
  if (args.agent_type) return args.agent_type
  if (args.delivery?.kind === 'codex-appserver') return 'codex'

  const raw = `${clientInfo?.name ?? ''} ${clientInfo?.version ?? ''} ${args.model ?? ''}`.toLowerCase()
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
  getSessionClientInfo?: () => SessionClientInfo | undefined,
  onUnregisterSuccess?: UnregisterSuccessHook
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const registerSvc = new RegisterAgentService(db)
  const bindRuntimeIdentitySvc = new BindRuntimeIdentityService(db)
  const registerCodexSelfSvc = new RegisterCodexSelfService(registerSvc)
  const unregisterSelfSvc = new UnregisterSelfService(db, agents)

  const autoPokeImpl = createAutoPokeImpl(db, agents, channelWakeFanout)

  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl })
  const broadcastSvc = new BroadcastService(db, agents, { poke: autoPokeImpl })
  const broadcastToRoleSvc = new BroadcastToRoleService(db, agents, events, { poke: autoPokeImpl })
  const inboxSvc = new GetInboxService(db, agents)
  const deliveryStatusSvc = new GetDeliveryStatusService(db)
  const taskAddSvc = new TaskAddService(db, agents, events)
  const taskClaimSvc = new TaskClaimService(db, agents, events)
  const taskCompleteSvc = new TaskCompleteService(db, agents, events)
  const taskListSvc = new TaskListService(db, agents)
  const regContractSvc = new RegisterContractService(db, agents, events)
  const subContractSvc = new SubscribeContractService(db, agents)
  const getContractSvc = new GetContractService(db, agents)
  const diffContractsSvc = new DiffContractsService(db, agents)
  const pendingEventsSvc = new PendingContractEventsService(db, agents)
  const codexPanePreRegRepo = new CodexPanePreRegRepo(db)
  const preRegisterCodexPaneSvc = new PreRegisterCodexPaneService(codexPanePreRegRepo)

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
      agent_type?: AgentType
      model?: string
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

    if (inferredAgent === 'codex') {
      const auto = await autoBindCodexPane({
        callerAgentId,
        repo: codexPanePreRegRepo,
        bindRuntimeIdentitySvc,
      })
      if (auto) return true
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

  async function preflightUiPidClient(
    args: {
      agent_type?: AgentType
      model?: string
      delivery?: { kind?: string }
      ui_pid?: number
    }
  ): Promise<
    | undefined
    | {
        error: 'ui_pid_client_mismatch'
        detail: string
      }
  > {
    if (args.ui_pid === undefined) return undefined
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.())
    if (!inferredAgent) return undefined

    const validated = await bindRuntimeIdentity({
      agent: inferredAgent,
      ui_pid: args.ui_pid,
    })
    if (!('error' in validated) || validated.error !== 'agent_process_mismatch') {
      return undefined
    }

    return {
      error: 'ui_pid_client_mismatch',
      detail:
        `ui_pid ${args.ui_pid} does not belong to agent_type=\"${inferredAgent}\". ` +
        'Pass the runtime kind for the process behind ui_pid; for example, use agent_type="opencode" when ui_pid points at an opencode process.',
    }
  }

  const registerAgentInputSchema = z.object({
    model: z.string().optional(),
    name: z.string().min(1).refine(v => v.trim().length > 0, { message: 'name must not be empty' }),
    role: z.string().optional(),
    team: z.string().optional(),
    project_dir: z.string().min(1).optional(),
    agent_type: agentTypeSchema,
    agent_type_name: z.string().min(1).optional(),
    ui_pid: z.number().int().positive().optional().describe(
      'STRONGLY RECOMMENDED. Visible agent UI process pid (e.g. Claude Code CLI pid — `$PPID` from a Bash tool call inside Claude Code). Enables one-shot pid → tty → pane binding at registration; without it, tmux-based cross-agent poke delivery typically stays off.'
    ),
    channel_session_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).refine(v => v.trim().length > 0, { message: 'thread_id must not be empty' }).optional(),
    ws_url: z.string().optional(),
    auth_token_ref: z.string().min(1).optional(),
    claude_ui_pid: z.number().int().positive().optional().describe(
      "Internal field for the cross-agent-teams-mcp channel proxy.  Stores the proxy's parent Claude Code UI pid (`process.ppid`) so that Claude Code hosts registering in the same lineage can auto-bind their claude-channel delivery.  Only valid when role='__channel_proxy__'; rejected otherwise."
    ),
    delivery: deliverySchema.optional(),
  }).strict(
    'Unrecognized key in register_agent input. Note: the fields `client` and `client_name` were renamed to `agent_type` and `agent_type_name` in 0.5.0.'
  )

  const registerAgentArgsSchema = registerAgentInputSchema.superRefine((value, ctx) => {
    const hasCodexFields =
      value.thread_id !== undefined ||
      value.ws_url !== undefined ||
      value.auth_token_ref !== undefined
    if (hasCodexFields && value.agent_type !== 'codex') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=codex is required when thread_id, ws_url, or auth_token_ref is provided',
      })
    }
    if (value.channel_session_id !== undefined && value.agent_type !== 'claude-code') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=claude-code is required when channel_session_id is provided',
      })
    }
    if (value.agent_type_name !== undefined && value.agent_type !== 'custom') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type_name'],
        message: 'agent_type_name is only allowed when agent_type=custom',
      })
    }
    if (value.claude_ui_pid !== undefined && value.role !== '__channel_proxy__') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claude_ui_pid'],
        message: "claude_ui_pid is only allowed when role='__channel_proxy__'",
      })
    }
    if (
      value.agent_type === 'codex' &&
      value.delivery === undefined &&
      (value.thread_id === undefined || value.thread_id === '')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thread_id'],
        message:
          'thread_id is required when agent_type="codex". '
          + 'If you are a launcher pre-registering a codex pane, use pre_register_codex_pane instead.',
      })
    }
  })

  async function executeRegister(
    args: {
      agent_type?: AgentType
      agent_type_name?: string
      model?: string
      name: string
      role?: string
      team?: string
      project_dir?: string
      ui_pid?: number
      channel_session_id?: string
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      claude_ui_pid?: number
      delivery?: { kind: string; [key: string]: unknown }
    }
  ): Promise<unknown> {
    let nativeDeliveryBound = suppressTmuxHint(args)
    let autoBoundChannelCsid: string | undefined
    const bindChannelSvc = channelWakeFanout
      ? new BindChannelService(db, channelWakeFanout)
      : undefined
    const autoBindChannelSvc = channelWakeFanout
      ? new AutoBindChannelService(db, channelWakeFanout)
      : undefined
    if (args.agent_type === 'claude-code' && args.model === undefined) {
      args.model = defaultClaudeSelfModel(getSessionClientInfo?.())
    }
    if (args.agent_type === 'codex' && args.ws_url === undefined) {
      args.ws_url = ''
    }
    if (args.agent_type === 'codex' && args.model === undefined) {
      args.model = 'gpt'
    }
    const connectionId = getSessionId?.() ?? caller()
    if (!connectionId) return { error: 'unknown_agent' }
    const uiPidClientError = await preflightUiPidClient(args)
    if (uiPidClientError) return uiPidClientError
    if (
      args.agent_type === 'claude-code' &&
      args.channel_session_id !== undefined &&
      args.ui_pid !== undefined &&
      autoBindChannelSvc
    ) {
      const proxyLookup = autoBindChannelSvc.lookup({
        ui_pid: args.ui_pid,
      })
      if (
        proxyLookup.ok &&
        proxyLookup.channel_session_id !== args.channel_session_id
      ) {
        return {
          error: 'channel_session_id_ui_pid_mismatch',
          detail: {
            ui_pid_matched_csid: proxyLookup.channel_session_id,
            supplied_csid: args.channel_session_id,
          },
        }
      }
    }
    const hasCodexTransportFields =
      args.thread_id !== undefined ||
      args.ws_url !== undefined ||
      args.auth_token_ref !== undefined
    const res =
      args.agent_type === 'codex' &&
      args.delivery === undefined &&
      hasCodexTransportFields
        ? await registerCodexSelfSvc.register({
            connection_id: connectionId,
            name: args.name,
            model: args.model,
            role: args.role,
            team: args.team,
            project_dir: args.project_dir,
            thread_id: args.thread_id,
            ws_url: args.ws_url,
            auth_token_ref: args.auth_token_ref,
          })
        : registerSvc.register({
            connection_id: connectionId,
            agent_type: args.agent_type,
            agent_type_name: args.agent_type_name,
            model: args.model,
            name: args.name,
            role: args.role,
            team: args.team,
            project_dir: args.project_dir,
            delivery: args.delivery,
            claude_ui_pid: args.claude_ui_pid,
            runtime_ui_pid:
              args.agent_type === 'claude-code' ? args.ui_pid : undefined,
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
      if (args.agent_type === 'claude-code' && args.channel_session_id !== undefined) {
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
      if (
        args.agent_type === 'claude-code' &&
        args.channel_session_id === undefined &&
        args.ui_pid !== undefined &&
        autoBindChannelSvc
      ) {
        const autoBind = autoBindChannelSvc.run({
          callerAgentId: res.agent_id,
          ui_pid: args.ui_pid,
        })
        if (autoBind.ok) {
          autoBoundChannelCsid = autoBind.channel_session_id
          nativeDeliveryBound = true
        }
      }
      const autoBound = await autoBindRuntimeIdentity(args, res.agent_id)
      const envelope = autoBoundChannelCsid !== undefined
        ? { ...res, channel_session_id: autoBoundChannelCsid }
        : res
      if (autoBound) return envelope
      if (!nativeDeliveryBound) {
        return {
          ...envelope,
          hint: "No usable tmux_pane_id is bound yet — automatic runtime binding did not converge for this session, so cross-agent poke delivery via tmux is still off. Call `bind_runtime_identity(...)` to bind explicitly, or use `detect_tmux_pane(...)` for debugging. Claude Code users who loaded the cross-agent-teams-mcp channel plugin can also route pokes via channel_session_id — that path does not require tmux binding."
        }
      }
      return envelope
    }
    return res
  }

  function releaseRegisteredState(agentId: string): void {
    const connectionId = getSessionId?.()
    if (connectionId) registerSvc.releaseConnection(agentId, connectionId)
    if (onUnregisterSuccess) {
      try { onUnregisterSuccess(agentId) } catch { /* best-effort */ }
      return
    }
    if (fanout) {
      try { fanout.detach(agentId) } catch { /* best-effort */ }
    }
  }

  // pre_register_codex_pane — callable by launchers before any agent row exists
  server.registerTool(
    'pre_register_codex_pane',
    {
      title: 'Pre-register codex tmux pane',
      description: [
        'Pre-register a pending tmux-pane claim so the launcher can claim a tmux pane before starting codex.',
        'The launcher should call this with `$TMUX_PANE` and a freshly generated UUID, then `exec codex --remote ... -c xats.agent_id="\\"<uuid>\\""`.',
        'When the codex agent later calls `register_agent({agent_type:"codex"})` without `ui_pid`, the daemon uses the pending row to resolve the correct UI pid and auto-bind the pane.',
        'Callable without a prior `register_agent` — launchers have no agent identity yet.',
        'TTL defaults to 120 seconds and is capped at 600; pending rows are garbage-collected opportunistically.',
      ].join(' '),
      inputSchema: preRegisterCodexPaneInputSchema,
    },
    async (args: unknown) => run(async () => preRegisterCodexPaneSvc.register(args))
  )

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
        'Register this session as an agent in a team. This is the unified registration entry point.',
        'DETECTION (run these probes BEFORE choosing `agent_type=`, in order; first match wins):',
        '1. `printenv CODEX_THREAD_ID` non-empty → `agent_type="codex"`; pass that value as `thread_id` (REQUIRED for codex per the schema). Do NOT pass `ui_pid` (the launcher\'s `pre_register_codex_pane` flow handles tmux pane binding; supplying `ui_pid` from codex disables that auto-bind path).',
        '2. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type="claude-code"`; pass `$PPID` as `ui_pid` to enable channel auto-bind.',
        '3. None of the above → `agent_type="custom"` with `agent_type_name="<the harness you are running under, e.g. cursor, opencode, ...>"` (`agent_type_name` is required when `agent_type="custom"`). Detect the harness name from your runtime environment if you can — e.g. `printenv CURSOR_TRACE_ID` non-empty means cursor — but do NOT guess from system-wide signals like "binary X exists on PATH": such probes detect what the user has installed, not what runtime you are inside, and pick the wrong agent type. When unsure, prefer `agent_type_name="unknown"` over a wrong guess.',
        'Calling this tool again with the same `(team, name, role)` identity reuses the existing `agent_id` and refreshes `tmux_pane_id` and `model`; no duplicate row is created.',
        'Use `agent_type="custom"` for unsupported agent harnesses; provide `agent_type_name` for observability.',
        'Claude Code sessions: pass `agent_type="claude-code"` and PREFERRED: pass only `ui_pid` (from `$PPID`) so the daemon auto-binds channel delivery — do not pass `channel_session_id` explicitly. When BOTH `ui_pid` AND `channel_session_id` are supplied, the daemon runs a consistency check against the caller `ui_pid`\'s live channel proxy; if the proxy\'s csid does not match the supplied `channel_session_id`, the call is rejected with `channel_session_id_ui_pid_mismatch` before any agent row is written. Use `bind_channel` for low-level rebind after registration instead of supplying csid here.',
        'Codex sessions: pass `agent_type="codex"` and `thread_id` (from `$CODEX_THREAD_ID`) to register Codex app-server delivery. The schema REQUIRES `thread_id` when `agent_type="codex"`; missing or empty `thread_id` is rejected before any handshake runs. Launcher pre-reg callers without `thread_id` should use `pre_register_codex_pane` instead. `ws_url` defaults to `ws://127.0.0.1:8799` (env override `CROSS_AGENT_TEAMS_CODEX_WS_URL`); `model` defaults to `gpt` when omitted. For `agent_type="claude-code"` callers, `model` defaults to a Claude-specific value derived from MCP session client info when omitted.',
        '`model` is OPTIONAL for any agent_type: omit it when you do not have an authoritative model identifier; the daemon stores NULL in that case. Pass an explicit `model` only when you have a stable identifier you would like surfaced via `list_agents`.',
        'Requests such as "register to xats" or "register to cross-agent-teams" refer to this MCP service, not to the `team` field; do not set `team` to `xats` or `cross-agent-teams` from those phrases.',
        'Do not treat the bare word "register" as a request for this tool unless the current conversation is already about cross-agent-teams registration.',
        'When the end user has not explicitly specified `team`, callers should pass `project_dir` as the current working directory so the daemon derives a project-scoped default team from its basename; if omitted, it falls back to `default`.',
        '`agent_type` must describe the runtime behind `ui_pid`, not merely the current MCP caller. For example, if `ui_pid` points at an external editor process, pass `agent_type="custom"` with `agent_type_name=<editor>` even when the registration request is issued from a different harness.',
        'STRONGLY RECOMMENDED: pass `ui_pid` unless it is truly unobtainable (codex callers excepted, see DETECTION step 1). Without it, automatic runtime binding usually fails to converge and tmux-based cross-agent poke delivery stays off until a separate `bind_runtime_identity(...)` call. From Claude Code, `$PPID` inside a Bash tool call is the `claude` CLI pid. With `ui_pid` the daemon binds via verified pid → tty → pane evidence in one shot.',
        'After registration, the daemon best-effort attempts runtime binding for recognized local clients so tmux-based poke delivery can come up without a second tool call.',
        'If automatic runtime binding does not converge, call `bind_runtime_identity(...)` explicitly so the daemon can verify and persist your pane binding.',
        '`detect_tmux_pane(...)` remains available as a debugging aid for ambiguous or missing matches, but it does not write registry state by itself.',
        'When registration still has no usable `tmux_pane_id`, tmux-based poke delivery stays unavailable until automatic or explicit runtime binding succeeds.'
      ].join(' '),
      inputSchema: registerAgentInputSchema
    },
    async (args: {
      agent_type: AgentType
      agent_type_name?: string
      model?: string; name: string; role?: string; team?: string;
      project_dir?: string;
      ui_pid?: number;
      channel_session_id?: string
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      claude_ui_pid?: number
      delivery?: { kind: string; [key: string]: unknown }
    }) => {
      return run(async () => executeRegister(registerAgentArgsSchema.parse(args)))
    }
  )

  server.registerTool(
    'unregister_self',
    {
      title: 'Unregister current agent',
      description: [
        'Remove the caller session\'s current agent registration.',
        'This tool only unregisters the currently bound agent identity; it does not delete other agents.',
        'If the caller still owns any in-progress task, it returns `tasks_in_progress` and leaves all state unchanged.',
        'On success it deletes the agent row, removes the caller\'s contract subscriptions, and immediately releases the current MCP session back to an unregistered state.'
      ].join(' '),
      inputSchema: z.object({}).strict()
    },
    async () => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      const result = await wrapStorage(() => unregisterSelfSvc.unregister({ caller: who }))
      if (
        typeof result === 'object' &&
        result !== null &&
        'ok' in result &&
        result.ok === true &&
        'agent_id' in result &&
        typeof result.agent_id === 'string'
      ) {
        releaseRegisteredState(result.agent_id)
        return toText(result)
      }
      touchIfRegistered()
      return toText(result)
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
      return run(() => ({
        agents: agents.list({ team: row.team }).map(toPublicAgentRow),
      }))
    }
  )

  // send_message (by name)
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description: SEND_MESSAGE_DESC,
      inputSchema: z.object({
        to_agent_name: z.string().min(1),
        to_team: z.string().min(1).optional(),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional(),
        need_reply: z.boolean().optional()
      }).strict()
    },
    async (args: {
      to_agent_name: string
      to_team?: string
      subject?: string
      body: string
      auto_poke?: boolean
      need_reply?: boolean
    }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => sendSvc.send({ from: who, ...args }))
    }
  )

  // send_message_by_id (by UUID)
  server.registerTool(
    'send_message_by_id',
    {
      title: 'Send message by id',
      description: SEND_MESSAGE_BY_ID_DESC,
      inputSchema: z.object({
        to_agent_id: z.string().min(1),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional(),
        need_reply: z.boolean().optional()
      }).strict()
    },
    async (args: {
      to_agent_id: string
      subject?: string
      body: string
      auto_poke?: boolean
      need_reply?: boolean
    }) => {
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

  // get_delivery_status
  server.registerTool(
    'get_delivery_status',
    {
      title: 'Get delivery status',
      description: [
        'Return wake-hint delivery status for a message sent by caller.',
        'Status describes auto-poke delivery only; mailbox persistence is already complete.',
        'Only the original sender can read a message delivery status.'
      ].join(' '),
      inputSchema: {
        message_id: z.string()
      }
    },
    async (args: { message_id: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => deliveryStatusSvc.get({ caller: who, ...args }))
    }
  )

  // task_add
  server.registerTool(
    'task_add',
    {
      title: 'Add task',
      description: [
        "Add a new task to the team's task list.  Any team member can claim it via `task_claim`",
        'on their next turn.  The task will sit in the pending queue until someone pulls `task_list`.',
        '`task_add` itself does not wake or target any specific agent; use normal mailbox messaging',
        'when coordination is needed, then inspect that message with `get_delivery_status`.'
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
          'Most callers should prefer `register_agent({ agent_type: "claude-code", channel_session_id, ... })` on the unified registration path.',
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
