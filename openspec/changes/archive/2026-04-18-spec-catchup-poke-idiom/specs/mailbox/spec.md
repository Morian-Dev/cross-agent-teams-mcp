## MODIFIED Requirements

### Requirement: send_message requires exactly one recipient field

`send_message({to_agent_id?, to_role?, body, subject?})` MUST require either `to_agent_id` or `to_role`, but not both. If both are provided, the daemon SHALL return `{ error: 'ambiguous_recipient' }`. If neither is provided, it SHALL return `{ error: 'missing_recipient' }`.

`send_message` MUST NOT auto-poke the recipient(s).  The tool persists the message to the mailbox and returns; the recipient sees it on their next natural turn via `get_inbox`.  Callers MAY chain `poke({ target_agent_id, prompt })` immediately after a successful `send_message` to inject a wake-up prompt into the recipient's tmux pane when immediate attention is needed.  The `send_message` tool's MCP description SHOULD advise callers of this "fire-and-forget + optional poke follow-up" idiom.

#### Scenario: Both recipient fields given

- **WHEN** client calls `send_message({to_agent_id:'X', to_role:'frontend', body:'hi'})`
- **THEN** response is `{ error: 'ambiguous_recipient' }`

#### Scenario: No recipient field given

- **WHEN** client calls `send_message({body:'hi'})`
- **THEN** response is `{ error: 'missing_recipient' }`

#### Scenario: Successful send_message does not auto-poke recipient

- **GIVEN** recipient `sess-B` is registered in the same team with `tmux_pane_id='%99'`
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'hi'})`
- **THEN** the message is persisted to `messages` with a new `event_id`
- **AND** the daemon MUST NOT internally invoke the `poke` tool or any tmux command on pane `%99`
- **AND** the response shape is `{ message_id, event_id, recipients: [...] }` with no poke-related fields

#### Scenario: send_message tool description advises poke follow-up

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHOULD reference the `poke` tool by name
- **AND** SHOULD indicate that poke is optional / for urgent delivery, not automatic

### Requirement: broadcast excludes sender

`broadcast({body, subject?})` SHALL fan-out to every agent in the caller's team except the caller itself.

`broadcast` MUST NOT auto-poke any recipient.  A broadcast producing N messages MUST NOT trigger N poke calls; doing so would spam every pane on routine updates.  Callers MAY iterate the recipient list returned by `broadcast` (or by `list_agents`) and poke targets individually when a broadcast is genuinely urgent for them.  The `broadcast` tool's MCP description SHOULD make the per-recipient-poke convention explicit.

#### Scenario: Sender not in recipients

- **GIVEN** team 'default' has agents `sess-A`, `sess-B`, `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`

#### Scenario: broadcast does not auto-poke any recipient

- **GIVEN** team 'default' has agents `sess-A`, `sess-B`, `sess-C`, all with `tmux_pane_id` set
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** messages are persisted for `sess-B` and `sess-C`
- **AND** the daemon MUST NOT invoke the `poke` tool or any tmux command on `sess-B`'s or `sess-C`'s panes

#### Scenario: broadcast tool description advises per-recipient poke

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `broadcast`
- **THEN** the description string SHOULD reference the `poke` tool by name
- **AND** SHOULD indicate per-recipient or per-target iteration is the convention (no mass-poke)

## ADDED Requirements

### Requirement: Fire-and-forget delivery contract for send_message and broadcast

Both `send_message` and `broadcast` MUST follow a fire-and-forget delivery contract with four clauses:
1. The tool MUST persist to the mailbox (and event outbox) and return synchronously.
2. The tool MUST NOT invoke the `poke` tool, `tmux` CLI, or any other mechanism that actively wakes the recipient(s).
3. The tool's MCP description MUST indicate that immediate wake-up, when desired, is the caller's responsibility via an explicit `poke` follow-up.
4. Future changes MUST NOT introduce auto-poke on these tools without a new behavioral-change proposal; this is the M1 ("caller decides urgency") design position.

#### Scenario: No auto-poke on send_message regardless of recipient tmux_pane_id state

- **GIVEN** recipient `sess-B` has a valid `tmux_pane_id` registered
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'any'})`
- **THEN** no `poke` entry, no tmux-injection event, no side effect beyond mailbox persistence occurs

#### Scenario: No auto-poke on broadcast regardless of recipient tmux_pane_id states

- **GIVEN** multiple recipients, some with `tmux_pane_id` and some without
- **WHEN** the sender calls `broadcast({body:'any'})`
- **THEN** persistence happens for all recipients
- **AND** no poke/tmux side effect happens for any of them, even the ones with usable panes
