## ADDED Requirements

### Requirement: Auto-poke prompt is a wake-up hint, not the message body

When `send_message` or `broadcast` triggers the internal auto-poke path (either during the initial fan-out or in any retry tick scheduled by the guard_failed backoff), the prompt injected into the recipient's tmux pane MUST be a short wake-up hint that identifies the sender and points the recipient at `get_inbox`. The prompt MUST NOT contain any substring of the message `body` the caller passed to `send_message` or `broadcast`.

The prompt format MUST be:

```
新邮件 from {sender_identifier}, 请调 get_inbox 查看
```

Where `sender_identifier` is:

- `{display_name} ({agent_id})` when the sender agent has a non-empty `display_name` in the `agents` table
- `{agent_id[:8]}` when `display_name` is `null`, empty, or the agent row cannot be resolved (defensive fallback)

The total prompt length MUST NOT exceed 200 characters — this is the same soft cap established by the clarified `poke` tool description (commit `2ec2e7c`). The fixed wording above already fits comfortably under that cap.

The rule applies to every poke issued by the daemon via the `autoPokeImpl` path, including:

1. Initial poke fired during `send_message` auto-poke (single recipient or `to_role` fan-out).
2. Initial poke fired during `broadcast` auto-poke fan-out.
3. Retry pokes fired by `poke-retry.ts` ticks after a prior `guard_failed`.

The rule does NOT constrain the `poke` MCP tool itself when callers invoke it directly — that remains the caller's responsibility (per the clarified `poke` tool description).

This Requirement guarantees that message bodies flow exclusively through the mailbox and are only readable via `get_inbox`, preserving the "poke is a wake-up hint, not a content channel" contract established by commit `2ec2e7c`.

#### Scenario: send_message auto-poke injects hint, not body

- **GIVEN** agents A (display_name="lead-opus") and B (display_name="worker-kimi") are registered in the same team, both with `tmux_pane_id`
- **AND** B's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message({to_agent_id: B, body: "please investigate bug #42 in the auth module"})` with default auto_poke
- **THEN** the message is persisted to B's mailbox with the full body
- **AND** the poke prompt injected into B's pane equals `"新邮件 from lead-opus (<A's agent_id>), 请调 get_inbox 查看"`
- **AND** the injected prompt does NOT contain the substring `"bug #42"` or any other substring of the body

#### Scenario: broadcast auto-poke fan-out uses identical hint format per recipient

- **GIVEN** sender A (display_name="captain"), recipients B and C (both with `tmux_pane_id`, both idle panes)
- **AND** `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast({body: "sensitive config: API_KEY=sk-xyz"})` with default auto_poke
- **THEN** the message is persisted for B and C
- **AND** B's pane receives prompt `"新邮件 from captain (<A's agent_id>), 请调 get_inbox 查看"`
- **AND** C's pane receives an identical-format prompt (same template, same sender identifier)
- **AND** neither pane's prompt contains `"API_KEY"`, `"sk-xyz"`, or any other substring of the body

#### Scenario: Retry tick reuses hint format, not the captured body

- **GIVEN** agent A sends `send_message` to B whose pane is active (guard fails) → retry scheduled
- **AND** 30 seconds later B's pane becomes idle, the first retry tick fires and guard passes
- **WHEN** the retry fires the poke via `autoPokeImpl`
- **THEN** the poke prompt is the hint format `"新邮件 from {A.display_name} (<A's agent_id>), 请调 get_inbox 查看"`, NOT the original `send_message` body

#### Scenario: Sender without display_name falls back to agent_id[:8]

- **GIVEN** sender A is registered with `display_name = null` and `agent_id = "abc12345-6789-..."` (UUID)
- **AND** recipient B is idle
- **WHEN** A calls `send_message({to_agent_id: B, body: "anything"})` with default auto_poke
- **THEN** the poke prompt equals `"新邮件 from abc12345, 请调 get_inbox 查看"` (using the first 8 characters of `agent_id`)
- **AND** the prompt does NOT contain "null" or the substring "anything"

#### Scenario: send_message and broadcast tool descriptions document the hint-only contract

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `send_message` or `broadcast`
- **THEN** each description SHOULD state that auto-poke injects only a short wake-up hint (e.g. "only injects a SHORT wake-up hint" or "短提醒") and NOT the message body
- **AND** each description SHOULD reference `get_inbox` as the retrieval path for the body
