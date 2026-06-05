# channel-cli-bin Specification

## Purpose

Define the published `cross-agent-teams-channel` bin contract: the npm package ships the channel proxy CLI as a second executable alongside the daemon, invokable via `npx` without a local clone, with strict separation between proxy and daemon lifecycles.

## Requirements

### Requirement: cross-agent-teams-mcp package exposes a cross-agent-teams-channel bin

The `cross-agent-teams-mcp` npm package SHALL declare a second bin entry named `cross-agent-teams-channel` that points at the channel proxy CLI built into `dist/`.  After installation, both `cross-agent-teams-mcp` (daemon) and `cross-agent-teams-channel` (proxy) MUST be available as executables on the user's PATH (or as `npx` invocations).

#### Scenario: package.json bin map after build

- **GIVEN** a clean clone of the repository
- **WHEN** `pnpm install` and `pnpm build` complete
- **THEN** `package.json#bin` is an object containing both keys `cross-agent-teams-mcp` and `cross-agent-teams-channel`, each pointing at an executable file inside `dist/` that begins with the `#!/usr/bin/env node` shebang

#### Scenario: tarball ships both bins

- **WHEN** `npm pack --dry-run --json` runs from the repository root
- **THEN** the reported file list contains both `dist/cli.js` and `dist/channel-cli.js`
- **AND** neither file contains a stale reference to a removed module

### Requirement: Channel proxy CLI is invokable via npx without a local clone

A user with no checkout SHALL be able to start the channel proxy by running `npx -y -p cross-agent-teams-mcp@<version> cross-agent-teams-channel --daemon-url <url>`.  The `-p` (`--package`) flag is required because `cross-agent-teams-channel` is a non-default bin in the `cross-agent-teams-mcp` package; without it, npx invokes the package's same-named default bin (the daemon) and treats `cross-agent-teams-channel` as a positional argument.  The published CLI MUST accept `--daemon-url <url>` and `CROSS_AGENT_TEAMS_MCP_DAEMON_URL` as the daemon address inputs, matching the existing `plugins/cross-agent-teams-channel` CLI surface.

The CLI SHALL additionally accept:

- `--token <t>` and `CROSS_AGENT_TEAMS_MCP_TOKEN` (env var) as the bearer-token input. When supplied, the CLI MUST send `Authorization: Bearer <token>` on every Streamable HTTP request to the daemon. When omitted, no `Authorization` header is sent (preserving zero-config loopback behavior). Flag value SHALL take precedence over env value.
- `--device <label>` as the device-label input. When omitted, the CLI SHALL derive a default by lowercasing `os.hostname()` and replacing any character outside `[a-z0-9_-]` with `-`, falling back to the literal `local` when the derived value is empty. The resolved label MUST be non-empty, MUST NOT contain `:`, and MUST be 64 characters or fewer; an invalid value provided via `--device` SHALL cause the CLI to exit with a non-zero status and stderr `invalid_device_label`. The resolved label SHALL be forwarded as `device` on the proxy's `register_agent` upsert.

#### Scenario: --daemon-url flag is honoured by the published bin

- **GIVEN** the package has been published and a daemon is reachable at `http://127.0.0.1:9100/mcp`
- **WHEN** a fresh shell runs `npx -y -p cross-agent-teams-mcp@latest cross-agent-teams-channel --daemon-url http://127.0.0.1:9100/mcp` and an MCP client speaks `initialize` over its stdio
- **THEN** the CLI completes the handshake and reports the channel proxy is ready, without any other configuration

#### Scenario: env var fallback when --daemon-url omitted

- **GIVEN** `CROSS_AGENT_TEAMS_MCP_DAEMON_URL=http://127.0.0.1:9100/mcp` is set in the environment
- **WHEN** the published CLI is invoked with no `--daemon-url` flag
- **THEN** the CLI uses the environment variable as the daemon URL and proceeds with normal startup

#### Scenario: --token flag adds Authorization header to daemon requests

- **GIVEN** a daemon reachable at `http://10.0.0.10:9100/mcp` configured with `--token T`
- **WHEN** the CLI is invoked with `--daemon-url http://10.0.0.10:9100/mcp --token T`
- **THEN** every HTTP request the CLI sends to the daemon carries `Authorization: Bearer T`
- **AND** the registration sequence completes successfully

#### Scenario: --token absent against a token-protected daemon fails

