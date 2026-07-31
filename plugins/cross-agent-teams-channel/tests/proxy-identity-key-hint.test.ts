import { describe, it, expect } from 'vitest'
import { parseCliArgs, buildStartupHint } from '../src/cli.js'

const DAEMON = ['--daemon-url', 'http://127.0.0.1:8787']

// Verbatim copy of the notification emitted before the identity key existed.
// Adding the key branch must not perturb the no-key path by a single byte, so
// this stays a literal rather than an inline snapshot.
const HINT_WITHOUT_KEY =
  'cross-agent-teams-mcp: your channel_session_id is CSID-PLACEHOLDER. '
  + 'Do NOT register automatically. First ask the user (in English) to register this session so it can talk to other agents — use exactly this wording: '
  + "'To join cross-agent-teams (xats) and message other agents, reply with: Register to xats — name: your-agent-name, team: your-team-name (optional; defaults to the current working directory basename).' "
  + 'Once the user provides a name (and optionally a team), call register_agent({agent_type: "claude-code", name: "<name from user>", team: "<team from user, omit if not provided>", ui_pid: $PPID, project_dir: "<current working directory>"}). Do NOT pass channel_session_id here; the daemon auto-binds via ui_pid. '
  + 'If this is a reconnect (context clear, resume, or channel re-attach), route by whether you still remember your own (team, name): if you DO remember it (for example after closing Claude Code and resuming the conversation, where your $PPID has changed but the context survived), call register_agent({agent_type: "claude-code", name: "<your remembered name>", team: "<your remembered team>", ui_pid: $PPID, project_dir: "<current working directory>"}) and then state in your reply which identity you re-registered as — do NOT call reconnect, because it would reverse-look-up the changed $PPID, find no match, and return need_register. If you do NOT remember your (team, name) (for example after a context clear), call reconnect({ui_pid: $PPID}) to recover your prior (team, name) and rebind to this new csid in one step; on a need_register result, ask the user. bind_channel({channel_session_id: "CSID-PLACEHOLDER"}) only rebinds when your CURRENT MCP session is already bound to your agent; on a fresh or resumed MCP session it returns unknown_agent, so use reconnect (or register_agent with your remembered identity) instead. Neither is the primary first-time registration path. '
  + 'Do not use curl or another external HTTP client for Claude registration here — that would create a different MCP session, and follow-up tools in Claude Code could still see unknown_agent.'

describe('parseCliArgs XATS_IDENTITY_KEY', () => {
  it('reads the key from the environment', () => {
    const parsed = parseCliArgs(DAEMON, {
      XATS_IDENTITY_KEY: 'abc-123',
    } as NodeJS.ProcessEnv)
    expect(parsed.identityKey).toBe('abc-123')
  })

  it('leaves the key undefined when the env var is absent or blank', () => {
    expect(parseCliArgs(DAEMON, {} as NodeJS.ProcessEnv).identityKey)
      .toBeUndefined()
    expect(parseCliArgs(DAEMON, {
      XATS_IDENTITY_KEY: '   ',
    } as NodeJS.ProcessEnv).identityKey).toBeUndefined()
  })

  it('does not accept the key as a CLI flag', () => {
    // `.mcp.json` is shared by directory, so a flag would hand every instance
    // in that directory the same per-pane key.
    const parsed = parseCliArgs(
      [...DAEMON, '--identity-key', 'abc-123'],
      {} as NodeJS.ProcessEnv
    )
    expect(parsed.identityKey).toBeUndefined()
  })
})

describe('buildStartupHint identity key branch', () => {
  const csid = '11111111-2222-3333-4444-555555555555'

  it('inlines the literal key into the reconnect call it shows', () => {
    const hint = buildStartupHint(csid, undefined, 'abc-123')
    expect(hint.content).toContain('abc-123')
    expect(hint.content).toContain(
      'reconnect({identity_key: "abc-123", ui_pid: $PPID})'
    )
    expect(hint.content).toContain('identity_key: "abc-123"')
    expect(hint.content).toMatch(/need_register/)
  })

  it('puts that branch ahead of the remembers / does-not-remember branches', () => {
    const hint = buildStartupHint(csid, undefined, 'abc-123')
    const keyAt = hint.content.indexOf('This pane carries an identity key')
    expect(keyAt).toBeGreaterThan(-1)
    expect(keyAt).toBeLessThan(hint.content.indexOf('If this is a reconnect'))
    expect(keyAt).toBeLessThan(
      hint.content.indexOf('reconnect({ui_pid: $PPID})')
    )
    expect(keyAt).toBeLessThan(hint.content.indexOf('Do NOT register automatically'))
    // csid line still leads.
    expect(hint.content.indexOf(csid)).toBeLessThan(keyAt)
  })

  it('emits byte-identical content when no key is present', () => {
    expect(buildStartupHint('CSID-PLACEHOLDER').content).toBe(HINT_WITHOUT_KEY)

    const withoutArg = buildStartupHint(csid)
    expect(buildStartupHint(csid, undefined, undefined).content)
      .toBe(withoutArg.content)
    expect(withoutArg.content).not.toMatch(/identity[ _]key/i)
    expect(withoutArg.content).not.toContain('XATS_IDENTITY_KEY')

    const crossHost = buildStartupHint(csid, 'mb-neo')
    expect(buildStartupHint(csid, 'mb-neo', undefined).content)
      .toBe(crossHost.content)
    expect(crossHost.content).not.toMatch(/identity[ _]key/i)
  })

  it('keeps the cross-host device wording alongside the key branch', () => {
    const hint = buildStartupHint(csid, 'mb-neo', 'abc-123')
    expect(hint.content).toContain('abc-123')
    expect(hint.content).toContain('device: "mb-neo"')
  })
})
