## ADDED Requirements

### Requirement: Daemon MCP server identity

The daemon's `McpServer` instance SHALL declare its `name` field as `cross-agent-teams-mcp` during MCP initialize handshake.  This is the logical server identity reported to every connecting client and MUST NOT include legacy brand words.

#### Scenario: initialize serverInfo.name reports new brand

- **GIVEN** the daemon is running on a random port
- **WHEN** an MCP client completes the initialize handshake
- **THEN** the `serverInfo.name` field equals `cross-agent-teams-mcp`

### Requirement: Daemon source tree free of legacy brand word

The daemon's shipped source tree (non-archived, non-historical: `src/**`, `package.json`, `tsconfig.json`, active `docs/configs/**`, active `openspec/specs/**`, `opencode.json`, `.gitignore`) SHALL NOT contain the literal string `ts-agent-teams` (case-sensitive).  This ensures the rename is complete and future readers never re-encounter the legacy brand.

Exempt paths: `openspec/changes/archive/**`, `discuss/**`, `node_modules/**`, `dist/**`, `pnpm-lock.yaml`, `worktrees/**`.

#### Scenario: Brand-sweep grep returns zero matches

- **WHEN** `grep -r 'ts-agent-teams' src/ plugins/cross-agent-teams-channel/src/ docs/configs/ openspec/specs/ package.json tsconfig.json opencode.json .gitignore` is run
- **THEN** the exit code is non-zero (ripgrep/grep convention for no matches) or output is empty

## MODIFIED Requirements

### Requirement: Daemon binds only to 127.0.0.1

The daemon SHALL bind its HTTP listener only to `127.0.0.1`. It MUST refuse any configuration that exposes the port on `0.0.0.0` or external interfaces.

#### Scenario: Default bind address

- **WHEN** the daemon is started with `npx cross-agent-teams-mcp daemon` without any host override
- **THEN** the HTTP server listens on `127.0.0.1:9100`
- **AND** a request from a non-loopback address (e.g. `192.168.x.x`) fails to connect

### Requirement: PID file lifecycle

The daemon SHALL write its process id to `~/.cross-agent-teams-mcp/daemon.pid` on startup (including the chosen port) and remove the file on graceful shutdown. If the file exists at startup and the referenced process is alive, the daemon MUST exit with error unless `--force` is passed.

#### Scenario: Fresh startup writes pid file

- **WHEN** daemon starts and no `daemon.pid` exists
- **THEN** after startup the file contains the current pid and port

#### Scenario: Stale pid file (process dead)

- **GIVEN** `daemon.pid` exists but the recorded pid is not alive
- **WHEN** daemon starts
- **THEN** it overwrites the stale file and starts normally

#### Scenario: Live daemon already running

- **GIVEN** `daemon.pid` exists and the recorded pid is alive
- **WHEN** daemon starts without `--force`
- **THEN** it exits with status `1` and stderr contains `daemon already running`
