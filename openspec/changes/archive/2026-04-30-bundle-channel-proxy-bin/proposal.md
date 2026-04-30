## Why

`cross-agent-teams-mcp@0.3.0` ships only the daemon to npm.  The channel proxy that lets Claude Code receive `notifications/channel_wake` lives in `plugins/cross-agent-teams-channel/` and is not published, so users who install via `npx` get the daemon's MCP tools but cannot receive channel wake-ups — a Claude Code session has no way to subscribe to the daemon's wake fan-out without the proxy in between.  Bundling the proxy as a second bin in the same npm package gives those users a complete experience without forcing them to clone the repo.

## What Changes

- Build `plugins/cross-agent-teams-channel/src/cli.ts` as a second tsup entry alongside the existing daemon entry, producing `dist/channel-cli.js` in the main package.
- Add `cross-agent-teams-channel` to the main package `bin` map pointing at `./dist/channel-cli.js`, alongside the existing `cross-agent-teams-mcp` daemon bin.
- Lift the channel proxy's runtime dependencies (`@modelcontextprotocol/sdk` is already shared) into the main package; nothing new is needed since the proxy has no extra deps.
- Document a hard rule that `cross-agent-teams-channel` MUST NOT auto-spawn a daemon — failing fast on connection error is the only acceptable behaviour.  This is the explicit boundary that separates this change from the abandoned 0.2.x stdio integration.
- Update `README.md` / `README.zh-CN.md` to show the three-step user flow: `npx cross-agent-teams-mcp daemon` → `.mcp.json` with `npx cross-agent-teams-channel --daemon-url ...` → `claude --dangerously-load-development-channels server:<name>`.
- Bump main package to `0.3.1` for the release that introduces the second bin.

## Capabilities

### New Capabilities
- `channel-cli-bin`: Distribution of the channel proxy as a second bin command on the `cross-agent-teams-mcp` npm package, including the no-auto-bootstrap boundary and the supported user invocation surface (`npx cross-agent-teams-channel --daemon-url <url>`).

### Modified Capabilities
<!-- None.  claude-channel-transport already describes the proxy's runtime behaviour (capability declaration, fan-out, csid binding); only the packaging layer changes here, which lives entirely in the new channel-cli-bin spec. -->

## Impact

- `package.json`: `bin` gains a second entry; `files` already includes `dist`; version bumps to `0.3.1`.
- `tsup.config.ts`: `entry` becomes a two-element array.
- `plugins/cross-agent-teams-channel/`: source remains in place but is now compiled by the main package's tsup pipeline.  Its standalone `package.json` / `tsconfig.build.json` remain for local dev/test isolation but are no longer part of any publish path.
- `README.md` / `README.zh-CN.md`: replace the 0.3.0 daemon-only quick-start with the two-bin flow.
- `.github/workflows/publish.yml`: unchanged — single package, single `npm publish`.
- npm tarball size: grows by ~30-50 KB (channel proxy is a small stdio shim with no native deps).
- No daemon, storage, or transport-layer code is touched.
