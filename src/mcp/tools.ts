import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AgentsRepo } from '../storage/agents-repo.js'
import { EventsOutbox } from '../storage/events-outbox.js'
import { RegisterAgentService } from './register-agent.js'
import { SendMessageService } from './send-message.js'
import { BroadcastService } from './broadcast.js'
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
import { wrapStorage } from '../daemon/errors.js'

export interface AgentIdHolder { current: string | undefined }

type TextContent = { content: Array<{ type: 'text'; text: string }> }

function toText(value: unknown): TextContent {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

export function registerBusinessTools(
  server: McpServer,
  db: Database.Database,
  getCallerAgentId: () => string | undefined
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const registerSvc = new RegisterAgentService(db)
  const sendSvc = new SendMessageService(db, agents, events)
  const broadcastSvc = new BroadcastService(db, agents, sendSvc)
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
      description: 'Register this session as an agent in a team',
      inputSchema: {
        model: z.string(),
        role: z.string(),
        display_name: z.string().optional(),
        team: z.string().optional()
      }
    },
    async (args: { model: string; role: string; display_name?: string; team?: string }) => {
      const sid = caller()
      if (!sid) return toText({ error: 'unknown_agent' })
      return run(() => registerSvc.register({
        agent_id: sid,
        connection_id: sid,
        model: args.model,
        role: args.role,
        display_name: args.display_name,
        team: args.team
      }))
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
      description: 'Send a direct or role-broadcast message',
      inputSchema: {
        to_agent_id: z.string().optional(),
        to_role: z.string().optional(),
        subject: z.string().optional(),
        body: z.string()
      }
    },
    async (args: { to_agent_id?: string; to_role?: string; subject?: string; body: string }) => {
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
      description: 'Broadcast to all agents in the team except caller',
      inputSchema: {
        subject: z.string().optional(),
        body: z.string()
      }
    },
    async (args: { subject?: string; body: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => broadcastSvc.broadcast({ from: who, ...args }))
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
      description: 'Add a new task to the team\'s task list',
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
      return run(() => regContractSvc.register({ caller: who, ...args }))
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
