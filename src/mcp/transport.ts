import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { echoSchema, echoHandler } from './echo.js'
import { registerBusinessTools, type AgentIdHolder } from './tools.js'
import type { SseFanout } from '../daemon/sse-fanout.js'

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  sessionId: string
  agentIdHolder: AgentIdHolder
}

export function mountMcp(app: FastifyInstance, db: Database.Database, fanout: SseFanout): void {
  const sessions = new Map<string, Session>()
  // Once register_agent succeeds for a session id, pin the owning socket token.
  // A later register_agent from a different socket token triggers HTTP 409.
  const sessionOwners = new Map<string, symbol>()

  function createSession(): Session {
    const server = new McpServer({ name: 'agent-teams-mcp', version: '0.1.0' })
    const agentIdHolder: AgentIdHolder = { current: undefined }
    server.registerTool('echo', { title: 'Echo', description: 'Return the input', inputSchema: echoSchema }, echoHandler as any)
    registerBusinessTools(server, db, () => agentIdHolder.current, fanout)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        agentIdHolder.current = sid
        sessions.set(sid, { transport, server, sessionId: sid, agentIdHolder })
        const sink = {
          send(msg: Record<string, unknown>): void {
            const payload = {
              jsonrpc: '2.0' as const,
              method: 'notifications/contract_event',
              params: msg
            }
            void transport.send(payload).catch(() => { /* no active GET stream yet */ })
          },
          close(): void { /* transport.onclose handles lifecycle */ }
        }
        fanout.attach(sid, 'default', sink)
      }
    })
    transport.onclose = () => {
      if (transport.sessionId) {
        fanout.detach(transport.sessionId)
        sessions.delete(transport.sessionId)
        sessionOwners.delete(transport.sessionId)
      }
    }
    server.connect(transport)
    return { transport, server, sessionId: '', agentIdHolder }
  }

  // Attach a per-TCP-socket token so we can detect cross-connection session-id reuse.
  const SOCKET_TOKEN = Symbol('atm.socket.token')
  function tokenFor(req: FastifyRequest): symbol {
    const socket = req.raw.socket as unknown as Record<symbol, symbol>
    if (!socket[SOCKET_TOKEN]) socket[SOCKET_TOKEN] = Symbol('atm.conn')
    return socket[SOCKET_TOKEN]
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

    const connToken = tokenFor(req)

    // register_agent from a different TCP socket than the one that first claimed
    // this session id -> agent_id_collision (HTTP 409).
    if (session && body?.method === 'tools/call' && body.params?.name === 'register_agent') {
      const owner = sessionOwners.get(session.sessionId)
      if (owner && owner !== connToken) {
        return reply.code(409).send({ error: 'agent_id_collision' })
      }
      if (!owner) sessionOwners.set(session.sessionId, connToken)
    }

    // Spoofed from_agent_id on tools/call -> 403
    if (session && body?.method === 'tools/call') {
      const claimed = body.params?.arguments?.from_agent_id
      if (typeof claimed === 'string' && claimed !== session.sessionId) {
        return reply.code(403).send({ error: 'identity_mismatch' })
      }
    }

    if (!session) { session = createSession() }
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
