## 1. Storage and Service Contract

- [x] 1.1 Add `messages.need_reply INTEGER NOT NULL DEFAULT 1` to the storage schema.
- [x] 1.2 Extend `SendInput` and `send_message` tool schema with optional `need_reply`.
- [x] 1.3 Persist `need_reply` from `send_message`, defaulting omitted values to `true`.
- [x] 1.4 Persist `need_reply:false` for `broadcast` and `broadcast_to_role` rows.
- [x] 1.5 Return `need_reply:boolean` from `get_inbox`.

## 2. Tool Text and Tests

- [x] 2.1 Update `send_message` tool description to document `need_reply` and `need_reply:false`.
- [x] 2.2 Add schema/storage tests for the `need_reply` column and `send_message` parameter.
- [x] 2.3 Add service tests for default `need_reply=true`, explicit `need_reply=false`, and fan-out rows marked no-reply.
- [x] 2.4 Add inbox tests proving `get_inbox` returns `need_reply`.

## 3. Verification

- [x] 3.1 Run focused Vitest coverage for mailbox schema, send_message, broadcast, broadcast_to_role, get_inbox, and tool descriptions.
- [x] 3.2 Run OpenSpec verification for `add-send-message-need-reply`.
