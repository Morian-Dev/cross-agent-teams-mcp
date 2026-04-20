## Context

`tests/brand-sweep.test.ts` greps ACTIVE_PATHS for the legacy brand literal. The legacy brand token is built at runtime inside the test (`['ts', 'agent', 'teams'].join('-')`) so the test file itself never matches its own grep. The test already maintains an `ANTI_BRAND_ASSERTION_EXCLUDES` allowlist for test files that legitimately contain the literal as negative-assertion data:

```typescript
const ANTI_BRAND_ASSERTION_EXCLUDES = [
  'brand-sweep.test.ts',
  'daemon-brand-in-tool-text.test.ts',
  'proxy-cli.test.ts',
  'proxy-startup-notification.test.ts'
]
```

After `rename-to-cross-agent-teams-mcp` (archived 2026-04-20) synced its delta, the main spec `openspec/specs/daemon-core/spec.md` now contains a Requirement whose prose embeds the legacy literal at lines 192 and 198:

- Line 192: "SHALL NOT contain the literal string `<legacy-brand>` (case-sensitive)" — a negative-assertion describing the invariant
- Line 198: an example `grep -r '<legacy-brand>' ...` command used by the Scenario

Because `openspec/specs` is in ACTIVE_PATHS and the spec file is not in the exclude list, the sweep matches its own Requirement. The sweep test fails with exactly 2 hits.

Constraints:

- **Do not change the invariant**: the Requirement's semantic content (shipped source tree must be free of the legacy brand) is correct and must survive.
- **Do not drop the sweep's coverage of `openspec/specs/`**: other spec files could still carry regressions; we only exclude the one file that is the negative-assertion document itself.
- **Do not touch `src/`, `plugins/`, or other specs**.
- **Self-consistency requirement**: the delta spec at `openspec/changes/fix-brand-sweep-self-match/specs/daemon-core/spec.md` must not itself contain the literal — it would re-introduce the exact problem during apply phase (the file lives under the repo, is picked up by grep during apply-phase runs even if not in ACTIVE_PATHS, and sets a bad precedent).

## Goals / Non-Goals

**Goals:**

- G1  `tests/brand-sweep.test.ts` returns GREEN in the full suite after the fix (no hits in any ACTIVE_PATHS file).
- G2  The invariant described by the reworded Requirement is semantically identical to the current one — future readers understand exactly what string is forbidden.
- G3  Defense in depth: the brand-sweep test's allowlist protects against future prose regressions in the same main-spec file.
- G4  A dedicated tripwire test pins both prongs: (a) `openspec/specs/daemon-core/spec.md` has zero literal hits, (b) the sweep runs GREEN against the full file tree.
- G5  `openspec validate fix-brand-sweep-self-match --strict` passes.

**Non-Goals:**

- NG1  No change to the brand itself (the new brand is `cross-agent-teams-mcp`, the legacy brand is unchanged).
- NG2  No change to ACTIVE_PATHS — the sweep continues to cover the same breadth.
- NG3  No modification to `src/` or `plugins/` source files.
- NG4  No modification to other specs (`agent-interrupts`, `mcp-business-tools`, etc.) — this is surgical to `daemon-core`.
- NG5  No introduction of a generic "legacy-brand" constant in production code — the workaround is a documentation-layer phrase, not a runtime symbol.

## Decisions

### D1  Encode the legacy brand as a placeholder with a constituent-parts lookup block

**Decision**: Rewrite the Requirement body in `openspec/specs/daemon-core/spec.md` so the literal never appears as a contiguous string. Strategy:

1. Open the Requirement body with a one-line lookup block defining a placeholder:

   > "In this Requirement, `<legacy-brand>` denotes the string equal to `'ts'` concatenated with `'-agent-teams'` (total 13 characters, case-sensitive, ASCII)."

2. The Requirement statement refers to `<legacy-brand>` by placeholder, not by literal.
3. The Scenario's `WHEN` clause also uses `<legacy-brand>` inside the grep-example command, and adds a note clarifying that the placeholder resolves at evaluation time — the actual invocation substitutes the concatenated string.

**Why**: a placeholder + constituent-parts lookup communicates the invariant unambiguously to human readers (any reader can mentally compose `'ts' + '-agent-teams'` to get the forbidden string) while keeping the rendered `.md` file free of the literal. This is exactly what `tests/brand-sweep.test.ts` itself does with `['ts', 'agent', 'teams'].join('-')` — we apply the same technique to prose.

**Rejected alternative**: inline backtick fragments like `` `ts` + `-agent-teams` `` without a lookup block. This works syntactically but is less readable and harder to maintain; every reference would need the compound expression. A single lookup + named placeholder scales better.

