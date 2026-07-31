import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { AgentsRepo } from '../storage/agents-repo.js'
import { EventsOutbox } from '../storage/events-outbox.js'
import { SendMessageService, type SendInput } from '../mcp/send-message.js'
import { GetInboxService } from '../mcp/get-inbox.js'
import { createAutoPokeImpl } from '../mcp/tools.js'
import { listAgentsForTeam } from '../mcp/list-agents.js'
import { removeAgentRow } from '../mcp/unregister-self.js'
import { wrapStorage } from './errors.js'
import type { ChannelWakeFanout } from './channel-wake-fanout.js'
import type { SessionOriginInfo } from './network-origin.js'
import type { DaemonContext } from './server.js'

// Loopback-only, sessionless REST lifeboat. It reuses the SAME service layer as
// the MCP tools (SendMessageService / GetInboxService / listAgentsForTeam) and
// resolves identity purely by (team, name) → agents row on the local device.
// It NEVER touches any MCP session, RegisterAgentService.connections, or any
// delivery/fanout/channel-wake binding — there is no code path from here into
// the session/register machinery (the no-session-side-effect invariant).
export interface RestApiDeps {
  channelWakeFanout?: ChannelWakeFanout
  context?: DaemonContext
}

interface RestCtx {
  db: Database.Database
  localDevice: string
  agents: AgentsRepo
  sendSvc: SendMessageService
  inboxSvc: GetInboxService
}

const identitySchema = z.object({
  team: z.string().min(1),
  name: z.string().min(1),
}).strict()

// `to` is EITHER an agent_id OR a (name, optional team) pair. `.strict()` on each
// branch makes a mixed object like `{ agent_id, name }` match neither branch and
// be rejected at the boundary, rather than silently dropping a field. `team` stays
// optional to preserve parity with the send_message tool (`to_team ?? fromTeam`).
const sendBodySchema = z.object({
  from: identitySchema,
  to: z.union([
    z.object({ agent_id: z.string().min(1) }).strict(),
    z.object({ name: z.string().min(1), team: z.string().min(1).optional() }).strict(),
  ]),
  subject: z.string().optional(),
  body: z.string().min(1),
  need_reply: z.boolean().optional(),
  auto_poke: z.boolean().optional(),
}).strict()

type SendBody = z.infer<typeof sendBodySchema>

function isErrorResult(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'string'
  )
}

function sendErrorStatus(error: string): number {
  if (error === 'unknown_recipient') return 404
  if (error === 'storage_unavailable') return 503
  return 400
}

function peerOrigin(req: FastifyRequest): SessionOriginInfo['origin'] | undefined {
  return (req as FastifyRequest & { xatsPeer?: SessionOriginInfo }).xatsPeer?.origin
}

// Origin is derived from the socket's peer address (see network-origin), never
// from a spoofable header, so a forged `X-Forwarded-For` cannot reach the API.
async function restLoopbackGate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.url.startsWith('/api/')) return
  if (peerOrigin(req) !== 'local') {
    await reply.code(403).send({ error: 'remote_forbidden' })
  }
}

function recipientFields(to: SendBody['to']): Pick<SendInput, 'to_agent_id' | 'to_agent_name' | 'to_team'> {
  if ('agent_id' in to) return { to_agent_id: to.agent_id }
  return { to_agent_name: to.name, to_team: to.team }
}

async function handleSend(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = sendBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid_request',
      detail: parsed.error.issues.map(i => i.message).join('; '),
    })
  }
  const data = parsed.data
  const fromRow = ctx.agents.findByIdentity({
    device: ctx.localDevice,
    team: data.from.team,
    name: data.from.name,
  })
  if (!fromRow) return reply.code(404).send({ error: 'unknown_sender' })

  const input: SendInput = {
    from: fromRow.agent_id,
    subject: data.subject,
    body: data.body,
    need_reply: data.need_reply,
    auto_poke: data.auto_poke,
    ...recipientFields(data.to),
  }
  const result = await wrapStorage(() => ctx.sendSvc.send(input))
  if (isErrorResult(result)) {
    return reply.code(sendErrorStatus(result.error)).send({ error: result.error })
  }
  return reply.send(result)
}

