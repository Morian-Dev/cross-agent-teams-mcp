import { describe, it, expect } from 'vitest'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { dispatchPoke } from '../src/mcp/transport-dispatch.js'

function createTmuxStub(result: { ok: true; pane_tail_before: string; pane_tail_after: string }) {
  const calls: Array<{ pane_id: string; content: string }> = []
  return {
    calls,
    fn: async (args: { pane_id: string; content: string }) => {
      calls.push(args)
      return result
    },
  }
}

describe('poke dispatch routes by delivery.kind', () => {
  it('routes claude-channel to ChannelWakeFanout', async () => {
    const fanout = new ChannelWakeFanout()
    const emitted: unknown[] = []
    fanout.attach('csid-abc', payload => emitted.push(payload), 'sess-1')
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        delivery: { kind: 'claude-channel', channel_session_id: 'csid-abc' },
        tmux_pane_id: '%42',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      ok: true,
      transport_used: 'claude-channel',
      channel_session_id: 'csid-abc',
    })
    expect(emitted).toHaveLength(1)
    expect(tmux.calls).toHaveLength(0)
  })

  it('routes kind none to tmux when pane is set', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { delivery: { kind: 'none' }, tmux_pane_id: '%42' },
      { content: 'wake up', meta: {} }
    )

    expect(result).toMatchObject({
      ok: true,
      transport_used: 'tmux-poke',
      pane_id: '%42',
    })
    expect(tmux.calls).toEqual([{ pane_id: '%42', content: 'wake up' }])
  })

  it('routes kind none without tmux to no_transport_available', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { delivery: { kind: 'none' }, tmux_pane_id: null },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      error: 'no_transport_available',
      detail: { channel_subscribed: false, tmux_pane_set: false },
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('routes codex-appserver to dispatcher_not_implemented', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        delivery: {
          kind: 'codex-appserver',
          thread_id: 'thread-123',
          ws_url: 'wss://example.test/ws',
        },
        tmux_pane_id: '%42',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({ error: 'dispatcher_not_implemented' })
    expect(tmux.calls).toHaveLength(0)
  })
})
