## MODIFIED Requirements

### Requirement: reconnect tool description guides invocation on reconnect phrases

The `reconnect` tool's MCP description SHALL instruct the agent to invoke it when the user asks to reconnect or re-register to xats — covering at least the phrases "reconnect xats", "re-register xats", "重连 xats", and "重新注册 xats" — passing the Claude UI process id (`$PPID`) as `ui_pid`. The description SHALL ALSO route automatic re-establishment after a resume / channel re-attach by **whether the agent still remembers its own `(team, name)`**, NOT by whether `$PPID` is unchanged (a condition the agent cannot self-evaluate):

- When the agent does NOT remember its `(team, name)` (for example after a context clear, where `$PPID` is unchanged), the description SHALL guide `reconnect({ ui_pid: $PPID })` as the path to recover identity by process id and rebind the new `channel_session_id` in one step, preferred over the `bind_channel`→`register_agent` fallback.
- When the agent DOES remember its `(team, name)` (for example after closing Claude Code and resuming the conversation, where `$PPID` has changed but the context survived), the description SHALL guide `register_agent` with the remembered `(team, name)` and the current `$PPID` instead of `reconnect` — because `reconnect` reverse-looks-up the changed `$PPID`, finds no match, and returns `need_register`.

#### Scenario: Description lists the trigger phrases and the ui_pid source

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it names the reconnect/re-register trigger phrases (including the Chinese "重连 xats" / "重新注册 xats")
- **AND** it states that `ui_pid` is the Claude UI process id (`$PPID`)
- **AND** it states that `reconnect` is the path to re-establish after a context clear when the agent no longer remembers its `(team, name)` and `$PPID` is unchanged

#### Scenario: Description routes remembered-identity resume to register, not reconnect

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it states that an agent which still remembers its `(team, name)` after a restart + resume (changed `$PPID`) should `register_agent` with that remembered identity rather than call `reconnect`
- **AND** it does NOT instruct the agent to use `reconnect` "even when it still remembers its `(team, name)`"
