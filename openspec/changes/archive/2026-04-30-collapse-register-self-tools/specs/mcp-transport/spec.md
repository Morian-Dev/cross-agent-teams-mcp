## MODIFIED Requirements

### Requirement: MCP server initialize returns instructions field with xats abbreviation and team-default convention

The daemon's `McpServer` instance SHALL declare a non-empty `instructions` field (via the `ServerOptions.instructions` constructor argument) so that every MCP session's `initialize` response exposes it to the calling client / LLM.  The `instructions` string MUST convey at least these two conventions, in any prose form the implementer chooses:

1. **Abbreviation**: `xats` is an abbreviation for `cross-agent-teams`; when users or other agents mention `xats`, they refer to this MCP server (the `cross-agent-teams-mcp` daemon) and its registered tools.
2. **Team default on registration**: when invoking `register_agent`, if the end user has not explicitly specified a `team`, the LLM client SHOULD pass its current working directory as `project_dir` so the daemon can derive a project-scoped default team (instead of falling back to the global `'default'` team).

The `instructions` string MUST be a single plain string (the MCP protocol slot is not a list).  It MUST be present on every session; it MUST NOT be gated on runtime state.  The string MUST NOT name `register_claude_self` or `register_codex_self` (those tools are removed; see `agent-registry`'s "register_claude_self and register_codex_self tools removed from MCP tool surface" requirement).

#### Scenario: initialize response includes instructions string

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `initialize` response contains a non-empty `instructions` field whose value is a string

#### Scenario: instructions content mentions xats abbreviation

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string contains the literal substring `xats`
- **AND** the `instructions` string contains the literal substring `cross-agent-teams`

#### Scenario: instructions content mentions project_dir team default convention

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string contains the literal substring `project_dir`
- **AND** the `instructions` string mentions (case-insensitively) both `team` and the intent of using the current working directory when `team` is unspecified

#### Scenario: instructions do not name removed self tools

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string does NOT contain the literal substring `register_claude_self`
- **AND** the `instructions` string does NOT contain the literal substring `register_codex_self`
