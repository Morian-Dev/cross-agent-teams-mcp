## Context

The `register_agent` MCP tool currently has an input field `client: 'codex' | 'claude-code' | 'opencode' | 'custom'` and a companion `client_name?: string` (required when `client='custom'`). The Zod schema, the SQLite `agents.client` / `agents.client_name` columns, the `list_agents` response, the TypeScript type `ClientKind`, and several other tool schemas (`detect_tmux_pane`, `bind_runtime_identity`) all share this naming.

The "client" name overloads the MCP protocol's own concept of "client" — every MCP session's `initialize` handshake carries a `clientInfo` block, and the daemon internally calls these "MCP clients". An LLM reading `register_agent`'s description has to disambiguate two different "clients" in adjacent paragraphs. This subtle ambiguity contributed to a real production-style misclassification observed during the `collapse-register-self-tools` end-to-end test (cursor wrongly chose `client="opencode"`).

Renaming the field aligns it with the project's primary noun:
- The daemon's main entity is "agent" (`agents` table, `agent_id`, `register_agent`, `list_agents`, `unregister_self`).
- Community vocabulary already calls claude-code / codex / cursor / opencode "code agents".
- `agent_type` reads naturally next to `agent_id` and `role`: "this agent's unique ID, type, and functional role".

## Goals / Non-Goals

**Goals:**
- Replace `client` with `agent_type` and `client_name` with `agent_type_name` across the entire codebase: MCP tool schemas, SQLite columns, TypeScript types, response shapes, descriptions, instructions, README/docs, and tests.
- Preserve all existing behavior — this is a pure rename. The string enum values (`'codex'`, `'claude-code'`, `'opencode'`, `'custom'`), the auto-bind logic, the codex-appserver routing, the schema refinements, and every other functional rule are untouched.
- Provide an idempotent SQLite column-rename startup migration so existing databases keep their data.
- Update all artifacts of the in-flight `collapse-register-self-tools` change in place (proposal/design/specs/tasks/CHANGELOG) so its terminology stays internally consistent after archival.

**Non-Goals:**
- No semantic / behavioral changes to registration, delivery routing, or any other tool.
- No deprecation aliases — the old `client` key is rejected by the strict schema in 0.5.0. (Same posture as `collapse-register-self-tools`: this codebase favors clean breaks under 0.x.)
- No rename of `claude_ui_pid` / `runtime_ui_pid` / `channel_session_id` — those reference the specific Claude Code channel proxy mechanism, not the generic "client" overload.
- No change to the `'codex' | 'claude-code' | 'opencode' | 'custom'` enum values themselves.

## Decisions

### D1: Sequencing — apply AFTER `collapse-register-self-tools` is archived

**Decision**: Land this change AFTER `collapse-register-self-tools` is archived into the main spec.

**Rationale**: `collapse-register-self-tools` is in flight (apply done, not yet archived) and its spec deltas extensively reference `client` in their MODIFIED / ADDED requirements. If both changes are unarchived simultaneously and we write `agent_type`-based deltas here against the current main spec (which still has `client`), the openspec archive workflow has to reconcile two parallel deltas touching the same requirements — error-prone.

Sequencing instead:
1. `collapse-register-self-tools` archives → `client`-based requirements land in main spec.
2. This change's deltas MODIFY those just-landed requirements to use `agent_type`.

Practical implication: the implementation tasks here include a step "rename `client` to `agent_type` inside the unarchived `collapse-register-self-tools` artifacts" so that the in-flight change stays internally consistent. When that earlier change archives, the rename rides along — and main spec ends up with `agent_type` directly, no second pass needed.

**Alternatives considered**:
- Fold this rename into `collapse-register-self-tools` itself. Rejected — user explicitly asked for a separate change to keep the diffs reviewable.
- Apply this change FIRST, then collapse. Rejected — collapse is more mature, has more tests, and was already verified.

### D2: Storage migration — use `ALTER TABLE ... RENAME COLUMN`

**Decision**: Add an idempotent startup migration:

```sql
-- only if the old column still exists
ALTER TABLE agents RENAME COLUMN client       TO agent_type;
ALTER TABLE agents RENAME COLUMN client_name  TO agent_type_name;
```

Run on daemon startup, similar to the existing `claude_ui_pid` migration pattern. Use `PRAGMA table_info(agents)` to check whether the old columns still exist; skip the ALTERs if they don't.

**Rationale**: SQLite supports `RENAME COLUMN` since 3.25 (2018). better-sqlite3 ships ≥3.40. The rename is in-place, instant, and preserves all data including indexes that reference the column by name.

