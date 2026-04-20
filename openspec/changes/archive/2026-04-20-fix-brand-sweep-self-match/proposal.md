## Why

`rename-to-cross-agent-teams-mcp` (archived 2026-04-20) introduced a "Daemon source tree free of legacy brand word" Requirement into `openspec/specs/daemon-core/spec.md` (lines 192 and 198). That Requirement's prose embeds the exact literal `<legacy-brand>` (where `<legacy-brand>` denotes the string equal to `'ts' + '-agent-teams'` concatenated) both in the negative-assertion sentence and in the example `grep` command.

`tests/brand-sweep.test.ts` greps ACTIVE_PATHS (which includes `openspec/specs/`) for that very same literal. After the archive sync, the sweep now matches its own Requirement in the main spec. Current state: 1 test in the root suite fails with exactly 2 hits (line 192 and line 198 of `openspec/specs/daemon-core/spec.md`).

Runtime witness (2026-04-20):

```
× tests/brand-sweep.test.ts > brand sweep > no active source file contains the legacy <legacy-brand> brand
  → unexpected legacy brand hits:
    openspec/specs/daemon-core/spec.md:192: ...
    openspec/specs/daemon-core/spec.md:198: ...

(In this proposal, `<legacy-brand>` denotes the string equal to `'ts'` concatenated with `'-agent-teams'`.)
```

Impact: a baseline failure blocks every future change's GREEN gate until fixed; also the sweep-vs-spec self-match is structurally analogous to the already-handled negative-assertion test files (`daemon-brand-in-tool-text.test.ts`, `proxy-cli.test.ts`, `proxy-startup-notification.test.ts`), which are already in the sweep's exclude allowlist. The daemon-core spec deserves the same defense-in-depth treatment.

## What Changes

- **Spec rewrite**: `openspec/specs/daemon-core/spec.md` — rewrite the "Daemon source tree free of legacy brand word" Requirement's prose to describe the invariant WITHOUT embedding the literal `<legacy-brand>`. Use a lookup block at the top of the Requirement body ("where `<legacy-brand>` denotes `'ts' + '-agent-teams'` concatenated") and reference `<legacy-brand>` throughout the Requirement statement and the Scenario. After rewrite, `grep '<legacy-brand>' openspec/specs/daemon-core/spec.md` returns zero matches.
- **Sweep exclude allowlist**: `tests/brand-sweep.test.ts` — add `spec.md` (the daemon-core main spec file) path-segment to `ANTI_BRAND_ASSERTION_EXCLUDES`, matching the analogous negative-assertion file pattern. This is defense in depth: even if someone re-introduces literal prose into the spec, the sweep still passes because the main-spec file is categorically a negative-assertion document.
- **Regression test**: new `tests/brand-sweep-spec-self-check.test.ts` asserting (a) the main spec file contains zero literal brand hits after the rewrite, and (b) the brand sweep passes in isolation.
- Code unchanged: no edits to `src/`, `plugins/`, production entry points, or any other spec.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `daemon-core`: the Requirement "Daemon source tree free of legacy brand word" has its prose reworded to avoid self-matching. The invariant it describes is unchanged — the brand-sweep still forbids the legacy literal in the shipped source tree. Only the textual representation is literal-free.

## Impact

- **Code**: no `src/` or `plugins/` edits
- **Tests**:
  - Modify: `tests/brand-sweep.test.ts` (append main-spec file to `ANTI_BRAND_ASSERTION_EXCLUDES`)
  - Create: `tests/brand-sweep-spec-self-check.test.ts` (new tripwire)
- **Spec**: `daemon-core` delta — MODIFIED Requirement "Daemon source tree free of legacy brand word" (prose reworded, invariant identical)
- **Database**: no schema change, no migration
- **Dependencies**: no new external dependencies
- **MCP client**: no protocol-level change — this is a documentation + test infrastructure fix
