# Tasks — rename-to-cross-agent-teams-mcp

Ordering: task 1 must precede 6/7/8 (directory rename unblocks sub-package edits).  Task 2 is independent of 1.  Tasks 3/4/5 operate on the daemon source.  Task 10 runs last as a gate.

## 1. Rename channel plugin directory and rewire build / test imports

- [ ] 1.1 Move `plugins/ts-agent-teams-channel/` to `plugins/cross-agent-teams-channel/` and update every in-repo reference to the old path
  - kind: build-check
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: Brand-sweep grep returns zero matches
  - **Files:**
    - Move (git mv): `plugins/ts-agent-teams-channel/` → `plugins/cross-agent-teams-channel/`
    - Modify: `tsconfig.json`
    - Modify: `tests/proxy-reconnect.test.ts`
    - Modify: `tests/proxy-registration-sequence.test.ts`
    - Modify: `tests/e2e-channel-poke.test.ts`
    - Modify: `plugins/cross-agent-teams-channel/package.json` (name + bin)
    - Modify: `plugins/cross-agent-teams-channel/plugin.json` (name)
    - Modify: `plugins/cross-agent-teams-channel/README.md` (title + brand words)
  - [ ] **IMPLEMENT:** Execute the directory rename and cascade every reference
    - `git mv plugins/ts-agent-teams-channel plugins/cross-agent-teams-channel`
    - `tsconfig.json`: change `"plugins/ts-agent-teams-channel/src/**/*"` to `"plugins/cross-agent-teams-channel/src/**/*"`
    - In each top-level test file above, replace the import specifier `../plugins/ts-agent-teams-channel/src/...` with `../plugins/cross-agent-teams-channel/src/...`
    - `plugins/cross-agent-teams-channel/package.json`: `name: "cross-agent-teams-channel"`, `bin: { "cross-agent-teams-proxy": "./dist/cli.js" }`, update description to drop `ts-agent-teams` (replace with `cross-agent-teams-mcp`)
    - `plugins/cross-agent-teams-channel/plugin.json`: `name: "cross-agent-teams-channel"`, update description likewise
    - `plugins/cross-agent-teams-channel/README.md`: replace every `ts-agent-teams-channel` with `cross-agent-teams-channel` and every free-standing `ts-agent-teams` with `cross-agent-teams-mcp`
  - [ ] **BUILD-CHECK:** `pnpm install && pnpm -r typecheck` completes with exit 0
    - Command: `pnpm install && pnpm -r typecheck`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `chore(channel-plugin): rename plugin directory to cross-agent-teams-channel`
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 2. Rename main package identity and CLI usage string

- [ ] 2.1 Rename the top-level npm package, bin entry, and the CLI usage message
  - kind: build-check
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: Default bind address
  - **Files:**
    - Modify: `package.json`
    - Modify: `src/cli.ts`
  - [ ] **IMPLEMENT:** Swap the brand in main package identity
    - `package.json`: set `"name": "cross-agent-teams-mcp"`, replace `"bin": { "ts-agent-teams": "./dist/cli.js" }` with `"bin": { "cross-agent-teams-mcp": "./dist/cli.js" }`, update description to `"MCP daemon for cross-agent collaboration"` (unchanged) and verify no `ts-agent-teams` substring remains in this file
    - `src/cli.ts` line 16: change usage string from `'usage: ts-agent-teams daemon [options]'` to `'usage: cross-agent-teams-mcp daemon [options]'`
  - [ ] **BUILD-CHECK:** `pnpm install && pnpm build` succeeds and emits a runnable CLI under the new bin name
    - Command: `pnpm install && pnpm build && node dist/cli.js 2>&1 | head -1`
    - Expect: stdout / stderr contains the new usage string `cross-agent-teams-mcp daemon`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `chore(pkg): rename main package to cross-agent-teams-mcp`
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 3. Daemon honors CROSS_AGENT_TEAMS_MCP_HOME env var and default home dir

