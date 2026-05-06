## ADDED Requirements

### Requirement: Channel proxy heartbeat polls daemon at coarse interval

The channel proxy's `waitForDisconnect` health-check loop SHALL poll the daemon by calling the `echo` MCP tool at a coarse default interval. The default interval value SHALL be `30_000` ms. The interval MAY be overridden through the proxy's `ReconnectingProxyConfig.healthCheckIntervalMs` for testing, but no public CLI flag exposes it.

The proxy's primary disconnect signal MUST remain the SDK transport's `onclose` event (fast TCP-level break). The echo poll exists ONLY as a coarse-grained backstop for the case where the TCP socket is alive but the daemon's event loop is wedged. As a backstop, sub-second polling is unnecessary and harmful: it inflates daemon-side per-call allocation pressure under steady-state idle (each `tools/call` round-trip exercises the SDK request path once).

When `waitForDisconnect`'s `echo` call rejects (the daemon's transport is gone or unreachable), the proxy MUST treat that as a disconnect signal and proceed to reconnect via the existing `loop()` retry path described in "Channel proxy reconnects on daemon disconnect".

#### Scenario: Default heartbeat interval is 30 seconds

- **GIVEN** a `ReconnectingProxyConfig` is constructed without `healthCheckIntervalMs`
- **WHEN** the proxy enters `waitForDisconnect`
- **THEN** consecutive `echo` calls are spaced ≥ 29 seconds AND ≤ 31 seconds apart (allowing for normal scheduler jitter)

#### Scenario: Test override of heartbeat interval

- **GIVEN** a `ReconnectingProxyConfig` is constructed with `healthCheckIntervalMs: 100`
- **WHEN** the proxy enters `waitForDisconnect`
- **THEN** the proxy honours the override and polls `echo` at the supplied interval

#### Scenario: Echo failure during heartbeat triggers reconnect

- **GIVEN** the proxy is healthy and has completed `waitForDisconnect`'s first `echo` poll
- **WHEN** the next `echo` call rejects (daemon shut down or connection broken)
- **THEN** `waitForDisconnect` returns
- **AND** `loop()` proceeds to invoke `runRegistrationSequence` for the next reconnect attempt
