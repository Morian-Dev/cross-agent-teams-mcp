## REMOVED Requirements

### Requirement: Tasks table schema

**Reason**: The shared task-list feature is removed in this change. No MCP tool, no internal subsystem, and no test reads or writes the `tasks` table any more. The boot path drops the table if it exists (see `daemon-core`: "Boot-time drop of legacy task and contract tables").

**Migration**: None. The feature was unused in practice — jt confirmed real cross-agent coordination always happened over normal mailbox messaging. Agents needing shared todo lists must build their own coordination layer over `send_message` / `broadcast`.

### Requirement: task_add creates a pending task

**Reason**: The `task_add` MCP tool is removed.

**Migration**: None. Use `send_message` or `broadcast` to coordinate work between agents.

### Requirement: task_add tool description advises poke follow-up

**Reason**: The `task_add` MCP tool is removed; there is no longer a tool description to constrain.

**Migration**: None.

### Requirement: task_claim single-statement CAS

**Reason**: The `task_claim` MCP tool is removed.

**Migration**: None. Agents that need atomic "I'm working on this" semantics must build their own coordination over mailbox messaging.

### Requirement: task_complete enforces claimer ownership

**Reason**: The `task_complete` MCP tool is removed.

**Migration**: None.

### Requirement: task_list filters by status and team

**Reason**: The `task_list` MCP tool is removed.

**Migration**: None.
