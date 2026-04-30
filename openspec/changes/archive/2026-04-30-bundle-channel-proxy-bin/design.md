## Context

The 0.3.0 release published only the daemon to npm.  The channel proxy that lets Claude Code receive `notifications/channel_wake` lives in `plugins/cross-agent-teams-channel/` and is not on the registry, so any `npx`-based user can call MCP tools but cannot receive wakes — Claude Code has no way to subscribe to the daemon's wake fan-out without the proxy mediating over stdio.

The 0.2.x line that previously bundled the proxy into the same npm name failed because it merged daemon and proxy into one auto-bootstrapping process: starting the proxy would probe for a daemon and fork one if missing.  That auto-spawn path collapsed under port races, orphaned children, and unclear ownership of the daemon's lifecycle.

This change re-bundles the proxy into the same npm package, but as a **separate, distinct bin** with no shared process and no auto-bootstrap.  Two bins, two processes, one package.

## Goals / Non-Goals

**Goals:**
- A user who runs `npx -y cross-agent-teams-mcp@latest cross-agent-teams-channel --daemon-url <url>` gets a working channel proxy without cloning the repo.
- A single `pnpm build` at the repo root produces both `dist/cli.js` (daemon) and `dist/channel-cli.js` (proxy).
- The published tarball includes both bins; consumers see both commands on PATH.
- The proxy fails fast when the daemon is unreachable.

**Non-Goals:**
- Splitting the proxy into a separate npm package (that is the B2 alternative; rejected for first iteration).
- Reviving any auto-bootstrap behaviour from 0.2.x.
- Changing daemon behaviour, MCP wire formats, fan-out semantics, or `claude/channel` capability negotiation — `claude-channel-transport` spec stands as-is.
- Renaming the proxy CLI (`cross-agent-teams-channel` is the name 0.2.x used; reusing it preserves operator muscle memory and `.mcp.json` examples on the web).

## Decisions

### Decision 1: Single npm package with two tsup entries

`tsup.config.ts` will use an `entry` array of two paths:

```ts
entry: ['src/cli.ts', 'plugins/cross-agent-teams-channel/src/cli.ts']
```

tsup writes `dist/cli.js` and `dist/channel-cli.js` from this configuration (it derives output basenames from each input).

**Why this over a workspace / monorepo split (B2):** B2 yields a smaller proxy install (no `better-sqlite3` native dep transitively), but at the cost of a second npm name, a second trusted-publisher registration, and version-coordination overhead.  For the first cut, the per-install delta is acceptable because the proxy itself ships zero new transitive dependencies — `@modelcontextprotocol/sdk` is already in the daemon's `dependencies`, and `better-sqlite3` is required by daemon code paths only, not at proxy import time.  npm's prebuilt-binary path keeps the cold-install penalty in the ~10s range on supported platforms.

**Why not a single bin that switches modes by argv:** that is exactly the 0.2.x shape we are abandoning.  Two distinct bins, no mode-switch, no shared process state.

### Decision 2: Hard rule — proxy MUST NOT spawn the daemon

Codified as a normative requirement (`Channel proxy CLI must not auto-spawn a daemon`) with two scenarios: an integration scenario for "daemon unreachable" behaviour, and a static-analysis scenario for "no spawn primitives in source."  The latter gives us a cheap repo-wide grep test that a future contributor cannot silently re-add an auto-bootstrap path without flipping the spec.

When the daemon is unreachable, the proxy fails fast.  Errors carry the configured daemon URL so the operator can diagnose without enabling debug logging.

### Decision 3: Plugin source tree stays in `plugins/cross-agent-teams-channel/`

The proxy's source files remain under `plugins/cross-agent-teams-channel/src/` and are referenced from the root `tsup.config.ts`.  We keep the plugin's standalone `package.json`, `tsconfig.build.json`, and `tests/` so contributors can still iterate on the proxy in isolation (`pnpm -C plugins/cross-agent-teams-channel test` still works).