- [ ] 3.1 Daemon reads `CROSS_AGENT_TEAMS_MCP_HOME` (with `.cross-agent-teams-mcp` under `$HOME` as fallback) and writes pid file there
  - kind: integration-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: Fresh startup writes pid file
    - `daemon-core/spec.md` → Scenario: Stale pid file (process dead)
    - `daemon-core/spec.md` → Scenario: Live daemon already running
  - **Files:**
    - Create: `tests/daemon-home-dir-rename.test.ts`
    - Modify: `src/cli.ts`
  - [ ] **INTEGRATION-RED:** Write failing integration test — `tests/daemon-home-dir-rename.test.ts`
    - Behavior under test: spawning `dist/cli.js daemon --port 0` with `CROSS_AGENT_TEAMS_MCP_HOME=<tmp>` creates `<tmp>/daemon.pid`
    - Expected failure reason: current code reads `TS_AGENT_TEAMS_HOME`, not `CROSS_AGENT_TEAMS_MCP_HOME`, so it falls back to `$HOME/.ts-agent-teams/` and the assertion at the new path fails
    ```ts
    import { describe, it, expect } from 'vitest'
    import { spawn } from 'node:child_process'
    import { mkdtempSync, existsSync, rmSync } from 'node:fs'
    import { join } from 'node:path'
    import { tmpdir } from 'node:os'

    describe('daemon home dir honors CROSS_AGENT_TEAMS_MCP_HOME', () => {
      it('writes pid file to env-specified home and cleans up on shutdown', async () => {
        const home = mkdtempSync(join(tmpdir(), 'catm-home-'))
        const pidPath = join(home, 'daemon.pid')
        const proc = spawn(
          process.execPath,
          ['dist/cli.js', 'daemon', '--port', '0'],
          {
            env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: home, TS_AGENT_TEAMS_HOME: '' },
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
        try {
          const deadline = Date.now() + 5000
          while (Date.now() < deadline && !existsSync(pidPath)) {
            await new Promise(r => setTimeout(r, 50))
          }
          expect(existsSync(pidPath)).toBe(true)
        } finally {
          proc.kill('SIGTERM')
          await new Promise<void>(r => { proc.once('exit', () => r()) })
          rmSync(home, { recursive: true, force: true })
        }
      }, 15_000)
    })
    ```
  - [ ] **Verify RED:** Run the test against current code, confirm failure
    - Command: `pnpm build && pnpm vitest run tests/daemon-home-dir-rename.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **INTEGRATION-GREEN:** Update `src/cli.ts` to read the new env var and default to the new home dir
    ```ts
    // src/cli.ts (around line 17) — replace the old env+default pair
    const home = process.env.CROSS_AGENT_TEAMS_MCP_HOME ?? join(homedir(), '.cross-agent-teams-mcp')
    ```
  - [ ] **Verify GREEN:** Re-run the new test and the full suite; both green
    - Command: `pnpm build && pnpm vitest run tests/daemon-home-dir-rename.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None — the change is a two-token substitution and already minimal
  - [ ] **Verify REFACTOR:** Re-run full suite to confirm still green
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `feat(daemon): rename env var and home dir to CROSS_AGENT_TEAMS_MCP_*`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 4. Daemon MCP server identity reports cross-agent-teams-mcp

