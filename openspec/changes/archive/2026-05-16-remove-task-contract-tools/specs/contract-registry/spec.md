## REMOVED Requirements

### Requirement: Contracts table schema

**Reason**: The contract-registry feature is removed in this change. No MCP tool, no internal subsystem, and no test reads or writes the `contracts` table any more. The boot path drops the table if it exists (see `daemon-core`: "Boot-time drop of legacy task and contract tables").

**Migration**: None. The feature was unused in practice. Agents that want to negotiate API or protocol versions must do so via normal mailbox messaging.

### Requirement: register_contract serializes version increments

**Reason**: The `register_contract` MCP tool is removed.

**Migration**: None.

### Requirement: register_contract returns diff from previous version

**Reason**: The `register_contract` MCP tool is removed.

**Migration**: None.

### Requirement: ContractDiff structure

**Reason**: `ContractDiff` was the response shape of `register_contract` / `diff_contracts`. Both tools are removed.

**Migration**: None.

### Requirement: Breaking flag rules

**Reason**: Breaking-flag rules were part of the contract-registry semantics. The whole feature is removed.

**Migration**: None.

### Requirement: get_contract returns specified version or latest

**Reason**: The `get_contract` MCP tool is removed.

**Migration**: None.

### Requirement: diff_contracts computes explicit version diff

**Reason**: The `diff_contracts` MCP tool is removed.

**Migration**: None.
