## Why

The project is being renamed from `ts-agent-teams` to `cross-agent-teams-mcp` to better reflect its purpose (a cross-agent collaboration MCP daemon, not a TypeScript-specific utility).  Doing this now, before first public release, avoids a legacy-migration burden later.  All project-internal identifiers — package names, MCP server name, env vars, home directory, config keys, spec text — must move together so the project does not ship with mixed branding.

## What Changes

- **BREAKING** Rename main npm package `ts-agent-teams` → `cross-agent-teams-mcp` (package.json `name` + `bin` key).
- **BREAKING** Rename channel plugin package `ts-agent-teams-channel` → `cross-agent-teams-channel` (package.json `name` + plugin.json `name` + physical directory `plugins/ts-agent-teams-channel/` → `plugins/cross-agent-teams-channel/`).  The bin entry is renamed independently to `cross-agent-teams-proxy` (user-facing CLI name — package name and bin name are intentionally decoupled here since "channel" is an implementation detail users don't need to see).
- **BREAKING** Rename env vars `TS_AGENT_TEAMS_HOME` → `CROSS_AGENT_TEAMS_MCP_HOME` and `TS_AGENT_TEAMS_DAEMON_URL` → `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`.  No compatibility shim — fresh-boot assumption per project MVP rule.
- **BREAKING** Rename daemon home directory `~/.ts-agent-teams/` → `~/.cross-agent-teams-mcp/`.  No migration shim.
- **BREAKING** Rename the MCP server declared `name` field from `ts-agent-teams` → `cross-agent-teams-mcp` (used in `McpServer({name})` registration for both daemon and channel proxy; affects the logical server identity reported to MCP clients).
- Rename test artifact directory in `.gitignore`: `.ts-agent-teams-test/` → `.cross-agent-teams-mcp-test/`.
- Update all user-visible strings, error messages, and startup hints that embed the brand word `ts-agent-teams`.
- Update documented MCP client config key in `opencode.json` and `docs/configs/*.md` from `ts-agent-teams` → `cross-agent-teams-mcp`.
- Update all active spec text referencing the brand (npx command examples, pid-file path, env var names, proxy identity).
- Update test file imports that reference the old plugin directory path, and test assertions that check for the old brand word.

**Explicitly out of scope (frozen / user-handled):**
- `openspec/changes/archive/**` — archived changes remain as history.
- `discuss/design-agent-teams-mcp-20260414.md` — historical design doc.
- Workspace parent directory name — user handles externally.
- Already-installed user MCP registrations (`claude mcp add ts-agent-teams …`) — user re-adds externally.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `daemon-core`: pid-file path and startup command in the binary-identity requirement change from `~/.ts-agent-teams/daemon.pid` + `npx ts-agent-teams daemon` to the new brand.
- `claude-channel-transport`: the proxy CLI argument/env-var contract changes from `TS_AGENT_TEAMS_DAEMON_URL` to `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`.

## Impact

- **Code (daemon)**: `package.json`, `src/cli.ts`, `src/mcp/transport.ts`, `src/mcp/tools.ts` (three user-visible text sites).
- **Code (channel plugin)**: whole `plugins/ts-agent-teams-channel/` tree — `package.json`, `plugin.json`, `src/cli.ts`, `src/proxy.ts`, `src/daemon-client.ts`, `README.md`, `tests/*.ts`, directory renamed to `plugins/cross-agent-teams-channel/`.
- **Config / build**: `tsconfig.json` (include path), `pnpm-workspace.yaml` (still matches via `plugins/*`), `opencode.json`, `.gitignore`.
- **Docs (active)**: `docs/configs/README.md`, `docs/configs/claude-code.md`, `docs/configs/codex-cli.md`, `docs/configs/opencode.md`.
- **Specs (active)**: `openspec/specs/daemon-core/spec.md`, `openspec/specs/claude-channel-transport/spec.md`.
- **Tests (top-level + plugin)**: `tests/proxy-reconnect.test.ts`, `tests/proxy-registration-sequence.test.ts`, `tests/e2e-channel-poke.test.ts`, `plugins/.../tests/proxy-cli.test.ts`, `plugins/.../tests/proxy-startup-notification.test.ts`.
- **Runtime** (BREAKING): any developer running an old daemon against new code will see `pid file not found` / `env var not set`; they must migrate the home directory and re-export env vars.  Project is pre-release, so no external user impact.
- **No behavior change** other than rename: MCP tool shapes, wire protocol, DB schema, tool semantics are untouched.
