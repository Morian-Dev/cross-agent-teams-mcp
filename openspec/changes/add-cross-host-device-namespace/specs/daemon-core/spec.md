## MODIFIED Requirements

### Requirement: Daemon binds only to 127.0.0.1 by default and gates non-loopback binds on a bearer token

The daemon SHALL bind its HTTP listener to `127.0.0.1` by default. A `--host <addr>` flag SHALL allow binding to a different address (e.g. a LAN IP or `0.0.0.0`).

When the resolved bind address is not a loopback address, the daemon MUST require a non-empty `--token <t>` value (or the equivalent `CROSS_AGENT_TEAMS_MCP_TOKEN` environment variable). Without it, the daemon MUST refuse to start, write `token_required_for_non_loopback_bind` to stderr, and exit with a non-zero status. Loopback addresses are: any IPv4 address in `127.0.0.0/8`, the IPv6 address `::1`, and `::ffff:127.0.0.0/8`.

The legacy guarantee that loopback-only deployments need no token is preserved: when `--host` is omitted or resolves to a loopback address, `--token` remains optional.

#### Scenario: Default bind address still loopback

- **WHEN** the daemon is started with `npx cross-agent-teams-mcp daemon` without any host override
- **THEN** the HTTP server listens on `127.0.0.1:9100`
- **AND** the daemon starts even when `--token` is omitted

#### Scenario: Explicit loopback host with no token is accepted

- **WHEN** the daemon is started with `--host 127.0.0.1`
- **THEN** the daemon binds to `127.0.0.1:9100` and starts even when `--token` is omitted

#### Scenario: Non-loopback host without token refuses to start

- **WHEN** the daemon is started with `--host 0.0.0.0` and no `--token`
- **THEN** the daemon exits with a non-zero status
- **AND** stderr contains `token_required_for_non_loopback_bind`
- **AND** no port is bound

#### Scenario: Non-loopback host with token starts and binds the requested address

- **WHEN** the daemon is started with `--host 192.168.1.10 --token T`
- **THEN** the HTTP server listens on `192.168.1.10:9100`
- **AND** the startup log includes the bound host and port

#### Scenario: Token via env variable satisfies the non-loopback guard

- **GIVEN** the environment has `CROSS_AGENT_TEAMS_MCP_TOKEN=T`
- **WHEN** the daemon is started with `--host 0.0.0.0` and no `--token` flag
- **THEN** the daemon starts and binds the requested address
- **AND** stderr does NOT contain `token_required_for_non_loopback_bind`

## ADDED Requirements

### Requirement: Daemon accepts a device label via --device

The daemon SHALL accept an optional `--device <label>` flag that sets the local device label used to namespace this host's agents in the `agents` table.

When `--device` is omitted, the daemon SHALL derive the default value from `os.hostname()` by lowercasing and replacing any character outside `[a-z0-9_-]` with `-`. The result MUST be non-empty after derivation; if `os.hostname()` is empty or fully replaced, the daemon SHALL fall back to the literal `local`.

The resolved label MUST be non-empty, MUST NOT contain `:`, and MUST be 64 characters or fewer. If `--device` is supplied with a value violating these rules, the daemon SHALL refuse to start with stderr `invalid_device_label` and a non-zero exit status.

The resolved label is the authoritative local device identifier consumed by `agent-registry` (for `register_agent` device validation and for the startup migration's backfill).

#### Scenario: Default device label derived from hostname

- **GIVEN** `os.hostname()` returns `JT-Laptop.local`
- **WHEN** the daemon is started without `--device`
- **THEN** the resolved local device label is `jt-laptop.local`
- **AND** the startup log includes the resolved label

#### Scenario: Hostname containing disallowed characters is normalised

- **GIVEN** `os.hostname()` returns `JT@Laptop`
- **WHEN** the daemon is started without `--device`
- **THEN** the resolved local device label is `jt-laptop` (the `@` is replaced with `-`)

#### Scenario: --device flag overrides the derived default

- **WHEN** the daemon is started with `--device gx`
- **THEN** the resolved local device label is `gx`

#### Scenario: --device with colon is rejected

- **WHEN** the daemon is started with `--device has:colon`
- **THEN** the daemon exits with a non-zero status
- **AND** stderr contains `invalid_device_label`

#### Scenario: --device exceeding 64 characters is rejected

- **WHEN** the daemon is started with `--device <65-char string>`
- **THEN** the daemon exits with a non-zero status
- **AND** stderr contains `invalid_device_label`

#### Scenario: Empty hostname falls back to literal "local"

- **GIVEN** `os.hostname()` returns an empty string
- **WHEN** the daemon is started without `--device`
- **THEN** the resolved local device label is `local`
