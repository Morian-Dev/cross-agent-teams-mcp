## 1. Build pipeline produces both bins

- [x] 1.1 Update `tsup.config.ts`: change `entry` from `['src/cli.ts']` to `['src/cli.ts', 'plugins/cross-agent-teams-channel/src/cli.ts']`.  Verify tsup writes `dist/channel-cli.js` (basename derived from input).
- [x] 1.2 Run `pnpm build` from a clean tree (`rm -rf dist`) and confirm both `dist/cli.js` and `dist/channel-cli.js` exist, are executable, and start with `#!/usr/bin/env node`.
- [x] 1.3 Confirm `dist/channel-cli.js` has no broken imports — run `node dist/channel-cli.js --help` (or equivalent flag) and verify it does not fail with a `MODULE_NOT_FOUND` error.

## 2. Package metadata

- [x] 2.1 Update root `package.json#bin`: add `"cross-agent-teams-channel": "./dist/channel-cli.js"` alongside the existing `cross-agent-teams-mcp` entry.
- [x] 2.2 Bump root `package.json#version` from `0.3.0` to `0.3.1`.
- [x] 2.3 Run `npm pack --dry-run --json` and confirm: (a) `dist/cli.js` and `dist/channel-cli.js` both appear in the file list; (b) no path under `plugins/cross-agent-teams-channel/dist/` is included; (c) tarball size is within ~30-50 KB of the 0.3.0 baseline.

## 3. Static-analysis guard against auto-spawn

- [x] 3.1 Run `grep -rnE "child_process|spawn|fork|execFile" plugins/cross-agent-teams-channel/src` from the repo root and confirm zero matches.
- [x] 3.2 Add a vitest unit test (e.g., `tests/channel-cli-no-spawn.test.ts`) that statically asserts the proxy source tree contains none of those primitives — failing the test if any future contributor reintroduces them.  The test reads source files via `fs.readFileSync`, scans with a regex, and fails with the offending file path.

## 4. Runtime smoke

- [x] 4.1 Add a vitest test that spawns `node dist/channel-cli.js --daemon-url http://127.0.0.1:1` (a guaranteed-unreachable port), pipes a minimal MCP `initialize` request to its stdin, and asserts the process exits non-zero within a bounded retry budget.  The test must NOT hang and must NOT see any unexpected child node process spawned.
- [x] 4.2 Confirm `pnpm test` still passes the full existing suite after the new tests are added.

## 5. README and onboarding

- [x] 5.1 Rewrite the "Quick Start" section in `README.md`: replace the 0.3.0 daemon-only `type: "http"` example with the three-step flow (start daemon via npx, configure `.mcp.json` with `npx ... cross-agent-teams-channel --daemon-url ...`, start Claude with `--dangerously-load-development-channels server:cross-agent-teams-channel`).  Include the constraint that the `.mcp.json` server name MUST equal the `server:<name>` suffix.
- [x] 5.2 Mirror the same rewrite in `README.zh-CN.md`.
- [x] 5.3 Update the in-repo `.mcp.json` to the new shape so a fresh clone matches the documented flow.

## 6. Memory and CLAUDE-context cleanup

- [x] 6.1 Edit `~/.claude/projects/-Users-jtianling-workspace-cross-agent-teams-mcp/memory/publish_line.md`: remove the (incorrect) sentence claiming "Channel wake in 0.3.x rides the existing streamable-HTTP MCP connection (server-to-client SSE notifications), no separate process needed."  Replace with a description of the two-bin / proxy-required reality.
- [x] 6.2 Add a one-line update to the same memory noting that 0.3.1 ships the proxy as a second bin in the main package.

## 7. Release

- [ ] 7.1 Verify `pnpm build && pnpm test` is green from a clean tree.
- [ ] 7.2 Commit the changes on a publish branch (single commit titled e.g. `feat(publish): bundle channel proxy as second bin in 0.3.1`).
- [ ] 7.3 Force-push the publish branch tip to `origin/release` (with `--force-with-lease`) and watch `gh run list --workflow=publish.yml` until the run completes successfully.
- [ ] 7.4 Verify on the registry: `npm view cross-agent-teams-mcp@0.3.1 bin` lists both `cross-agent-teams-mcp` and `cross-agent-teams-channel`.
- [ ] 7.5 Smoke from a clean shell: `npx -y cross-agent-teams-mcp@latest cross-agent-teams-channel --daemon-url http://127.0.0.1:9100/mcp` against a running daemon, observe a successful MCP `initialize` round-trip.

## 8. Archive

- [ ] 8.1 Once 7.5 is green, run `openspec archive bundle-channel-proxy-bin` to fold the delta spec into `openspec/specs/channel-cli-bin/spec.md`.
