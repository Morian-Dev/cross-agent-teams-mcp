# contract-registry Specification

## Purpose

Register, version, and diff team-scoped JSON Schema contracts so downstream agents can detect breaking changes and retrieve historical versions.

## Requirements

### Requirement: Contracts table schema

The database SHALL contain a `contracts` table: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `team TEXT NOT NULL`, `name TEXT NOT NULL`, `version INTEGER NOT NULL`, `format TEXT NOT NULL CHECK(format='jsonschema')`, `schema TEXT NOT NULL /* serialized JSON */`, `note TEXT`, `registered_by TEXT NOT NULL`, `registered_at TEXT NOT NULL`, `UNIQUE(team, name, version)`.

#### Scenario: Fresh database creates contracts table

- **WHEN** daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('contracts')` lists all required columns
- **AND** the `UNIQUE(team, name, version)` constraint is present

### Requirement: register_contract serializes version increments

`register_contract({ name, schema, format?='jsonschema', note? })` MUST execute inside a SQLite `BEGIN IMMEDIATE` transaction. Inside the transaction it computes the next version as `COALESCE(MAX(version), 0) + 1` for `(team, name)`, INSERTs the new row, appends a `contract_registered` event, then COMMITs. Concurrent invocations on the same `(team, name)` MUST produce a strictly increasing version sequence with no duplicates and no gaps.

#### Scenario: First registration starts at version 1

- **GIVEN** contract name `user-schema` has no prior versions in team 'default'
- **WHEN** caller calls `register_contract({ name:'user-schema', schema:{type:'object'} })`
- **THEN** response contains `{ name:'user-schema', version:1 }`

#### Scenario: Sequential registrations increment version

- **GIVEN** `user-schema` is at version 3
- **WHEN** another `register_contract({ name:'user-schema', schema:{...} })` is called
- **THEN** response contains `version:4`

#### Scenario: 100 concurrent registrations produce 1..100 without gaps

- **GIVEN** empty contracts table
- **WHEN** 100 concurrent calls to `register_contract({ name:'X', schema:{...} })` complete
- **THEN** the resulting rows have versions exactly `{1,2,...,100}` with no repeat

### Requirement: register_contract returns diff from previous version

When a version > 1 is registered, the response MUST include a `diff: ContractDiff` field describing the structural difference from version `n-1`. For version 1 (first registration) the `diff` field MUST be omitted.

#### Scenario: Version 1 has no diff

- **WHEN** first `register_contract` for name `X` is called
- **THEN** response has no `diff` key

#### Scenario: Version 2 carries diff from version 1

- **GIVEN** `X` version 1 has `{type:'object', properties:{a:{type:'string'}}, required:['a']}`
- **WHEN** `register_contract` for `X` with `{type:'object', properties:{a:{type:'string'}, b:{type:'number'}}, required:['a','b']}` is called
- **THEN** response `diff.added_fields` contains `{path:'/properties/b', type_summary:'number'}`
- **AND** `diff.changed_fields` reports `required` change for `/properties/b`

### Requirement: ContractDiff structure

`ContractDiff` SHALL have shape `{ added_fields: Array<{path,type_summary}>, removed_fields: Array<{path,type_summary}>, changed_fields: Array<{path,from:{type?,required?,enum?,raw},to:{type?,required?,enum?,raw}}>, breaking: boolean }`. `path` MUST use RFC 6901 JSON Pointer with full nesting: `/properties/user/properties/id` (not `/properties/user/id`).

#### Scenario: Nested field uses full JSON Pointer

- **GIVEN** v1 `{type:'object', properties:{user:{type:'object', properties:{id:{type:'string'}}}}}`
- **AND** v2 `{type:'object', properties:{user:{type:'object', properties:{id:{type:'number'}}}}}`
- **WHEN** diff is computed
- **THEN** `changed_fields[0].path === '/properties/user/properties/id'`

### Requirement: Breaking flag rules

`breaking` MUST be `true` when any of: `removed_fields.length > 0`, OR any `changed_fields` entry has `from.required=false && to.required=true`, OR any `changed_fields` entry has `from.type != to.type` (string inequality). All other diffs MUST be `breaking: false`.

#### Scenario: Removed field marks breaking

- **GIVEN** v1 has field `/properties/b` and v2 does not
- **WHEN** diff is computed
- **THEN** `breaking === true`

#### Scenario: Required false→true marks breaking

- **GIVEN** v1: `required=['a']`; v2: `required=['a','b']` (b existed in v1 as optional)
- **WHEN** diff is computed
- **THEN** `breaking === true`

#### Scenario: Type change marks breaking

- **GIVEN** v1 has `/properties/a:{type:'string'}`, v2 has `/properties/a:{type:'number'}`
- **WHEN** diff is computed
- **THEN** `breaking === true`

#### Scenario: Adding optional field is non-breaking

- **GIVEN** v1 has no field b, v2 adds optional `/properties/b`
- **WHEN** diff is computed
- **THEN** `breaking === false`

### Requirement: get_contract returns specified version or latest

`get_contract({ name, version? })` SHALL return `{ name, version, schema, format, note?, registered_at }` for the specified version, or the latest version when `version` is omitted. Unknown name SHALL return `{ error: 'unknown_contract' }`. Unknown version SHALL return `{ error: 'unknown_version' }`.

#### Scenario: Get latest

- **GIVEN** contract `X` at versions 1, 2, 3
- **WHEN** caller calls `get_contract({name:'X'})`
- **THEN** response has `version: 3`

#### Scenario: Unknown contract

- **WHEN** caller calls `get_contract({name:'no-such'})`
- **THEN** response is `{ error: 'unknown_contract' }`

### Requirement: diff_contracts computes explicit version diff

`diff_contracts({ name, from_version, to_version })` SHALL return the `ContractDiff` between the two specified versions (either direction supported).

#### Scenario: Explicit diff between two versions

- **GIVEN** contract `X` has versions 1 and 2 with known differences
- **WHEN** caller calls `diff_contracts({name:'X', from_version:1, to_version:2})`
- **THEN** response matches the same diff reported by `register_contract` at v2 creation time