What changes:
- The plugin's own `dist/` is no longer consumed by anything published.  We do not delete it from `.gitignore`'d local dev workflows, but we ensure it never ends up in the npm tarball (it already lives outside the `files` whitelist's `dist` entry — that whitelist refers to root-level `dist`, not plugin-local).

### Decision 4: README rewrites the user flow

The 0.3.0 README told users to set `.mcp.json` to `type: "http"` pointing directly at the daemon.  That works only for MCP tool calls — channel wake never lands in Claude Code.  The new flow:

```jsonc
{
  "mcpServers": {
    "cross-agent-teams-channel": {
      "command": "npx",
      "args": ["-y", "cross-agent-teams-mcp@latest", "cross-agent-teams-channel",
               "--daemon-url", "http://127.0.0.1:9100/mcp"]
    }
  }
}
```

paired with `claude --dangerously-load-development-channels server:cross-agent-teams-channel`.  The MCP server name in `.mcp.json` (`cross-agent-teams-channel`) MUST match the `server:<name>` suffix on the CLI flag — that is how Claude Code's experimental loader wires the proxy in.

We document this constraint explicitly in the README to short-circuit a class of misconfigurations.

## Risks / Trade-offs

- **Risk:** Bundling pulls `better-sqlite3` into the proxy install graph, even though the proxy itself never imports it. → **Mitigation:** prebuilt binaries cover the common platforms; the cold-install hit is a one-time ~10s on first `npx` and amortised by the npx cache.  We accept this trade for the simpler distribution story.
- **Risk:** Two bins on the same package can confuse users into running `npx cross-agent-teams-mcp` (without `daemon` arg) when they meant the proxy, or vice versa. → **Mitigation:** the daemon CLI already prints a usage message on missing subcommand; the proxy CLI prints a clear startup banner.  README puts the canonical commands side-by-side.
- **Risk:** Users who already have `cross-agent-teams-mcp@0.3.0` installed via npx-cache will not pick up `0.3.1` until they re-resolve `@latest`. → **Mitigation:** `npx -y cross-agent-teams-mcp@latest` re-resolves on each invocation; the README and deprecate message both pin `@latest`.
- **Trade-off:** We are reusing the bin name `cross-agent-teams-channel` that 0.2.x used.  Users who installed a 0.2.x cache and have `cross-agent-teams-channel` resolved against that cache will see stale behaviour until npx re-resolves. → **Mitigation:** the 0.2.x range is already deprecated with an upgrade message pointing at `@latest`; npx's resolution against `@latest` will pull 0.3.1.

## Migration Plan

1. Apply the change locally; verify `pnpm build` produces both bins, both have shebangs, both are executable.
2. Verify `npm pack --dry-run` lists both `dist/cli.js` and `dist/channel-cli.js` and excludes `plugins/.../dist/`.
3. Bump `package.json` version to `0.3.1`, commit on a publish branch off `main`.
4. Force-push that branch tip to `origin/release` to trigger the GitHub Actions trusted-publisher workflow.
5. After publish, smoke-test from a clean shell: `npx -y cross-agent-teams-mcp@latest cross-agent-teams-channel --help` returns the proxy's help (not the daemon's).
6. Update README in the same release commit so the published tarball ships the corrected user flow.

**Rollback:** if `0.3.1` ships broken, the procedure mirrors the 0.2.x → 0.3.0 rollback: deprecate `0.3.1` with a message, force-push `release` back to the `0.3.0` commit, the registry retains both versions but `@latest` resolves to `0.3.0` via `npm dist-tag add cross-agent-teams-mcp@0.3.0 latest`.

## Open Questions

- None blocking.  The proxy CLI surface (`--daemon-url`, env-var fallback) is already implemented in `plugins/cross-agent-teams-channel/src/cli.ts`; no spec changes are required for runtime behaviour beyond what `claude-channel-transport` already specifies.
