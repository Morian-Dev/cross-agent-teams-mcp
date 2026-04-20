## Context

The project currently carries two legacy names:
- `ts-agent-teams` — the main daemon package, bin, and MCP server identity.
- `ts-agent-teams-channel` — a sub-package under `plugins/` that acts as a Claude Code stdio proxy.  In the rename it becomes `cross-agent-teams-channel` (package/dir) with its bin exposed as `cross-agent-teams-proxy` (user-facing CLI name).

The name `ts-` evokes "TypeScript" when the value proposition has nothing to do with the implementation language.  The new name `cross-agent-teams-mcp` states plainly what it is: an MCP daemon for cross-agent collaboration.  The rename must land before the first public release so no legacy-migration surface exists.

This is a **textual / identifier rename**, not a behavior change.  All MCP tool shapes, wire protocol, SQLite schema, and domain logic stay identical.  What moves:
- Package identities (npm `name`, `bin`).
- MCP server declared `name`.
- Env var prefix.
- On-disk home directory name.
- Physical plugin directory name.
- All brand-word strings in code, docs, specs, and tests.

## Goals / Non-Goals

**Goals:**
- Every project-internal reference to `ts-agent-teams` / `ts-agent-teams-channel` / `TS_AGENT_TEAMS_*` / `~/.ts-agent-teams/` moves to the `cross-agent-teams-mcp` family, atomically.
- Active openspec specs (under `openspec/specs/`) reflect the new names so `openspec validate` remains green.
- Tests remain runnable after the rename (import paths, assertion strings updated).
- Post-rename the project builds (`pnpm build`), type-checks (`pnpm -r typecheck`), and tests (`pnpm test`) exactly as before.

**Non-Goals:**
- **Backward compatibility**: no dual-read of old + new env vars, no symlink from old home dir, no deprecated-package re-export.  Per project MVP rule (see memory `feedback_skip_legacy_db_migration`), fresh-boot is assumed.
- **Archive rewriting**: `openspec/changes/archive/**` stays frozen as historical record.
- **Discuss-folder rewriting**: `discuss/*.md` historical design notes stay frozen.
- **Workspace directory rename**: user handles `agent-teams-mcp-workspace/` externally.
- **Re-registering user MCP clients**: user re-runs `claude mcp add` / updates opencode config on their own machine; the in-repo `opencode.json` and `docs/configs/*.md` are updated so fresh clones see the right key, but existing user installs are not migrated.

## Decisions

### D1: Full new prefix `CROSS_AGENT_TEAMS_MCP_*`, not an abbreviation
**Chosen**: `CROSS_AGENT_TEAMS_MCP_HOME`, `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`.
**Alternatives considered**:
- `CAT_MCP_*` — too short, collides with the `cat` command brain-mapping.
- `CROSS_AGENT_TEAMS_*` (drop `MCP` suffix) — inconsistent with the package name `cross-agent-teams-mcp`.
- Keep `TS_AGENT_TEAMS_*` — contradicts the whole point of the rename.
**Rationale**: env var names should mirror the package name verbatim so future readers can pattern-match.  Length is not a real cost — these are set once.

### D2: Rename the physical plugin directory as well, and drop `-mcp-` from the sub-package name
**Chosen**: `plugins/ts-agent-teams-channel/` → `plugins/cross-agent-teams-channel/` via `git mv`.  Package name in `package.json` and `plugin.json` becomes `cross-agent-teams-channel`.  Bin is renamed independently to `cross-agent-teams-proxy`.  `McpServer({name})` becomes `cross-agent-teams-channel`; `Client({name})` becomes `cross-agent-teams-proxy` (matches bin).
**Alternatives considered**:
- Keep old directory, only rename internal `name` fields — saves churn on a few import paths but creates permanent name/path incongruity.
- Use `cross-agent-teams-mcp-channel` (mirrors main package prefix) — rejected: the channel plugin IS an MCP proxy, so embedding `-mcp-` in its name is self-referential and redundant; the word `channel` is the meaningful discriminator.
- Bin name `cross-agent-teams-channel-proxy` (matches package name) — rejected: `channel` is a Claude Code protocol detail users need not surface; `cross-agent-teams-proxy` is shorter and clearer for CLI use.  Decoupling bin from package is standard (e.g. package `typescript` → bin `tsc`).
**Rationale**: layering the discriminators by audience — `channel` for the protocol-aware internal identity, `proxy` for the user-facing CLI — gives each layer the shortest name that still disambiguates.

