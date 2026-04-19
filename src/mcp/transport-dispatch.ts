import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { sendChannelWake } from '../daemon/channel-wake-send.js'

export interface DispatchDeps {
  channelWakeFanout: ChannelWakeFanout
  tmuxPoke: (args: { pane_id: string; content: string }) => Promise<TmuxPokeResult>
}

export type TmuxPokeResult =
  | { ok: true; pane_tail_before: string; pane_tail_after: string }
  | { error: string; detail?: unknown }

export interface TargetRow {
  channel_session_id: string | null
  tmux_pane_id: string | null
}

export interface DispatchInput {
  content: string
  meta: Record<string, string>
}

export type DispatchResult =
  | {
      ok: true
      transport_used: 'claude-channel'
      channel_session_id: string
    }
  | {
      ok: true
      transport_used: 'tmux-poke'
      pane_id: string
      pane_tail_before: string
      pane_tail_after: string
    }
  | {
      error: string
      detail?: unknown
      transport_used?: 'tmux-poke'
    }

export async function dispatchPoke(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  const csid = target.channel_session_id
  const channelSubscribed = csid != null && deps.channelWakeFanout.has(csid)
  if (csid && channelSubscribed) {
    const r = sendChannelWake(deps.channelWakeFanout, csid, input)
    if (r.ok) {
      return { ok: true, transport_used: 'claude-channel', channel_session_id: csid }
    }
  }
  const paneId = target.tmux_pane_id
  if (paneId) {
    const tr = await deps.tmuxPoke({ pane_id: paneId, content: input.content })
    if ('ok' in tr && tr.ok) {
      return {
        ok: true,
        transport_used: 'tmux-poke',
        pane_id: paneId,
        pane_tail_before: tr.pane_tail_before,
        pane_tail_after: tr.pane_tail_after
      }
    }
    return { ...(tr as { error: string; detail?: unknown }), transport_used: 'tmux-poke' }
  }
  return {
    error: 'no_transport_available',
    detail: {
      channel_subscribed: channelSubscribed,
      tmux_pane_set: paneId != null
    }
  }
}
