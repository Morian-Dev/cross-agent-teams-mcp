# daemon-core Delta — fix-brand-sweep-self-match

## MODIFIED Requirements

### Requirement: Daemon source tree free of legacy brand word

The daemon's shipped source tree (non-archived, non-historical: `src/**`, `package.json`, `tsconfig.json`, active `docs/configs/**`, active `openspec/specs/**`, `opencode.json`, `.gitignore`) SHALL NOT contain `<legacy-brand>` as a literal substring, where `<legacy-brand>` denotes the 13-character ASCII case-sensitive string equal to `'ts'` concatenated with `'-agent-teams'`. This ensures the rename is complete and future readers never re-encounter the legacy brand.

Exempt paths: `openspec/changes/archive/**`, `discuss/**`, `node_modules/**`, `dist/**`, `pnpm-lock.yaml`, `worktrees/**`.

Additionally, documentation files that describe this invariant by negative assertion (notably `openspec/specs/daemon-core/spec.md` itself and the test files `tests/brand-sweep.test.ts`, `tests/daemon-brand-in-tool-text.test.ts`, `tests/proxy-cli.test.ts`, `tests/proxy-startup-notification.test.ts`) are CONDITIONALLY exempt: they MAY reference `<legacy-brand>` only as part of negative-assertion test data or placeholder-based prose, and they MUST be included in the brand-sweep test's `ANTI_BRAND_ASSERTION_EXCLUDES` allowlist (directly or via directory-level exclude).

#### Scenario: Brand-sweep grep returns zero matches

- **GIVEN** the ACTIVE_PATHS (as defined in `tests/brand-sweep.test.ts`) do not include files that carry `<legacy-brand>` as a non-exempt literal
- **AND** the allowlist excludes the negative-assertion documentation files and the daemon-core spec directory
- **WHEN** grep searches the ACTIVE_PATHS for `<legacy-brand>` with the allowlist excludes applied
- **THEN** grep exits with code `1` (no matches) or produces empty output

#### Scenario: Main daemon-core spec file is literal-free

- **GIVEN** `openspec/specs/daemon-core/spec.md` is the main-spec document describing this Requirement
- **WHEN** a consumer reads the file's raw bytes and searches for the `<legacy-brand>` literal as a contiguous substring
- **THEN** zero matches are found
- **AND** the Requirement's prose still unambiguously describes the forbidden string via the placeholder + constituent-parts lookup block at the top of the Requirement body

#### Scenario: Allowlist covers the main daemon-core spec file as defense in depth

- **GIVEN** `tests/brand-sweep.test.ts` defines `ANTI_BRAND_ASSERTION_EXCLUDES`
- **WHEN** the list is inspected
- **THEN** either `openspec/specs/daemon-core/` is covered via a directory-level exclude (e.g. `--exclude-dir=daemon-core` scoped inside `openspec/specs`) or the file is otherwise excluded by a path-aware entry
- **AND** this exclude does NOT silence any other spec under `openspec/specs/` that may legitimately require sweeping
