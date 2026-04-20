import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { sendChannelWake } from '../daemon/channel-wake-send.js'
import type { DeliverySpec } from '../lib/delivery-spec.js'

export interface DispatchDeps {
  channelWakeFanout: ChannelWakeFanout
  tmuxPoke: (args: { pane_id: string; content: string }) => Promise<TmuxPokeResult>
}

export type TmuxPokeResult =
  | { ok: true; pane_tail_before: string; pane_tail_after: string }
  | { error: string; detail?: unknown }

export interface TargetRow {
  delivery: DeliverySpec
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
  const paneId = target.tmux_pane_id

  if (target.delivery.kind === 'claude-channel') {
    const channelSubscribed = deps.channelWakeFanout.has(
      target.delivery.channel_session_id
    )
    if (channelSubscribed) {
      const result = sendChannelWake(
        deps.channelWakeFanout,
        target.delivery.channel_session_id,
        input
      )
      if (result.ok) {
        return {
          ok: true,
          transport_used: 'claude-channel',
          channel_session_id: target.delivery.channel_session_id,
        }
      }
    }

    if (paneId) {
      const tmuxResult = await deps.tmuxPoke({ pane_id: paneId, content: input.content })
      if ('ok' in tmuxResult && tmuxResult.ok) {
        return {
          ok: true,
          transport_used: 'tmux-poke',
          pane_id: paneId,
          pane_tail_before: tmuxResult.pane_tail_before,
          pane_tail_after: tmuxResult.pane_tail_after,
        }
      }
      return {
        ...(tmuxResult as { error: string; detail?: unknown }),
        transport_used: 'tmux-poke',
      }
    }

    return {
      error: 'no_transport_available',
      detail: {
        channel_subscribed: channelSubscribed,
        tmux_pane_set: false,
      },
    }
  }

  if (target.delivery.kind === 'codex-appserver') {
    console.warn(
      'codex-appserver dispatcher not implemented',
      target.delivery.thread_id,
      target.delivery.ws_url
    )
    return { error: 'dispatcher_not_implemented' }
  }

  if (paneId) {
    const tmuxResult = await deps.tmuxPoke({ pane_id: paneId, content: input.content })
    if ('ok' in tmuxResult && tmuxResult.ok) {
      return {
        ok: true,
        transport_used: 'tmux-poke',
        pane_id: paneId,
        pane_tail_before: tmuxResult.pane_tail_before,
        pane_tail_after: tmuxResult.pane_tail_after
      }
    }
    return { ...(tmuxResult as { error: string; detail?: unknown }), transport_used: 'tmux-poke' }
  }

  return {
    error: 'no_transport_available',
    detail: {
      channel_subscribed: false,
      tmux_pane_set: paneId != null
    }
  }
}
