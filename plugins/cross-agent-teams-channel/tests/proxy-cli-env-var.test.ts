import { describe, it, expect } from 'vitest'
import { parseCliArgs, CliArgError } from '../src/cli.js'

describe('channel proxy parseCliArgs env var', () => {
  it('reads CROSS_AGENT_TEAMS_MCP_DAEMON_URL when flag is absent', () => {
    const parsed = parseCliArgs([], {
      CROSS_AGENT_TEAMS_MCP_DAEMON_URL: 'http://example:8787',
      TS_AGENT_TEAMS_DAEMON_URL: 'http://legacy:8787'
    } as NodeJS.ProcessEnv)
    expect(parsed.daemonUrl).toBe('http://example:8787')
  })

  it('ignores legacy TS_AGENT_TEAMS_DAEMON_URL when new var is missing', () => {
    expect(() => parseCliArgs([], {
      TS_AGENT_TEAMS_DAEMON_URL: 'http://legacy:8787'
    } as NodeJS.ProcessEnv)).toThrow(CliArgError)
  })

  it('diagnostic mentions CROSS_AGENT_TEAMS_MCP_DAEMON_URL', () => {
    try {
      parseCliArgs([], {} as NodeJS.ProcessEnv)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as Error).message).toMatch(/CROSS_AGENT_TEAMS_MCP_DAEMON_URL/)
    }
  })
})