async function handleInbox(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = req.query as Record<string, unknown>
  const team = typeof query.team === 'string' ? query.team : undefined
  const name = typeof query.name === 'string' ? query.name : undefined
  if (!team || !name) {
    return reply.code(400).send({ error: 'invalid_request', detail: 'team and name are required' })
  }
  let since_event_id: number | undefined
  if (query.since_event_id !== undefined) {
    const n = Number(query.since_event_id)
    if (!Number.isInteger(n)) {
      return reply.code(400).send({ error: 'invalid_request', detail: 'since_event_id must be an integer' })
    }
    since_event_id = n
  }
  const owner = ctx.agents.findByIdentity({ device: ctx.localDevice, team, name })
  if (!owner) return reply.code(404).send({ error: 'unknown_owner' })

  const result = await wrapStorage(() => ctx.inboxSvc.get({ caller: owner.agent_id, since_event_id }))
  if (isErrorResult(result)) {
    return reply.code(503).send({ error: result.error })
  }
  return reply.send(result)
}

async function handleAgents(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = req.query as Record<string, unknown>
  const team = typeof query.team === 'string' ? query.team : undefined
  if (!team) {
    return reply.code(400).send({ error: 'invalid_request', detail: 'team is required' })
  }
  const result = await wrapStorage(() => listAgentsForTeam(ctx.db, team, ctx.localDevice))
  if (isErrorResult(result)) {
    return reply.code(503).send({ error: result.error })
  }
  return reply.send(result)
}

// Addressed by agent_id, not (team, name): rows carrying a device label other
// than the daemon's localDevice are legitimate removal targets and would be
// unreachable under the identity resolution the other routes use. Liveness is
// deliberately not consulted — `online` falls back to a multi-day last_seen_at
// window for runtimes without a pid or pane, so gating on it would block the
// rows most in need of cleanup.
async function handleDeleteAgent(ctx: RestCtx, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { agent_id } = req.params as { agent_id: string }
  const result = await wrapStorage(() => removeAgentRow(ctx.db, ctx.agents, agent_id))
  if (isErrorResult(result)) {
    return reply.code(result.error === 'storage_unavailable' ? 503 : 404).send({ error: result.error })
  }
  return reply.send({
    deleted: true,
    agent_id: result.agent_id,
    team: result.team,
    name: result.name,
  })
}

export function mountRestApi(
  app: FastifyInstance,
  db: Database.Database,
  deps: RestApiDeps = {}
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const localDevice = deps.context?.localDevice ?? 'local'
  // Constructed exactly like the send_message tool in src/mcp/tools.ts so a REST
  // send pokes recipients identically (channel-wake / tmux / codex-appserver /
  // opencode-server are all resolved inside poke() from the target's delivery row).
  const autoPokeImpl = createAutoPokeImpl(db, agents, deps.channelWakeFanout, localDevice)
  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl })
  const inboxSvc = new GetInboxService(db, agents)
  const ctx: RestCtx = { db, localDevice, agents, sendSvc, inboxSvc }

  // Loopback gate for every /api/* route. Runs after the global token-auth and
  // origin-classification onRequest hooks registered in buildServer, so the order
  // is token (401) then loopback (403); a remote caller with a correct token still
  // gets 403 and no data-layer action runs (short-circuit in the gate).
  app.addHook('onRequest', restLoopbackGate)
  app.post('/api/send', (req, reply) => handleSend(ctx, req, reply))
  app.get('/api/inbox', (req, reply) => handleInbox(ctx, req, reply))
  app.get('/api/agents', (req, reply) => handleAgents(ctx, req, reply))
  app.delete('/api/agents/:agent_id', (req, reply) => handleDeleteAgent(ctx, req, reply))
}