**Alternatives considered**:
- Drop and re-create the table with the new column. Rejected — destructive, loses data.
- Add new column, copy data, drop old. Rejected — three SQL statements when one suffices.
- Don't migrate, force users to wipe their database. Rejected — existing live agents would be lost on every restart.

### D3: Cascade to `detect_tmux_pane` and `bind_runtime_identity` schemas

**Decision**: These two tools currently take an `agent: 'codex' | 'claude-code' | 'opencode' | 'custom'` argument typed as `ClientKind`. The TypeScript type alias renames to `AgentType`, but the JSON schema field name on these two tools STAYS `agent` (it was never called `client` to begin with).

So: internal type rename only, no public schema break for those two tools.

**Rationale**: These tools' field name is already `agent`, semantically aligned. The only change is the TypeScript type alias they reference internally. No behavioral or wire-format change.

### D4: Update the in-flight change's artifacts in place

**Decision**: Modify `openspec/changes/collapse-register-self-tools/proposal.md`, `design.md`, `specs/agent-registry/spec.md`, `specs/mcp-transport/spec.md`, and `tasks.md` to use `agent_type` instead of `client`. The `CHANGELOG.md` 0.4.0 entry is left as a historical record of "the rename happened in 0.5.0"; the 0.5.0 entry documents the rename.

**Rationale**: When the collapse change archives later, its delta text becomes part of the main spec. If we leave `client` in those deltas, the post-archive main spec will have `client` and we'd need to do a second-pass rename through openspec. Rewriting the deltas now keeps a single source of truth.

The collapse change itself isn't versioned past 0.4.0 — it ships 0.4.0 with `client`. Then 0.5.0 ships with `agent_type`. Between them, anyone who installed 0.4.0 needs to migrate their call sites — which they'd have to do anyway because of the upcoming 0.5.0.

(Alternatively: we could hold collapse archive until rename is implemented, then archive both in lockstep. That keeps one shipping moment but is a bigger atomic surface.)

### D5: `client_name` → `agent_type_name` (not `client_name` retained, not `agent_type_label`)

**Decision**: The companion field renames from `client_name` to `agent_type_name`.

**Rationale**: The two fields are paired (`client_name` is required only when `client='custom'`); they should rename together for symmetry. `agent_type_name` reads naturally — "the agent type's name when the type is custom".

**Alternatives considered**:
- Keep `client_name` unchanged. Rejected — confusing pair (`agent_type` + `client_name`).
- Rename to `agent_type_label`. Rejected — `name` matches what callers actually pass ("cursor", "myharness"); "label" suggests a display string.
- Rename to `harness_name`. Rejected — adds yet another noun (`harness`) that doesn't appear elsewhere.

## Risks / Trade-offs

- **[Risk] In-flight collapse change conflicts** → Mitigation: D4 + D1. Rewrite collapse's artifacts now; archive collapse first, then rename.
- **[Risk] Mechanical sed-style rename breaks unrelated `client` mentions** (e.g. variable names, comments referring to MCP clients in general) → Mitigation: do the rename per-file rather than repo-wide sed. Tests are the safety net.
- **[Risk] better-sqlite3 version too old to support `RENAME COLUMN`** → Mitigation: check `package.json` engines / better-sqlite3 version; SQLite 3.25+ is required (we already pin a version that bundles ≥3.40).
- **[Trade-off] Two breaking releases back-to-back (0.4.0 collapse, 0.5.0 rename)** → Accept; both surfaces are local-only npm publishes per MEMORY notes, and downstream consumers do the migration once for both at the cost of two rename passes (`register_claude_self` → `register_agent`, then `client` → `agent_type`).
- **[Trade-off] `claude_ui_pid` / `runtime_ui_pid` retain "claude" prefix while we rename `client`** → Accept; those names refer to a specific Claude Code mechanism and renaming them would require a separate semantic discussion. Out of scope here.

## Migration Plan

For end users / external launchers:
1. Update every `register_agent` call: `client: 'X'` → `agent_type: 'X'`, `client_name: 'Y'` → `agent_type_name: 'Y'`.
2. Update any `list_agents` response handling to read `agent_type` / `agent_type_name`.
3. Update any direct SQL on `agents` table (uncommon for external consumers — daemon owns the DB).

For this repo:
1. Rewrite collapse change's artifacts in place (D4).
2. Implement the rename per the task list.
3. Restart the daemon — the column-rename startup migration runs on boot.
4. Bump version to 0.5.0; update CHANGELOG.

**Rollback**: revert the PR. The daemon would need to roll back the column rename via the inverse `ALTER TABLE`, but no data loss occurs.

## Open Questions

(none)
