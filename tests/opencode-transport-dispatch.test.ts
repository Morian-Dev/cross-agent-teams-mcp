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

describe('opencode transport dispatch', () => {
  it('prefers claude-channel over opencode and tmux', async () => {
    const fanout = new ChannelWakeFanout()
    const emitted: unknown[] = []
    fanout.attach('csid-bob', payload => emitted.push(payload), 'sess-1')
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })
    const opencodeCalls: Array<{ base_url: string; session_id: string; content: string }> = []

    const result = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeDispatch: async (args) => {
          opencodeCalls.push(args)
          return { ok: true }
        },
      },
      {
        delivery: { kind: 'claude-channel', channel_session_id: 'csid-bob' },
        tmux_pane_id: '%99',
        opencode_base_url: 'http://127.0.0.1:4096',
        opencode_session_id: 'sess-bob',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      ok: true,
      transport_used: 'claude-channel',
      channel_session_id: 'csid-bob',
    })
    expect(emitted).toHaveLength(1)
    expect(opencodeCalls).toHaveLength(0)
    expect(tmux.calls).toHaveLength(0)
  })

  it('uses opencode when channel sink absent and opencode bound', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeDispatch: async () => ({ ok: true }),
      },
      {
        delivery: { kind: 'claude-channel', channel_session_id: 'csid-bob' },
        tmux_pane_id: '%99',
        opencode_base_url: 'http://127.0.0.1:4096',
        opencode_session_id: 'sess-bob',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      ok: true,
      transport_used: 'opencode-server',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'sess-bob',
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('falls back to tmux when opencode not bound', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        delivery: { kind: 'none' },
        tmux_pane_id: '%99',
        opencode_base_url: null,
        opencode_session_id: null,
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toMatchObject({
      ok: true,
      transport_used: 'tmux-poke',
      pane_id: '%99',
    })
  })

  it('returns no_transport_available with opencode_bound detail field', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        delivery: { kind: 'none' },
        tmux_pane_id: null,
        opencode_base_url: null,
        opencode_session_id: null,
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      error: 'no_transport_available',
      detail: { channel_subscribed: false, opencode_bound: false, tmux_pane_set: false },
    })
  })

  it('returns opencode_unreachable when server not reachable', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeDispatch: async () => ({
          error: 'opencode_unreachable' as const,
          detail: 'ECONNREFUSED',
        }),
      },
      {
        delivery: { kind: 'none' },
        tmux_pane_id: null,
        opencode_base_url: 'http://127.0.0.1:4096',
        opencode_session_id: 'sess-bob',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      error: 'opencode_unreachable',
      detail: 'ECONNREFUSED',
      transport_used: 'opencode-server',
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('returns opencode_session_not_found when session missing', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeDispatch: async () => ({
          error: 'opencode_session_not_found' as const,
          detail: { message: 'Session not found' },
        }),
      },
      {
        delivery: { kind: 'none' },
        tmux_pane_id: null,
        opencode_base_url: 'http://127.0.0.1:4096',
        opencode_session_id: 'sess-missing',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      error: 'opencode_session_not_found',
      detail: { message: 'Session not found' },
      transport_used: 'opencode-server',
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('returns opencode_session_busy when session is processing', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeDispatch: async () => ({
          error: 'opencode_session_busy' as const,
          detail: { message: 'Session is busy' },
        }),
      },
      {
        delivery: { kind: 'none' },
        tmux_pane_id: null,
        opencode_base_url: 'http://127.0.0.1:4096',
        opencode_session_id: 'sess-busy',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      error: 'opencode_session_busy',
      detail: { message: 'Session is busy' },
      transport_used: 'opencode-server',
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('returns opencode_request_failed for other errors', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = createTmuxStub({ ok: true, pane_tail_before: 'before', pane_tail_after: 'after' })

    const result = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeDispatch: async () => ({
          error: 'opencode_request_failed' as const,
          detail: 'Internal server error',
        }),
      },
      {
        delivery: { kind: 'none' },
        tmux_pane_id: null,
        opencode_base_url: 'http://127.0.0.1:4096',
        opencode_session_id: 'sess-err',
      },
      { content: 'wake up', meta: {} }
    )

    expect(result).toEqual({
      error: 'opencode_request_failed',
      detail: 'Internal server error',
      transport_used: 'opencode-server',
    })
    expect(tmux.calls).toHaveLength(0)
  })
})
