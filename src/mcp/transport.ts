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
      }
    })
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId) }
    server.connect(transport)
    return { transport, server, sessionId: '', agentIdHolder }
  }

  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const body = req.body as { method?: string } | undefined
    const isInit = body?.method === 'initialize'
    let session = sid ? sessions.get(sid) : undefined
    if (!session && !isInit) { return reply.code(400).send({ error: 'unknown_session' }) }
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
