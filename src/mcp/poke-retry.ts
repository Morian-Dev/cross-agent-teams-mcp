export const RETRY_DELAYS_MS = [30_000, 180_000, 600_000] as const
export const RETRY_DELAYS_S = [30, 180, 600] as const

export interface RetryPokeArgs {
  team: string
  fromAgentId: string
  targetAgentId: string
  paneId: string
  body: string
}

export interface RetryAgentLookup {
  agent_id: string
  tmux_pane_id: string | null
  last_seen_at: string
}

export interface RetryContext {
  agentId: string
  messageId: string
  fromAgentId: string
  body: string
  team: string
  sentAt: string
  paneId: string
  paneGuardFn: (paneId: string) => Promise<'pass' | 'fail'>
  pokeFn: (args: RetryPokeArgs) => Promise<void>
  lookupAgentFn: (agentId: string) => RetryAgentLookup | undefined
}

interface RetryEntry {
  timer: ReturnType<typeof setTimeout>
  attempt: number
  ctx: RetryContext
}

const retryMap = new Map<string, RetryEntry>()

function keyOf(ctx: RetryContext): string {
  return `${ctx.messageId}:${ctx.agentId}`
}

export function scheduleRetry(ctx: RetryContext): void {
  const key = keyOf(ctx)
  cancelRetry(key)
  const entry: RetryEntry = { timer: setTimeout(() => {}, 0), attempt: 0, ctx }
  clearTimeout(entry.timer)
  retryMap.set(key, entry)
  enqueueNext(key)
}

function enqueueNext(key: string): void {
  const entry = retryMap.get(key)
  if (!entry) return
  if (entry.attempt >= RETRY_DELAYS_MS.length) {
    retryMap.delete(key)
    return
  }
  const delay = RETRY_DELAYS_MS[entry.attempt]
  entry.timer = setTimeout(() => { void tick(key) }, delay)
}

async function tick(key: string): Promise<void> {
  const entry = retryMap.get(key)
  if (!entry) return
  const { ctx } = entry
  try {
    const agent = ctx.lookupAgentFn(ctx.agentId)
    if (!agent || !agent.tmux_pane_id) {
      retryMap.delete(key)
      return
    }
    if (new Date(agent.last_seen_at).getTime() > new Date(ctx.sentAt).getTime()) {
      retryMap.delete(key)
      return
    }
    const guard = await ctx.paneGuardFn(agent.tmux_pane_id)
    if (guard === 'pass') {
      await ctx.pokeFn({
        team: ctx.team,
        fromAgentId: ctx.fromAgentId,
        targetAgentId: ctx.agentId,
        paneId: agent.tmux_pane_id,
        body: ctx.body
      })
      retryMap.delete(key)
      return
    }
    entry.attempt += 1
    if (entry.attempt >= RETRY_DELAYS_MS.length) {
      retryMap.delete(key)
      return
    }
    enqueueNext(key)
  } catch {
    retryMap.delete(key)
  }
}

export function cancelRetry(key: string): void {
  const entry = retryMap.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  retryMap.delete(key)
}

export function clearAllRetries(): void {
  for (const [, v] of retryMap) clearTimeout(v.timer)
  retryMap.clear()
}

export function __peekRetryMap(): Map<string, { attempt: number; ctx: RetryContext }> {
  const view = new Map<string, { attempt: number; ctx: RetryContext }>()
  for (const [k, v] of retryMap) view.set(k, { attempt: v.attempt, ctx: v.ctx })
  return view
}
