import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { sendChannelWake } from '../daemon/channel-wake-send.js'
import type { DeliverySpec } from '../lib/delivery-spec.js'
import {
  dispatchCodexAppserverPoke,
  type CodexAppserverDispatchResult,
} from './codex-appserver-dispatch.js'
import {
  sendOpencodePrompt,
  type OpencodeTransportResult,
} from './opencode-transport.js'

export interface DispatchDeps {
  channelWakeFanout?: ChannelWakeFanout
  tmuxPoke: (args: { pane_id: string; content: string }) => Promise<TmuxPokeResult>
  codexAppserverDispatch?: (args: {
    delivery: Extract<DeliverySpec, { kind: 'codex-appserver' }>
    content: string
  }) => Promise<CodexAppserverDispatchResult>
  opencodeDispatch?: (args: {
    base_url: string
    session_id: string
    content: string
  }) => Promise<OpencodeTransportResult>
}

export type TmuxPokeResult =
  | { ok: true; pane_tail_before: string; pane_tail_after: string }
  | { error: string; detail?: unknown }

export interface TargetRow {
  delivery: DeliverySpec
  tmux_pane_id: string | null
  opencode_base_url: string | null
  opencode_session_id: string | null
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
      ok: true
      transport_used: 'codex-appserver'
      thread_id: string
    }
  | {
      ok: true
      transport_used: 'opencode-server'
      base_url: string
      session_id: string
    }
  | {
      error: string
      detail?: unknown
      transport_used?: 'tmux-poke' | 'codex-appserver' | 'opencode-server'
    }

export async function dispatchPoke(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  const paneId = target.tmux_pane_id

  // 1. Claude channel (highest priority)
  if (target.delivery.kind === 'claude-channel') {
    const channelSubscribed = deps.channelWakeFanout?.has(
      target.delivery.channel_session_id
    ) ?? false
    if (channelSubscribed && deps.channelWakeFanout) {
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

    // Fall through to opencode or tmux after failed channel
    const opencodeResult = await tryOpencode(deps, target, input)
    if (opencodeResult) return opencodeResult

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
        opencode_bound: false,
        tmux_pane_set: false,
      },
    }
  }

  // 2. Codex appserver
  if (target.delivery.kind === 'codex-appserver') {
    return (deps.codexAppserverDispatch ?? dispatchCodexAppserverPoke)({
      delivery: target.delivery,
      content: input.content,
    })
  }

  // 3. For 'none' or other delivery kinds: try opencode first, then tmux
  const opencodeResult = await tryOpencode(deps, target, input)
  if (opencodeResult) return opencodeResult

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
      opencode_bound: target.opencode_base_url != null && target.opencode_session_id != null,
      tmux_pane_set: paneId != null
    }
  }
}

async function tryOpencode(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult | null> {
  if (!target.opencode_base_url || !target.opencode_session_id) return null

  const result = await (deps.opencodeDispatch ?? ((args: { base_url: string; session_id: string; content: string }) =>
    sendOpencodePrompt({ base_url: args.base_url, session_id: args.session_id, prompt: args.content })))({
    base_url: target.opencode_base_url,
    session_id: target.opencode_session_id,
    content: input.content,
  })

  if ('ok' in result && result.ok) {
    return {
      ok: true,
      transport_used: 'opencode-server',
      base_url: target.opencode_base_url,
      session_id: target.opencode_session_id,
    }
  }

  return { ...(result as { error: string; detail?: unknown }), transport_used: 'opencode-server' }
}