**Rejected alternative**: describe the invariant purely narratively ("the pre-rename brand word") without ever defining it. This fails G2 (readers can't know precisely what string is forbidden).

### D2  Add the main spec file to `ANTI_BRAND_ASSERTION_EXCLUDES` as defense in depth

**Decision**: After the rewrite, extend `tests/brand-sweep.test.ts`'s allowlist to include the main spec path. Because the grep runs with `--exclude=<name>` (basename-level), a distinctive identifier is needed. Use the unique marker path segment `openspec/specs/daemon-core/spec.md` — but since `--exclude` matches on basename, we instead add the filename as a path-guarding check. Implementation: extend the allowlist to include an entry that triggers `--exclude-dir=daemon-core` OR reshape the matching. After investigation (see R2 below), concrete implementation: use `--exclude-dir` for the `daemon-core` directory within `openspec/specs` scope, guarded by the assertion that `daemon-core` directory under `openspec/specs/` only contains the one negative-assertion spec file. (If other daemon-core files arise later that should be swept, the exclude scope tightens in a follow-up change.)

**Why defense in depth**: the spec file is exactly analogous to the other files already in the allowlist (`daemon-brand-in-tool-text.test.ts`, `proxy-cli.test.ts`, `proxy-startup-notification.test.ts`) — they all legitimately reference the legacy brand as negative-assertion data. D1 alone would make the sweep pass today; D2 protects against the inevitable regression where a future edit re-introduces literal prose into the spec (e.g., copy-pasting an example or a future delta-sync that forgets the placeholder technique).

**Rejected alternative**: rely on D1 only. Fails G3; adds ongoing review cost for every future daemon-core spec edit.

**Rejected alternative**: exclude the whole `openspec/specs/` tree from the sweep. Fails G2/coverage — other specs should still be swept for regressions.

### D3  Delta spec encodes the placeholder strategy in its own prose

**Decision**: `openspec/changes/fix-brand-sweep-self-match/specs/daemon-core/spec.md` (the delta) uses the same `<legacy-brand>` placeholder + lookup block. This is doubly important because:

- The delta file sits under `openspec/changes/fix-brand-sweep-self-match/` — not under ACTIVE_PATHS (sweep ignores `openspec/changes/`), so the sweep itself won't flag it. BUT:
- Once archived, the delta moves to `openspec/changes/archive/...` which is also exempt. Still:
- Self-consistency: a delta that teaches "rewrite to avoid the literal" while embedding the literal defeats itself pedagogically and could be copy-pasted by a future maintainer.

**Why MODIFIED, not REMOVED/ADDED**: the Requirement's semantic identity is preserved (same invariant, same name); only its textual encoding is reworded. OpenSpec rules require `## MODIFIED Requirements` for in-place edits that preserve identity.

### D4  Regression test strategy

**Decision**: `tests/brand-sweep-spec-self-check.test.ts` contains two `it()` blocks:

1. **Spec-file zero-hit check**: reads `openspec/specs/daemon-core/spec.md`, asserts that `content.includes(LEGACY_BRAND)` is `false` (where `LEGACY_BRAND` is built at runtime via `['ts', 'agent', 'teams'].join('-')` to avoid self-matching).
2. **Sweep-in-isolation check**: programmatically invokes the same grep flow as `brand-sweep.test.ts` against the main spec file alone (with and without the exclude), asserting that:
   - Without exclude: grep finds zero hits (post-D1 rewrite).
   - With exclude in place: grep finds zero hits even if a hypothetical hit is introduced (verified via `--include` guard in a sub-case that skips if the conditional is not reproducible without file edits — the test documents the invariant).

**Why a separate test file instead of extending `brand-sweep.test.ts`**: keeps `brand-sweep.test.ts` focused on the full-tree sweep; keeps the self-check narrow; avoids mutating the existing allowlist logic under test conditions.

## Runtime Assumptions

(none — this change touches documentation text, a test-time grep allowlist, and a new tripwire test file. No production code paths change, no new defaults, no probe behavior, no env vars, no daemon startup changes, no MCP schema changes, no database changes.)

## Risks / Trade-offs

- **R1  Placeholder readability**: readers unfamiliar with the placeholder convention may need an extra second to mentally compose `'ts' + '-agent-teams'`. Mitigated by (a) placing the lookup block at the very top of the Requirement body, (b) using an explicit "concatenated" verb, (c) stating the total character count for sanity-checking.
- **R2  `--exclude` semantics**: GNU grep's `--exclude=PATTERN` matches file basenames, not paths. The current allowlist uses basenames like `brand-sweep.test.ts`. The main spec file is just `spec.md`, a name shared by many other spec files. Adding `--exclude=spec.md` would silence the sweep for ALL spec files, destroying coverage. Implementation must use `--exclude-dir=daemon-core` (directory-level exclude, safe because the `daemon-core` directory under `openspec/specs/` contains only the one spec file at present) OR restructure the allowlist entry to be path-aware. The chosen approach (documented here) is `--exclude-dir=daemon-core`, with an explicit constraint that if `openspec/specs/daemon-core/` ever acquires a second file, the exclude tightens. An inline comment in the test flags this constraint.
- **R3  Future contributors may re-introduce the literal**: D2 is the backstop. If someone edits `openspec/specs/daemon-core/spec.md` and inlines the literal, the sweep still passes thanks to the exclude, and the dedicated tripwire test `tests/brand-sweep-spec-self-check.test.ts` catches the regression immediately — providing a clear "spec-file must be literal-free" signal even when the sweep is silent on it.
- **R4  openspec/specs/daemon-core/ containing other future files**: handled by the inline comment in R2 above; the exclude scope is intentionally narrow and documented.

## Migration Plan

N/A — no schema change, no API change, no config change, no data migration. The only user-visible artifact is the reworded Requirement prose, which is semantically equivalent to the original.
