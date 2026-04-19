import { describe, it, expect } from 'vitest'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { dispatchPoke } from '../src/mcp/transport-dispatch.js'

type TmuxStub = {
  calls: Array<{ pane_id: string; content: string }>
  result: { ok: true; pane_tail_before: string; pane_tail_after: string } |
          { error: string; detail?: unknown }
}

function stubTmux(result: TmuxStub['result']): TmuxStub & { fn: (args: { pane_id: string; content: string }) => Promise<typeof result> } {
  const self: TmuxStub = { calls: [], result }
  return {
    ...self,
    fn: async (args) => { self.calls.push(args); return result }
  }
}

describe('dispatchPoke', () => {
  it('prefers channel when csid set + sink attached', async () => {
    const fanout = new ChannelWakeFanout()
    const emitted: unknown[] = []
    fanout.attach('csid-bob', (p) => emitted.push(p), 'sess-P')
    const tmux = stubTmux({ ok: true, pane_tail_before: 'b', pane_tail_after: 'a' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { channel_session_id: 'csid-bob', tmux_pane_id: '%99' },
      { content: 'hi', meta: { source: 'x' } }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'claude-channel', channel_session_id: 'csid-bob' })
    expect(emitted).toHaveLength(1)
    expect(tmux.calls).toHaveLength(0)
  })

  it('falls back to tmux when csid set but no sink attached', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: 'bb', pane_tail_after: 'aa' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { channel_session_id: 'csid-bob', tmux_pane_id: '%99' },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke', pane_id: '%99' })
    expect(tmux.calls).toEqual([{ pane_id: '%99', content: 'hi' }])
  })

  it('uses tmux directly when csid is null', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: 'x', pane_tail_after: 'y' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { channel_session_id: null, tmux_pane_id: '%42' },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke' })
  })

  it('returns no_transport_available when neither csid/sink nor tmux available', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { channel_session_id: null, tmux_pane_id: null },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'no_transport_available',
      detail: { channel_subscribed: false, tmux_pane_set: false }
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('returns no_transport_available when csid has no sink and tmux_pane absent', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { channel_session_id: 'csid-x', tmux_pane_id: null },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'no_transport_available',
      detail: { channel_subscribed: false, tmux_pane_set: false }
    })
  })

  it('propagates tmux error envelope with transport_used', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ error: 'pane_dead', detail: 'no pane' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { channel_session_id: null, tmux_pane_id: '%42' },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ error: 'pane_dead', transport_used: 'tmux-poke' })
  })
})
