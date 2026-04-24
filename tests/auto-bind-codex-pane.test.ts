import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import { autoBindCodexPane } from '../src/mcp/auto-bind-codex-pane.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-auto-bind-'))

interface MockBindSvc {
  bind: ReturnType<typeof vi.fn>
}

function makeBindSvc(result: unknown): MockBindSvc {
  return { bind: vi.fn().mockResolvedValue(result) }
}

function seedCaller(
  db: ReturnType<typeof openDb>,
  agentId: string,
  team = 'default',
  name = 'caller'
): void {
  db.prepare(
    `INSERT INTO agents (agent_id, team, role, name, registered_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, team, 'impl', name, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
}

describe('autoBindCodexPane', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('binds and consumes on a unique match', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true, tmux_pane_id: '%10', tty: 'ttys001' })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => ['12345 1 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'],
      }
    )
    expect(ok).toBe(true)
    expect(bindSvc.bind).toHaveBeenCalledWith({
      callerAgentId: 'caller-1',
      agent: 'codex',
      ui_pid: 12345,
    })
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(0)
  })

  it('returns false when there are zero pending pre-regs', async () => {
    seedCaller(db, 'caller-1')
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      { listPanes: async () => [], ttyProcesses: async () => [] }
    )
    expect(ok).toBe(false)
    expect(bindSvc.bind).not.toHaveBeenCalled()
  })

  it('returns false on multi-match without consuming any row', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    repo.upsert({ pane_id: '%20', xats_agent_id: 'U2', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [
          { pane_id: '%10', tty: 'ttys001' },
          { pane_id: '%20', tty: 'ttys002' },
        ],
        ttyProcesses: async (tty) => {
          if (tty === 'ttys001') return ['111 1 Ss codex --remote -c xats.agent_id="U1"']
          if (tty === 'ttys002') return ['222 1 Ss codex --remote -c xats.agent_id="U2"']
          return []
        },
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.bind).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(2)
  })

  it('returns false without consuming when argv UUID does not match', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        // argv has U2, stored UUID is U1
        ttyProcesses: async () => ['111 1 Ss codex --remote -c xats.agent_id="U2"'],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.bind).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('returns false when tmux is unavailable, without throwing', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => { throw new Error('tmux: command not found') },
        ttyProcesses: async () => [],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.bind).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('skips rows whose pane is missing from tmux list', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%GONE', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      { listPanes: async () => [], ttyProcesses: async () => [] }
    )
    expect(ok).toBe(false)
    expect(bindSvc.bind).not.toHaveBeenCalled()
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('does not consume when bind_runtime_identity fails', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ error: 'pid_has_no_tty' })
    const ok = await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => ['111 1 Ss codex --remote -c xats.agent_id="U1"'],
      }
    )
    expect(ok).toBe(false)
    expect(bindSvc.bind).toHaveBeenCalledTimes(1)
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('GCs expired rows before scanning', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({ pane_id: '%EXPIRED', xats_agent_id: 'OLD', expires_at: '2000-01-01T00:00:00Z' })
    repo.upsert({ pane_id: '%10', xats_agent_id: 'U1', expires_at: '2999-01-01T00:00:00Z' })
    const bindSvc = makeBindSvc({ ok: true })
    await autoBindCodexPane(
      { callerAgentId: 'caller-1', repo, bindRuntimeIdentitySvc: bindSvc as never },
      {
        listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
        ttyProcesses: async () => ['111 1 Ss codex --remote -c xats.agent_id="U1"'],
        now: () => new Date('2026-01-01T00:00:00Z'),
      }
    )
    // Both the expired row (GC) and the matched row (consumed) should be gone.
    expect(repo.listUnexpired('2100-01-01T00:00:00Z')).toHaveLength(0)
  })
})
