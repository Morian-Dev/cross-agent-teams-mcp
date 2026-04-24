import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, createHash } from 'node:crypto'
import { echoSchema, echoHandler } from './echo.js'
import { registerBusinessTools, type AgentIdHolder } from './tools.js'
import type { SseFanout, SseSink } from '../daemon/sse-fanout.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  sessionId: string
  agentIdHolder: AgentIdHolder
  clientInfo?: {
    name?: string
    version?: string
  }
}

export function mountMcp(
  app: FastifyInstance,
  db: Database.Database,
  fanout: SseFanout,
  channelWakeFanout?: ChannelWakeFanout
): void {
  const sessions = new Map<string, Session>()
  // Once register_agent succeeds for a session id, pin the owning Authorization hash.
  // A later register_agent presenting a different Authorization triggers HTTP 409.
  const sessionOwners = new Map<string, string>()

  function createSession(): Session {
    const server = new McpServer(
      { name: 'cross-agent-teams-mcp', version: '0.1.0' },
      {
        instructions:
          'xats 是 cross-agent-teams 的缩写. 当用户或其他 agent 提到 xats 时, 指的是本 MCP server (cross-agent-teams-mcp) 及其跨 agent 协作工具 (register_agent, send_message, task_* 等). 用户说"注册到 xats"或"注册到 cross-agent-teams"时, 表示注册到本 MCP 服务, xats 和 cross-agent-teams 不是 team 名, 不要把它们传给 team. 不要把单独的常用词"注册"默认劫持为本工具; 只有当前上下文已经在讨论 cross-agent-teams 注册时才可续接. 注册时 (register_agent / register_claude_self) 如果用户未显式指定 team, 默认传 project_dir=当前工作目录 (cwd), daemon 会用它的 basename 作为 team 默认值; 都不传时回落 default.'
          + ' Codex clients: if your tool shell env has CODEX_THREAD_ID set (codex 0.124.0+ exports it), pass its value as `thread_id` and prefer `register_codex_self` over `register_agent`. Do NOT attempt to discover or pass `ui_pid` from codex — the launcher\'s `pre_register_codex_pane` pre-reg flow handles tmux pane binding automatically; supplying `ui_pid` manually disables that auto-bind path.'
      }
    )
    const agentIdHolder: AgentIdHolder = { current: undefined }
    server.registerTool('echo', { title: 'Echo', description: 'Return the input', inputSchema: echoSchema }, echoHandler as any)

    let sessionIdForCaller: string | undefined
    // `caller()` returns the session id before register_agent succeeds (to serve as
    // a stable connection_id), and the bound agent_id after register succeeds.
    const getCallerAgentId = (): string | undefined =>
      agentIdHolder.current ?? sessionIdForCaller

    const sink: SseSink = {
      send(msg: Record<string, unknown>): void {
        const payload = {
          jsonrpc: '2.0' as const,
          method: 'notifications/contract_event',
          params: msg
        }
        void transport.send(payload).catch(() => { /* no active GET stream yet */ })
      },
      sendHeartbeat(): void {
        void transport.send({
          jsonrpc: '2.0' as const,
          method: 'notifications/heartbeat',
          params: {}
        }).catch(() => { /* no active GET stream yet */ })
      },
      close(): void { /* transport.onclose handles lifecycle */ }
    }

    const onRegisterSuccess = (agent_id: string, team: string): void => {
      // Detach any prior sink registered under this agent_id (e.g. from a previous
      // session that reused the same identity) before attaching the new one.
      try { fanout.detach(agent_id) } catch { /* ignore */ }
      // If this session had previously bound a different agent_id (e.g. role change
      // mid-session), detach that too.
      if (agentIdHolder.current && agentIdHolder.current !== agent_id) {
        try { fanout.detach(agentIdHolder.current) } catch { /* ignore */ }
      }
      fanout.attach(agent_id, team, sink)
      agentIdHolder.current = agent_id
    }

    const onUnregisterSuccess = (agent_id: string): void => {
      try { fanout.detach(agent_id) } catch { /* ignore */ }
      if (sessionIdForCaller && channelWakeFanout) {
        try { channelWakeFanout.detachBySession(sessionIdForCaller) } catch { /* ignore */ }
      }
      if (agentIdHolder.current === agent_id) agentIdHolder.current = undefined
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessionIdForCaller = sid
        sessions.set(sid, { transport, server, sessionId: sid, agentIdHolder, clientInfo: undefined })
      }
    })
    transport.onclose = () => {
      if (agentIdHolder.current) {
        try { fanout.detach(agentIdHolder.current) } catch { /* ignore */ }
      }
      if (transport.sessionId && channelWakeFanout) {
        try { channelWakeFanout.detachBySession(transport.sessionId) } catch { /* ignore */ }
      }
      if (transport.sessionId) {
        sessions.delete(transport.sessionId)
        sessionOwners.delete(transport.sessionId)
      }
    }
    registerBusinessTools(
      server,
      db,
      getCallerAgentId,
      fanout,
      onRegisterSuccess,
      () => sessionIdForCaller,
      channelWakeFanout,
      () => transport,
      () => {
        const sid = sessionIdForCaller
        if (!sid) return undefined
        return sessions.get(sid)?.clientInfo
      },
      onUnregisterSuccess
    )
    server.connect(transport)
    return { transport, server, sessionId: '', agentIdHolder }
  }

  function authHashFor(req: FastifyRequest): string | null {
    const raw = req.headers['authorization']
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    return createHash('sha256').update(trimmed).digest('hex')
  }

  interface ToolsCallBody {
    method?: string
    params?: { name?: string; arguments?: Record<string, unknown> }
  }

  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const body = req.body as ToolsCallBody | undefined
    const isInit = body?.method === 'initialize'
    let session = sid ? sessions.get(sid) : undefined
    if (!session && !isInit) { return reply.code(400).send({ error: 'unknown_session' }) }

    // register_agent presenting a different Authorization header than the one that
    // first claimed this session id -> agent_id_collision (HTTP 409). Absence of
    // an Authorization header disables collision enforcement per spec.
    if (session && body?.method === 'tools/call' && body.params?.name === 'register_agent') {
      const authHash = authHashFor(req)
      if (authHash !== null) {
        const owner = sessionOwners.get(session.sessionId)
        if (owner && owner !== authHash) {
          return reply.code(409).send({ error: 'agent_id_collision' })
        }
        if (!owner) sessionOwners.set(session.sessionId, authHash)
      }
    }

    // Spoofed from_agent_id on tools/call -> 403. Compare against the session's
    // currently bound agent_id (post register_agent), NOT the raw MCP session id.
    if (session && body?.method === 'tools/call') {
      const claimed = body.params?.arguments?.from_agent_id
      if (typeof claimed === 'string') {
        const current = session.agentIdHolder.current
        if (current === undefined || claimed !== current) {
          return reply.code(403).send({ error: 'identity_mismatch' })
        }
      }
    }

    if (!session) { session = createSession() }
    if (body?.method === 'initialize') {
      const params = body.params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined
      const clientInfo = params?.clientInfo
      session.clientInfo = {
        name: typeof clientInfo?.name === 'string' ? clientInfo.name : undefined,
        version: typeof clientInfo?.version === 'string' ? clientInfo.version : undefined,
      }
    }
    await session.transport.handleRequest(req.raw, reply.raw, body)
    return reply
  })

  app.get('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const session = sid ? sessions.get(sid) : undefined
    if (!session) return reply.code(400).send({ error: 'unknown_session' })
    await session.transport.handleRequest(req.raw, reply.raw)
    return reply
  })

  app.delete('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const session = sid ? sessions.get(sid) : undefined
    if (!session) return reply.code(400).send({ error: 'unknown_session' })
    await session.transport.handleRequest(req.raw, reply.raw)
    return reply
  })
}
