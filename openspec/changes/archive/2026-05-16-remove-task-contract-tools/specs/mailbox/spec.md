## REMOVED Requirements

### Requirement: Task creation does not provide direct notification

**Reason**: The entire `task_*` tool family (`task_add`, `task_claim`, `task_complete`, `task_list`) is removed in this change. There is no longer a `task_add` tool whose notification surface needs to be constrained.

**Migration**: None. Callers that previously relied on `task_add` must coordinate via normal mailbox messaging (`send_message`, `broadcast`, `broadcast_to_role`) instead. The mailbox tools' own requirements already specify their notification semantics.
