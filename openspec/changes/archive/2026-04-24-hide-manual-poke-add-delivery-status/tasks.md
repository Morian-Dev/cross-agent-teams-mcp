## 1. Public Tool Surface

- [x] 1.1 Remove public `poke` tool registration while preserving internal `poke()` callers
- [x] 1.2 Update `task_add` tool description so it does not recommend `poke` or any direct notification replacement
- [x] 1.3 Update tool registration / description tests for `poke` removal and `task_add` wording

## 2. Delivery Status Storage

- [x] 2.1 Add `message_delivery_status` schema and repository helpers
- [x] 2.2 Write delivery status rows for `send_message`, `broadcast`, and `broadcast_to_role`
- [x] 2.3 Update retry ticks to mark retry success, recipient activity cancellation, missing pane, and retry exhaustion

## 3. Status Query Tool

- [x] 3.1 Implement `get_delivery_status({message_id})` service with sender-only authorization
- [x] 3.2 Register `get_delivery_status` MCP tool and schema
- [x] 3.3 Add tests for direct message, broadcast, and non-sender access

## 4. Verification

- [x] 4.1 Run focused tests for tools, auto-poke, retry, and delivery status
- [x] 4.2 Run OpenSpec verification for `hide-manual-poke-add-delivery-status`