### D3: No compatibility layer
**Chosen**: hard cut — old env vars, old home dir, old MCP server name stop working the moment the change lands.
**Alternatives considered**:
- Read `CROSS_AGENT_TEAMS_MCP_HOME ?? TS_AGENT_TEAMS_HOME ?? default` for one release.
- Auto-symlink `~/.ts-agent-teams/` to `~/.cross-agent-teams-mcp/` on first run.
**Rationale**: project is pre-release (no external users), and the memory rule `feedback_skip_legacy_db_migration` explicitly instructs skipping MVP-phase migration design.  Compatibility shims would carry zero observable value and permanent code cost.

### D4: Spec deltas as MODIFIED, not REMOVED-then-ADDED
**Chosen**: write two `## MODIFIED Requirements` deltas (one for `daemon-core`, one for `claude-channel-transport`) that restate the affected requirement with the new names.
**Alternatives considered**:
- Leave specs alone and rely on tests to enforce the contract.
- Drop the old requirement and add a fresh one under a new name.
**Rationale**: the requirement identity is unchanged (the daemon still has a binary-identity contract; the proxy still has a daemon-url env-var contract).  Only the literal tokens inside the requirement text change.  MODIFIED is the precise verb.

### D5: Atomic PR, sequenced commits
**Chosen**: one change, but committed in a sequence that keeps the tree compiling at every commit: (1) rename identifier bundle per task, (2) verify test suite, (3) final spec text update.  This mirrors the project's per-task TDD commit discipline.
**Alternatives considered**:
- One giant commit for the whole rename.
**Rationale**: per-task commits let `ts-apply` record evidence at each step and let bisect work later if some brand-word lingers.

### D6: MCP server `name` field is part of the rename surface
**Context**: `McpServer({name: 'ts-agent-teams'})` in `src/mcp/transport.ts` and `McpServer({name: 'ts-agent-teams-channel'})` in `plugins/.../src/proxy.ts` are declared during MCP handshake.  MCP clients may use this for logging / routing.
**Chosen**: rename daemon McpServer to `cross-agent-teams-mcp`, proxy McpServer to `cross-agent-teams-channel`, and the proxy's outbound `Client({name})` (declared in `daemon-client.ts`) to `cross-agent-teams-proxy` (matches the bin name so logs pin on the same token a user sees on their shell).
**Alternatives considered**: leave it as-is to avoid surprising any client that matches on server name.
**Rationale**: the server `name` is observable branding.  Leaving it stale is exactly the inconsistency this change exists to eliminate.  No known client in-repo matches on this string.

## Runtime Assumptions

No external-dependency default behaviors are being relied on in this change.  The rename touches only first-party identifiers and strings.  No library-managed defaults, framework-managed hooks, or implicit behaviors are in scope.

**Triggers audited**: scanned design.md and proposal.md for the trigger patterns (`default`, `rely on`, `handled by`, `out of the box`, 默认, 依赖, 处理, 内置).  None apply — every behavior mentioned is either unchanged (explicit in current code) or re-implemented as a literal string substitution.

## Risks / Trade-offs

- **Risk**: a brand-word string is missed somewhere and ships stale.  → Mitigation: final grep-based mechanical sweep (one of the tasks asserts `grep -r 'ts-agent-teams' src/ plugins/ docs/ openspec/specs/ opencode.json .gitignore tsconfig.json package.json` returns zero matches outside explicit allowlist).
- **Risk**: tests break in non-obvious ways because a string-comparison assertion on a brand word was missed.  → Mitigation: `pnpm test` is the integration gate at the end; failures surface before merge.
- **Risk**: directory rename corrupts git history blame.  → Mitigation: use `git mv` so git tracks the rename.  Blame follows.
- **Trade-off**: hard-cut env vars will annoy any dev running a stale daemon against new client code.  Accepted since project is pre-release.
- **Trade-off**: archived openspec changes will forever reference the old name.  Accepted — they are historical records, not living contracts.

## Migration Plan

Not applicable to external users (pre-release).  For the developer running the repo:

1. Stop any locally-running daemon.
2. Pull the rename change.
3. `rm -rf ~/.ts-agent-teams/` (or `mv` it to `~/.cross-agent-teams-mcp/` if data worth keeping).
4. Update any shell-exported `TS_AGENT_TEAMS_*` vars to the new names.
5. Re-run `claude mcp add --scope user cross-agent-teams-mcp http://127.0.0.1:9100/mcp --transport streamable-http` (the old `ts-agent-teams` entry can be removed via `claude mcp remove ts-agent-teams`).
6. `pnpm install && pnpm build && pnpm test`.

## Open Questions

None.  All decisions locked during the explore phase (conversation log captured in proposal).
