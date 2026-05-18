## MODIFIED Requirements

### Requirement: Graceful shutdown

The daemon SHALL handle `SIGTERM` and `SIGINT` by (a) stopping accept of new connections, (b) draining in-flight requests up to a configurable deadline (default `5000 ms`, overridable via the `XATS_SHUTDOWN_GRACE_MS` environment variable), (c) when the deadline expires, force-closing any remaining open sockets via the underlying HTTP server, (d) flushing the SQLite WAL checkpoint, (e) removing the pid file, and (f) exiting `0`. A second `SIGTERM` or `SIGINT` received before the first handler completes MUST skip the deadline, still remove the pid file, and exit `0` immediately.

#### Scenario: SIGTERM with no long-lived clients

- **GIVEN** a running daemon with no SSE / long-lived clients attached
- **WHEN** SIGTERM is sent
- **THEN** the daemon stops accepting new connections within 1 second
- **AND** the pid file is removed
- **AND** the daemon exits `0` well before the shutdown deadline

#### Scenario: SIGTERM with long-lived client still attached

- **GIVEN** a running daemon with at least one long-lived SSE / channel-proxy client holding an ESTABLISHED connection
- **WHEN** SIGTERM is sent
- **AND** the client does not voluntarily close its connection
- **THEN** the daemon stops accepting new connections immediately
- **AND** within `XATS_SHUTDOWN_GRACE_MS + 500 ms` of the signal, the daemon force-closes the remaining socket, removes the pid file, and exits `0`

#### Scenario: Second signal triggers fast exit

- **GIVEN** a running daemon that has already received SIGTERM and is mid-drain
- **WHEN** a second SIGTERM or SIGINT is sent
- **THEN** the daemon skips the remaining drain window
- **AND** removes the pid file
- **AND** exits `0` within 200 ms of the second signal

#### Scenario: XATS_SHUTDOWN_GRACE_MS=0 skips drain

- **GIVEN** a running daemon launched with `XATS_SHUTDOWN_GRACE_MS=0` in the environment
- **WHEN** SIGTERM is sent
- **THEN** the daemon force-closes any remaining sockets immediately without waiting
- **AND** removes the pid file
- **AND** exits `0`