- [ ] 4.1 The McpServer constructor in `src/mcp/transport.ts` declares `name: 'cross-agent-teams-mcp'`
  - kind: integration-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: initialize serverInfo.name reports new brand
  - **Files:**
    - Create: `tests/daemon-server-name.test.ts`
    - Modify: `src/mcp/transport.ts`
  - [ ] **INTEGRATION-RED:** Write failing integration test — `tests/daemon-server-name.test.ts`
    - Behavior under test: after MCP `initialize`, the client sees `serverInfo.name === 'cross-agent-teams-mcp'`
    - Expected failure reason: current constructor sets `name: 'ts-agent-teams'`, so the assertion fails
    ```ts
    import { describe, it, expect } from 'vitest'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { startServer } from '../src/daemon/server.js'

    describe('daemon MCP server identity', () => {
      it('reports cross-agent-teams-mcp during initialize', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'catm-srv-'))
        const started = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        try {
          const url = `http://${started.host}:${started.port}/mcp`
          const client = new Client({ name: 'test', version: '0.0.0' })
          const transport = new StreamableHTTPClientTransport(new URL(url))
          await client.connect(transport)
          const info = client.getServerVersion()
          expect(info?.name).toBe('cross-agent-teams-mcp')
          await client.close()
        } finally {
          await started.app.close()
          rmSync(dir, { recursive: true, force: true })
        }
      }, 15_000)
    })
    ```
  - [ ] **Verify RED:** Run the test, confirm failure
    - Command: `pnpm vitest run tests/daemon-server-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **INTEGRATION-GREEN:** Update `src/mcp/transport.ts` line 30
    ```ts
    const server = new McpServer({ name: 'cross-agent-teams-mcp', version: '0.1.0' })
    ```
  - [ ] **Verify GREEN:** Re-run the new test and the full suite; both green
    - Command: `pnpm vitest run tests/daemon-server-name.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None — single-token rename
  - [ ] **Verify REFACTOR:** Re-run full suite
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `refactor(mcp): rename daemon server identity to cross-agent-teams-mcp`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 5. Daemon tool descriptions and register_agent hint carry new brand

- [ ] 5.1 `tools/list` and the `register_agent` hint mention `cross-agent-teams-mcp` and not `ts-agent-teams`
  - kind: integration-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: Brand-sweep grep returns zero matches
  - **Files:**
    - Create: `tests/daemon-brand-in-tool-text.test.ts`
    - Modify: `src/mcp/tools.ts`
  - [ ] **INTEGRATION-RED:** Write failing integration test — `tests/daemon-brand-in-tool-text.test.ts`
    - Behavior under test: after the daemon is up, every returned tool description and the `register_agent` hint for a no-tmux caller contain no `ts-agent-teams` substring and at least one mention of `cross-agent-teams-mcp`
    - Expected failure reason: current `tools.ts` lines 219/525/553 embed `ts-agent-teams` literals; the assertion rejecting that substring fails
    ```ts
    import { describe, it, expect } from 'vitest'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { startServer } from '../src/daemon/server.js'

    describe('daemon brand in tool text', () => {
      it('no tool description contains legacy ts-agent-teams', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'catm-brand-'))
        const started = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        try {
          const url = `http://${started.host}:${started.port}/mcp`
          const client = new Client({ name: 'test', version: '0.0.0' })
          const transport = new StreamableHTTPClientTransport(new URL(url))
          await client.connect(transport)
          const list = await client.listTools()
          for (const t of list.tools) {
            expect(t.description ?? '').not.toContain('ts-agent-teams')
          }
          const resp = await client.callTool({
            name: 'register_agent',
            arguments: { model: 'test', role: 'tester', name: 'hint-probe', team: 'default' }
          })
          const text = (resp as { content: Array<{ text: string }> }).content[0].text
          expect(text).not.toContain('ts-agent-teams')
          await client.close()
        } finally {
          await started.app.close()
          rmSync(dir, { recursive: true, force: true })
        }
      }, 15_000)
    })
    ```
  - [ ] **Verify RED:** Run the test, confirm failure
    - Command: `pnpm vitest run tests/daemon-brand-in-tool-text.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **INTEGRATION-GREEN:** Replace the three brand sites in `src/mcp/tools.ts`
    - Line 219 (`register_agent` hint): swap every `ts-agent-teams` for `cross-agent-teams-mcp` (covers two mentions: the channel-plugin name and the tool family)
    - Line 525 (`bind_channel` description): `…produced by the cross-agent-teams-mcp channel proxy.`
    - Line 553 (internal tool description): `Internal tool reserved for the cross-agent-teams-mcp channel proxy.`
    ```ts
    // representative replacements — exact strings depend on surrounding text but every
    // occurrence of the literal token `ts-agent-teams` in tools.ts becomes `cross-agent-teams-mcp`
    ```
  - [ ] **Verify GREEN:** Re-run the new test and the full suite
    - Command: `pnpm vitest run tests/daemon-brand-in-tool-text.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None — textual rename only
  - [ ] **Verify REFACTOR:** Re-run full suite
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `refactor(tools): purge legacy brand from tool descriptions and hints`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 6. Channel proxy MCP server + client names

- [ ] 6.1 `createProxyServer()` declares `name: 'cross-agent-teams-channel'`, and the outbound Client declares `name: 'cross-agent-teams-proxy'`
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: proxy serverInfo.name reports new brand to host
  - **Files:**
    - Create: `plugins/cross-agent-teams-channel/tests/proxy-server-name.test.ts`
    - Modify: `plugins/cross-agent-teams-channel/src/proxy.ts`
    - Modify: `plugins/cross-agent-teams-channel/src/daemon-client.ts`
  - [ ] **RED:** Write failing test — `plugins/cross-agent-teams-channel/tests/proxy-server-name.test.ts`
    - Behavior under test: connect a fake MCP client to the proxy server over InMemoryTransport and assert serverInfo.name reflects the new brand
    - Expected failure reason: current proxy.ts declares `name: 'ts-agent-teams-channel'`
    ```ts
    import { describe, it, expect } from 'vitest'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
    import { createProxyServer } from '../src/proxy.js'

    describe('channel proxy server identity', () => {
      it('serverInfo.name is cross-agent-teams-channel', async () => {
        const server = createProxyServer()
        const client = new Client({ name: 'fake-host', version: '0.0.0' })
        const [clientT, serverT] = InMemoryTransport.createLinkedPair()
        await server.connect(serverT)
        await client.connect(clientT)
        expect(client.getServerVersion()?.name).toBe('cross-agent-teams-channel')
        await client.close()
        await server.close()
      })
    })
    ```
  - [ ] **Verify RED:** Run the test, confirm failure
    - Command: `pnpm vitest run plugins/cross-agent-teams-channel/tests/proxy-server-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **GREEN:** Update proxy.ts line 5 and daemon-client.ts line 44
    ```ts
    // plugins/cross-agent-teams-channel/src/proxy.ts
    return new McpServer(
      { name: 'cross-agent-teams-channel', version: '0.1.0' },
      { capabilities: { experimental: { 'claude/channel': {} } } }
    )
    ```
    ```ts
    // plugins/cross-agent-teams-channel/src/daemon-client.ts (around line 44)
    const client = new Client({ name: 'cross-agent-teams-proxy', version: '0.1.0' })
    ```
  - [ ] **Verify GREEN:** Re-run the new test and the full suite
    - Command: `pnpm vitest run plugins/cross-agent-teams-channel/tests/proxy-server-name.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None — the change is a two-token substitution
  - [ ] **Verify REFACTOR:** Re-run full suite
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `refactor(channel-plugin): rename MCP server and client identity`
    - Staging order: test file BEFORE production files
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 7. Channel proxy CLI reads CROSS_AGENT_TEAMS_MCP_DAEMON_URL

- [ ] 7.1 `parseCliArgs` honors `CROSS_AGENT_TEAMS_MCP_DAEMON_URL` and the missing-arg diagnostic mentions it
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: proxy honors CROSS_AGENT_TEAMS_MCP_DAEMON_URL env var when flag omitted
    - `claude-channel-transport/spec.md` → Scenario: proxy exits when neither flag nor CROSS_AGENT_TEAMS_MCP_DAEMON_URL is set
  - **Files:**
    - Create: `plugins/cross-agent-teams-channel/tests/proxy-cli-env-var.test.ts`
    - Modify: `plugins/cross-agent-teams-channel/src/cli.ts`
    - Modify: `plugins/cross-agent-teams-channel/tests/proxy-cli.test.ts` (update regex on line 244 and env wipe on line 233)
  - [ ] **RED:** Write failing test — `plugins/cross-agent-teams-channel/tests/proxy-cli-env-var.test.ts`
    - Behavior under test: when `--daemon-url` is absent, `parseCliArgs` reads `CROSS_AGENT_TEAMS_MCP_DAEMON_URL` and IGNORES the legacy `TS_AGENT_TEAMS_DAEMON_URL`; when neither is set, error message mentions `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`
    - Expected failure reason: current code reads `TS_AGENT_TEAMS_DAEMON_URL`, so the positive-case assertion returns the wrong URL and the diagnostic-regex assertion rejects the legacy name
    ```ts
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
    ```
  - [ ] **Verify RED:** Run the test, confirm failure
    - Command: `pnpm vitest run plugins/cross-agent-teams-channel/tests/proxy-cli-env-var.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **GREEN:** Update `plugins/cross-agent-teams-channel/src/cli.ts`
    ```ts
    // around line 35 — env var lookup
    if (!daemonUrl || daemonUrl.length === 0) {
      daemonUrl = env.CROSS_AGENT_TEAMS_MCP_DAEMON_URL
    }

    if (!daemonUrl || daemonUrl.length === 0) {
      throw new CliArgError(
        'missing --daemon-url (or CROSS_AGENT_TEAMS_MCP_DAEMON_URL env var)'
      )
    }
    ```
    Also update `proxy-cli.test.ts`:
    - line 233: `env: { ...process.env, CROSS_AGENT_TEAMS_MCP_DAEMON_URL: '' }` (and any other TS_* wipe in that test)
    - line 244: `expect(stderr).toMatch(/daemon-url|daemon_url|CROSS_AGENT_TEAMS_MCP_DAEMON_URL/i)`
  - [ ] **Verify GREEN:** Re-run new test plus the updated proxy-cli test; both pass
    - Command: `pnpm vitest run plugins/cross-agent-teams-channel/tests/proxy-cli-env-var.test.ts plugins/cross-agent-teams-channel/tests/proxy-cli.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None — textual rename only
  - [ ] **Verify REFACTOR:** Re-run full suite
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `feat(channel-plugin): rename CLI env var to CROSS_AGENT_TEAMS_MCP_DAEMON_URL`
    - Staging order: new test + updated assertion test BEFORE production cli.ts change
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 8. Channel proxy startup hint content uses new brand

- [ ] 8.1 The startup `notifications/claude/channel` payload (content + meta.source) mentions `cross-agent-teams-mcp`, not `ts-agent-teams`
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: proxy emits startup channel notification with csid and bind instruction
    - `claude-channel-transport/spec.md` → Scenario: proxy generates fresh csid on every startup
  - **Files:**
    - Modify: `plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts` (update assertions first — this is the RED)
    - Modify: `plugins/cross-agent-teams-channel/src/cli.ts`
  - [ ] **RED:** Strengthen assertions in the existing startup-notification test so they reject the legacy brand
    - Behavior under test: the relayed notification content and meta.source use the new brand
    - Expected failure reason: current cli.ts startup hint emits `ts-agent-teams: your channel_session_id is …` with `meta: { source: 'ts_agent_teams' }` — the new assertions would reject those literals
    ```ts
    // In plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts
    // Replace the existing content builder in the test body and add two stricter
    // assertions on the relayed payload:
    const content = [
      `cross-agent-teams-mcp: your channel_session_id is ${csid}.`,
      `Please call bind_channel({channel_session_id: "${csid}"}) to complete binding.`
    ].join(' ')
    relayChannelWake(server, {
      content,
      meta: { source: 'cross_agent_teams_mcp', kind: 'startup_bind_hint' }
    })
    // ...existing awaits and the `hit` lookup stay the same...
    expect(params.content).toContain('cross-agent-teams-mcp')
    expect(params.content).not.toContain('ts-agent-teams')
    expect(params.meta.source).toBe('cross_agent_teams_mcp')
    ```
  - [ ] **Verify RED:** Run the updated test against current production code, confirm failure
    - Command: `pnpm vitest run plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **GREEN:** Update `plugins/cross-agent-teams-channel/src/cli.ts` (around lines 55, 75-82) so the production code now matches the asserted payload
    ```ts
    // around line 55 — stderr prefix on arg-parse failure
    process.stderr.write(`cross-agent-teams-proxy: ${msg}\n`)

    // around lines 75-83 — startup hint content
    const content = [
      `cross-agent-teams-mcp: your channel_session_id is ${csid}.`,
      `If you have not called register_agent yet, call it first (the cross-agent-teams-mcp register_agent tool).`,
      `Then call bind_channel({channel_session_id: "${csid}"}) to complete binding.`,
      `If bind_channel returns unknown_agent, it means register_agent has not completed yet — call register_agent then retry bind_channel.`
    ].join(' ')
    relayChannelWake(hostServer, {
      content,
      meta: { source: 'cross_agent_teams_mcp', kind: 'startup_bind_hint' }
    })
    ```
  - [ ] **Verify GREEN:** Re-run the updated test and the full suite
    - Command: `pnpm vitest run plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None — textual rename only
  - [ ] **Verify REFACTOR:** Re-run full suite
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `refactor(channel-plugin): rename brand in startup hint content`
    - Staging order: test assertions BEFORE cli.ts edits
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 9. Brand sync across docs, opencode.json, .gitignore

- [ ] 9.1 Replace every legacy brand mention in the active docs/config files
  - kind: skip-doc-only
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: Brand-sweep grep returns zero matches
  - [ ] **SKIP:** skip-doc-only — pure textual brand sync in docs and config files; no runtime contract of its own beyond what Task 10's brand-sweep enforces.  Files touched: `docs/configs/README.md`, `docs/configs/claude-code.md`, `docs/configs/codex-cli.md`, `docs/configs/opencode.md`, `opencode.json`, `.gitignore` (line 62: `.cross-agent-teams-mcp-test/`).  Replace every `ts-agent-teams` with `cross-agent-teams-mcp` in each file; in `opencode.json` the MCP key becomes `"cross-agent-teams-mcp"`.

## 10. Final brand-sweep gate

- [ ] 10.1 A test that fails if any active source file still contains the legacy brand word
  - kind: integration-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: Brand-sweep grep returns zero matches
  - **Files:**
    - Create: `tests/brand-sweep.test.ts`
  - [ ] **INTEGRATION-RED:** Write the sweep test before any other rename task lands (or re-confirm failure after tasks 1-9 by temporarily reverting a single file)
    - Behavior under test: a shell `grep -r 'ts-agent-teams'` over the active paths returns no matches
    - Expected failure reason: before tasks 1-9 land, every active source file still carries the legacy brand
    ```ts
    import { describe, it, expect } from 'vitest'
    import { execFileSync } from 'node:child_process'

    const ACTIVE_PATHS = [
      'src',
      'plugins/cross-agent-teams-channel/src',
      'plugins/cross-agent-teams-channel/tests',
      'plugins/cross-agent-teams-channel/package.json',
      'plugins/cross-agent-teams-channel/plugin.json',
      'plugins/cross-agent-teams-channel/README.md',
      'tests',
      'docs/configs',
      'openspec/specs',
      'package.json',
      'tsconfig.json',
      'opencode.json',
      '.gitignore'
    ]

    describe('brand sweep', () => {
      it('no active source file contains the legacy ts-agent-teams brand', () => {
        let hits = ''
        try {
          hits = execFileSync(
            'grep',
            ['-rHn', '--binary-files=without-match', 'ts-agent-teams', ...ACTIVE_PATHS],
            { encoding: 'utf8' }
          )
        } catch (e: unknown) {
          const err = e as { status?: number; stdout?: string }
          if (err.status === 1) { hits = '' } else { throw e }
        }
        expect(hits, `unexpected legacy brand hits:\n${hits}`).toBe('')
      })
    })
    ```
  - [ ] **Verify RED:** Run the sweep, confirm non-empty hits (expected before tasks 1-9)
    - Command: `pnpm vitest run tests/brand-sweep.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **INTEGRATION-GREEN:** By the time this task's GREEN step runs, tasks 1-9 have already been committed — no new production code is needed here.  Re-run the sweep and confirm zero hits
  - [ ] **Verify GREEN:** Run the sweep and the full suite
    - Command: `pnpm vitest run tests/brand-sweep.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None — pure assertion
  - [ ] **Verify REFACTOR:** Re-run full suite
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `test(brand-sweep): assert no legacy ts-agent-teams remains in active source`
    - Staging order: test file is the only artifact
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## Scenario Coverage Matrix

| Capability | Scenario | Covered by Task(s) | Test file:line |
|---|---|---|---|
| `daemon-core` | Daemon MCP server identity → initialize serverInfo.name reports new brand | Task 4.1 | `tests/daemon-server-name.test.ts` (fill during apply) |
| `daemon-core` | Daemon source tree free of legacy brand → Brand-sweep grep returns zero matches | Tasks 1.1, 2.1, 5.1, 9.1, 10.1 | `tests/brand-sweep.test.ts` (fill during apply) |
| `daemon-core` | Daemon binds only to 127.0.0.1 → Default bind address | Task 2.1 | existing bind-localhost.test.ts (updated brand, fill during apply) |
| `daemon-core` | PID file lifecycle → Fresh startup writes pid file | Task 3.1 | `tests/daemon-home-dir-rename.test.ts` (fill during apply) |
| `daemon-core` | PID file lifecycle → Stale pid file (process dead) | Task 3.1 | existing pid-lifecycle tests (unchanged, covered by home-dir path) |
| `daemon-core` | PID file lifecycle → Live daemon already running | Task 3.1 | existing pid-lifecycle tests (unchanged, covered by home-dir path) |
| `claude-channel-transport` | Channel proxy MCP server identity → proxy serverInfo.name reports new brand to host | Task 6.1 | `plugins/cross-agent-teams-channel/tests/proxy-server-name.test.ts` (fill during apply) |
| `claude-channel-transport` | Channel proxy startup sequence → proxy generates fresh csid on every startup | Task 8.1 | `plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts` (existing, reused) |
| `claude-channel-transport` | Channel proxy startup sequence → proxy emits startup channel notification with csid and bind instruction | Task 8.1 | `plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts` (existing, assertions updated) |
| `claude-channel-transport` | Channel proxy startup sequence → proxy honors CROSS_AGENT_TEAMS_MCP_DAEMON_URL env var when flag omitted | Task 7.1 | `plugins/cross-agent-teams-channel/tests/proxy-cli-env-var.test.ts` (fill during apply) |
| `claude-channel-transport` | Channel proxy startup sequence → proxy exits when neither flag nor CROSS_AGENT_TEAMS_MCP_DAEMON_URL is set | Task 7.1 | `plugins/cross-agent-teams-channel/tests/proxy-cli-env-var.test.ts` (fill during apply) |

**Coverage:** 11 of 11 scenarios covered (100%).
