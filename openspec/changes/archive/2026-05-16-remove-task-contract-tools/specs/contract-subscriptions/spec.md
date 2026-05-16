## REMOVED Requirements

### Requirement: Contract subscriptions table

**Reason**: The contract-subscriptions feature is removed in this change. No MCP tool, no internal subsystem, and no test reads or writes the `contract_subscriptions` table any more. The boot path drops the table if it exists (see `daemon-core`: "Boot-time drop of legacy task and contract tables").

**Migration**: None.

### Requirement: subscribe_contract upserts subscription

**Reason**: The `subscribe_contract` MCP tool is removed.

**Migration**: None.

### Requirement: pending_contract_events polling

**Reason**: The `pending_contract_events` MCP tool is removed.

**Migration**: None. Agents that need event-style notifications must use the SSE channel (`subscribe_channel_wake`) or normal mailbox polling (`get_inbox`).

### Requirement: SSE channel fan-out on contract events

**Reason**: There are no more `contract_event` notifications; the daemon no longer emits or fans out contract events on the SSE channel.

**Migration**: None.

### Requirement: SSE push failure does not block writes

**Reason**: The requirement scoped this property specifically to contract-event writes via `register_contract`. With `register_contract` removed, the scope no longer exists. The general "SSE failure is best-effort" property is preserved by the mailbox / channel specs for the surviving event types.

**Migration**: None.
