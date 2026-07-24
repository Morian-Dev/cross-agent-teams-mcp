## ADDED Requirements

### Requirement: Session lifecycle events reach the daemon log

When the daemon runs as a process (the `daemon` CLI entry), the MCP transport's lifecycle log lines MUST reach the daemon's standard log output — the same stream that carries the startup banner and that the documented launchers append to the daemon log file. At minimum this covers:

- MCP session creation and closure (with session id and bound agent, when any)
- register_agent takeover lines (already required by the agent-registry takeover requirement)
- orphan session reaping (with session id and reason)

The daemon binary MUST NOT leave the transport's `log` sink unset: a default that silently discards these lines is the defect this requirement exists to prevent — a binding-layer incident on 2026-07-24 was only diagnosable by reading source because the log file contained nothing but startup banners.

Failure of the sink itself MUST NOT disturb request handling (the existing behaviour of falling back to `console.error` on a throwing logger is retained).

#### Scenario: Takeover is visible in the daemon log

- **GIVEN** a daemon started via the `daemon` CLI entry with its output appended to a log file
- **WHEN** a `register_agent` call takes over an identity from a live prior session
- **THEN** the log file contains the takeover line with the old and new session ids

#### Scenario: Session close is visible in the daemon log

- **GIVEN** the same daemon
- **WHEN** an MCP session closes
- **THEN** the log file contains the session-closed line naming that session id and whether an agent was bound

#### Scenario: Orphan reaping is visible in the daemon log

- **GIVEN** the same daemon and an unbound session idle past the orphan GC window
- **WHEN** the GC pass reaps it
- **THEN** the log file contains the reap line with the session id and reason
