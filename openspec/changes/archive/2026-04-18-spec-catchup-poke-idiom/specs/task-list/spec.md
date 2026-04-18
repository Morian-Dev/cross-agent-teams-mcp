## MODIFIED Requirements

### Requirement: task_add creates a pending task

`task_add({ title: string, description?: string, depends_on?: string[] = [] })` SHALL insert a new task with `status='pending'`, `depends_on` serialized as JSON, `created_at` set to now, and append an event `event_type='task_added'`. Response is `{ task_id }`.

`task_add` MUST NOT auto-poke any agent.  The task sits in the pending queue until some agent calls `task_claim` on their next turn.  Callers MAY chain `poke({ target_agent_id, prompt })` after a successful `task_add` to nudge a specific agent to pick up the new task, but the daemon itself MUST NOT initiate such a poke on behalf of the caller.  The `task_add` tool's MCP description SHOULD advise callers of the "fire-and-forget + optional poke follow-up" idiom.

#### Scenario: Add task without dependencies

- **WHEN** caller calls `task_add({ title: 'write docs' })`
- **THEN** response contains a new UUID as `task_id`
- **AND** `tasks` table has a row with `status='pending'` and `depends_on='[]'`
- **AND** a `task_added` event is appended

#### Scenario: task_add does not auto-poke any agent

- **GIVEN** team 'default' has agents `sess-A` (caller), `sess-B`, `sess-C`, all with `tmux_pane_id` set
- **WHEN** `sess-A` calls `task_add({ title: 'refactor login' })`
- **THEN** the task is persisted with `status='pending'`
- **AND** the `task_added` event is appended
- **AND** the daemon MUST NOT invoke the `poke` tool or any tmux command on `sess-B`'s or `sess-C`'s panes

## ADDED Requirements

### Requirement: task_add tool description advises poke follow-up

The `task_add` tool's MCP `description` field (as returned by `tools/list`) MUST reference the `poke` tool by name.  The description MUST indicate that waking a specific agent to claim the task is the caller's optional, explicit responsibility, and that broadcast-style poking every agent on every new task is deliberately NOT provided (to avoid spam).

#### Scenario: task_add tool description references poke

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `task_add`
- **THEN** the description string SHOULD contain the substring `poke`
- **AND** SHOULD indicate per-target / per-agent invocation is the recommended pattern for waking a specific agent