- **GIVEN** a daemon reachable at `http://10.0.0.10:9100/mcp` configured with `--token T`
- **WHEN** the CLI is invoked with `--daemon-url http://10.0.0.10:9100/mcp` (no `--token`, no `CROSS_AGENT_TEAMS_MCP_TOKEN`)
- **THEN** the daemon responds with HTTP 401 to the initialize request
- **AND** the CLI exits non-zero within its bounded retry budget

#### Scenario: CROSS_AGENT_TEAMS_MCP_TOKEN env var supplies the token

- **GIVEN** the environment has `CROSS_AGENT_TEAMS_MCP_TOKEN=T`
- **AND** a daemon configured with `--token T`
- **WHEN** the CLI is invoked with `--daemon-url ...` and no `--token` flag
- **THEN** the CLI uses the env token and the registration sequence completes successfully

#### Scenario: --device flag is forwarded on register_agent

- **GIVEN** a daemon at `http://10.0.0.10:9100/mcp` with `--device host-a --token T`
- **WHEN** the CLI is invoked with `--daemon-url http://10.0.0.10:9100/mcp --token T --device host-b`
- **THEN** the proxy's `register_agent` call carries `device:'host-b'`
- **AND** the daemon accepts the registration (remote origin + non-local label)
- **AND** the resulting `__channel_proxy__` row has `device='host-b'`

#### Scenario: --device defaults to hostname-derived label

- **GIVEN** `os.hostname()` returns `GX-Desktop`
- **WHEN** the CLI is invoked with `--daemon-url ...` and no `--device` flag
- **THEN** the proxy's `register_agent` call carries `device:'host-b-desktop'`

#### Scenario: --device with colon is rejected

- **WHEN** the CLI is invoked with `--device has:colon`
- **THEN** the CLI exits non-zero
- **AND** stderr contains `invalid_device_label`

### Requirement: Channel proxy CLI must not auto-spawn a daemon

The published `cross-agent-teams-channel` bin MUST NOT start, fork, or otherwise bring up a daemon process on its own.  When the configured daemon URL is unreachable, it MUST fail fast with a structured error and exit non-zero — the daemon lifecycle is the operator's responsibility, not the proxy's.

This boundary is intentional: the abandoned 0.2.x line collapsed daemon and proxy into a single auto-bootstrapping process and never stabilised.  Re-introducing auto-spawn under any heuristic (port probe, stale pid file, "convenience" flag) is out of scope for this capability.

#### Scenario: daemon unreachable on startup

- **GIVEN** no process is listening on `127.0.0.1:9100`
- **WHEN** `cross-agent-teams-channel --daemon-url http://127.0.0.1:9100/mcp` is run with an MCP client attached to its stdio
- **THEN** the CLI exits non-zero within a bounded retry budget without forking, spawning, or invoking any daemon entry point
- **AND** the error surface includes the unreachable URL so the operator can diagnose

#### Scenario: source contains no daemon-spawning primitives

- **WHEN** the channel proxy source tree (the entry compiled into `dist/channel-cli.js` and its imports) is searched for the long-lived child-process primitives `spawn(`, `fork(`, `spawnSync(`, `forkSync(`, or for any import of the daemon's `startServer` / port-acquire helpers
- **THEN** no such reference exists.  Synchronous system queries via `execFileSync` (e.g. invoking `ps` to walk ancestor pids) are permitted because they cannot host a daemon's lifecycle.

### Requirement: Build pipeline emits both bins from a single tsup invocation

The repository's `tsup.config.ts` SHALL declare both the daemon entry (`src/cli.ts`) and the channel proxy entry (`plugins/cross-agent-teams-channel/src/cli.ts`) in a single `entry` array, producing `dist/cli.js` and `dist/channel-cli.js` from one `pnpm build`.  The build MUST NOT require a separate step inside `plugins/cross-agent-teams-channel/`, and the published tarball MUST NOT depend on artefacts produced by the plugin's own `tsconfig.build.json`.

#### Scenario: single build produces both artefacts

- **GIVEN** a clean tree (`dist/` removed)
- **WHEN** `pnpm build` runs once at the repo root
- **THEN** `dist/cli.js` AND `dist/channel-cli.js` both exist and are executable
- **AND** no compilation step ran inside `plugins/cross-agent-teams-channel/`

#### Scenario: stale per-plugin dist is not consulted at publish time

- **GIVEN** `plugins/cross-agent-teams-channel/dist/cli.js` exists on disk from a prior local dev session
- **WHEN** `npm pack --dry-run --json` is invoked
- **THEN** the reported file list does NOT include `plugins/cross-agent-teams-channel/dist/...`
- **AND** the channel proxy bin in the tarball is the freshly-built `dist/channel-cli.js`
