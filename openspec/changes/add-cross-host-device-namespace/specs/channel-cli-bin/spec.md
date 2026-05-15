## MODIFIED Requirements

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

- **GIVEN** a daemon reachable at `http://192.168.1.10:9100/mcp` configured with `--token T`
- **WHEN** the CLI is invoked with `--daemon-url http://192.168.1.10:9100/mcp --token T`
- **THEN** every HTTP request the CLI sends to the daemon carries `Authorization: Bearer T`
- **AND** the registration sequence completes successfully

#### Scenario: --token absent against a token-protected daemon fails

- **GIVEN** a daemon reachable at `http://192.168.1.10:9100/mcp` configured with `--token T`
- **WHEN** the CLI is invoked with `--daemon-url http://192.168.1.10:9100/mcp` (no `--token`, no `CROSS_AGENT_TEAMS_MCP_TOKEN`)
- **THEN** the daemon responds with HTTP 401 to the initialize request
- **AND** the CLI exits non-zero within its bounded retry budget

#### Scenario: CROSS_AGENT_TEAMS_MCP_TOKEN env var supplies the token

- **GIVEN** the environment has `CROSS_AGENT_TEAMS_MCP_TOKEN=T`
- **AND** a daemon configured with `--token T`
- **WHEN** the CLI is invoked with `--daemon-url ...` and no `--token` flag
- **THEN** the CLI uses the env token and the registration sequence completes successfully

#### Scenario: --device flag is forwarded on register_agent

- **GIVEN** a daemon at `http://192.168.1.10:9100/mcp` with `--device jt-laptop --token T`
- **WHEN** the CLI is invoked with `--daemon-url http://192.168.1.10:9100/mcp --token T --device gx`
- **THEN** the proxy's `register_agent` call carries `device:'gx'`
- **AND** the daemon accepts the registration (remote origin + non-local label)
- **AND** the resulting `__channel_proxy__` row has `device='gx'`

#### Scenario: --device defaults to hostname-derived label

- **GIVEN** `os.hostname()` returns `GX-Desktop`
- **WHEN** the CLI is invoked with `--daemon-url ...` and no `--device` flag
- **THEN** the proxy's `register_agent` call carries `device:'gx-desktop'`

#### Scenario: --device with colon is rejected

- **WHEN** the CLI is invoked with `--device has:colon`
- **THEN** the CLI exits non-zero
- **AND** stderr contains `invalid_device_label`
