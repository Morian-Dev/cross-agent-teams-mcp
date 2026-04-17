## ADDED Requirements

### Requirement: Tasks table schema

The database SHALL contain a `tasks` table: `id TEXT PRIMARY KEY`, `team TEXT NOT NULL`, `title TEXT NOT NULL`, `description TEXT`, `status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed'))`, `depends_on TEXT NOT NULL /* JSON array of task ids */`, `claimed_by TEXT`, `claimed_at TEXT`, `completed_at TEXT`, `result TEXT`, `created_at TEXT NOT NULL`.

#### Scenario: Fresh database creates tasks table

- **WHEN** daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('tasks')` includes all required columns with the CHECK constraint

### Requirement: task_add creates a pending task

`task_add({ title: string, description?: string, depends_on?: string[] = [] })` SHALL insert a new task with `status='pending'`, `depends_on` serialized as JSON, `created_at` set to now, and append an event `event_type='task_added'`. Response is `{ task_id }`.

#### Scenario: Add task without dependencies

- **WHEN** caller calls `task_add({ title: 'write docs' })`
- **THEN** response contains a new UUID as `task_id`
- **AND** `tasks` table has a row with `status='pending'` and `depends_on='[]'`
- **AND** a `task_added` event is appended

### Requirement: task_claim single-statement CAS

`task_claim({ task_id })` MUST attempt the claim in a single atomic UPDATE that sets `status='in_progress'`, `claimed_by=<caller>`, `claimed_at=now()` WHERE `id=:task_id AND status='pending' AND all rows in depends_on have status='completed'`. On success (changes == 1) return `{ ok: true }` and append `task_claimed` event. Otherwise return one of `{ error: 'already_claimed', owner }` or `{ error: 'dependencies_pending' }` or `{ error: 'unknown_task' }`.

#### Scenario: Claim succeeds when task is pending and deps met

- **GIVEN** task `T1` has status 'pending' and no dependencies
- **WHEN** caller calls `task_claim({task_id:'T1'})`
- **THEN** response is `{ ok: true }`
- **AND** tasks row has `status='in_progress'`, `claimed_by=<caller>`, `claimed_at` set
- **AND** an event with `event_type='task_claimed'` is appended

#### Scenario: Claim fails with owner when already claimed

- **GIVEN** task `T1` was already claimed by agent `sess-A`
- **WHEN** agent `sess-B` calls `task_claim({task_id:'T1'})`
- **THEN** response is `{ error: 'already_claimed', owner: 'sess-A' }`
- **AND** no new event is appended

#### Scenario: Claim fails when dependency not completed

- **GIVEN** task `T2` has `depends_on=['T1']` and `T1.status='in_progress'`
- **WHEN** any caller calls `task_claim({task_id:'T2'})`
- **THEN** response is `{ error: 'dependencies_pending' }`

#### Scenario: Claim on unknown task id

- **WHEN** caller calls `task_claim({task_id:'does-not-exist'})`
- **THEN** response is `{ error: 'unknown_task' }`

### Requirement: task_complete enforces claimer ownership

`task_complete({ task_id, result?: string })` MUST only succeed when the caller's `agent_id` equals `tasks.claimed_by` and `tasks.status='in_progress'`. On success: set `status='completed'`, `completed_at=now()`, `result=:result`, append `task_completed` event, return `{ ok: true }`. Otherwise return `{ error: 'not_owner' }` or `{ error: 'invalid_status' }`.

#### Scenario: Owner completes task

- **GIVEN** task `T1` is claimed by caller, status 'in_progress'
- **WHEN** caller calls `task_complete({task_id:'T1', result:'done'})`
- **THEN** response is `{ ok: true }`
- **AND** tasks row has `status='completed'`, `result='done'`, `completed_at` set

#### Scenario: Non-owner rejected

- **GIVEN** task `T1` is claimed by `sess-A`
- **WHEN** `sess-B` calls `task_complete({task_id:'T1'})`
- **THEN** response is `{ error: 'not_owner' }`

#### Scenario: Completing a pending task

- **GIVEN** task `T1` has `status='pending'` (no one claimed it)
- **WHEN** any caller calls `task_complete({task_id:'T1'})`
- **THEN** response is `{ error: 'invalid_status' }`

### Requirement: task_list filters by status and team

`task_list({ status?: 'pending'|'in_progress'|'completed' })` SHALL return tasks in the caller's team matching the status filter (or all if omitted), ordered by `created_at` ascending. Response is `{ tasks: Array<TaskRow> }`.

#### Scenario: Filter by pending

- **GIVEN** in caller's team: two pending, one in_progress, three completed tasks
- **WHEN** caller calls `task_list({status:'pending'})`
- **THEN** response contains exactly the two pending tasks

#### Scenario: Tasks are team-scoped

- **GIVEN** two tasks in team 'alpha' and five in team 'beta'
- **WHEN** caller in team 'alpha' calls `task_list({})`
- **THEN** only the two team-'alpha' tasks are returned
