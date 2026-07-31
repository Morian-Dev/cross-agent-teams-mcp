## MODIFIED Requirements

### Requirement: Within-session agent_id_collision via Authorization header

When a `register_agent` tool call carries an `Authorization` request header, the daemon MUST bind that session id to the sha256 hash of the (trimmed) header value on first binding, and MUST reject any subsequent `register_agent` for the **same MCP session id** presenting a different `Authorization` value with HTTP status 409.

The 409 rejection body MUST NOT be a bare `{ "error": <string> }` object. Strict MCP clients (e.g. codex's `rmcp`) deserialize any response body as a JSON-RPC message; a bare `{ "error": "agent_id_collision" }` object matches no JSON-RPC 2.0 variant and poisons the client transport. The body MUST be either an empty body or a well-formed JSON-RPC 2.0 error object `{ "jsonrpc": "2.0", "id": null, "error": { "code": <integer>, "message": <string> } }` that a strict client can deserialize without error. (This concerns only the transport-level HTTP rejection emitted before/around tool dispatch; tool-result-level `{ error: ... }` payloads returned inside a normal 200 JSON-RPC `result` are unaffected.)

当 `register_agent` 调用的 `(device, team, name)` 已绑定到不同的 MCP session id 时, daemon MUST 将其视为身份 TAKEOVER, 而不是 collision, 但下述稳定 runtime 身份共用连接的例外除外.  TAKEOVER 必须执行以下步骤:

1. 将内存连接账本替换为新的 MCP session id.
2. 对每个旧 MCP transport 调用 SDK transport 的 `close()` 方法.  关闭 MUST 经过 transport 的 `onclose` 链, 从 daemon 的 `sessions` Map 删除旧 session, 并清理对应的 SSE fanout 和 channel-wake 绑定.
3. 继续复用 agents row 的正常 upsert 路径, 保留 `agent_id`, `registered_at`, `last_processed_event_id`, 更新 `last_seen_at`, `role`, `model` 等字段, 并向新 session 返回 `{ agent_id, team }`.
4. 对每个旧 session 输出 debug 级 takeover 日志, 日志 MUST 包含新旧 session id 和 `(team, name)`.  即使 transport 中已找不到旧 session id, 也 MUST 输出日志.

强制关闭 MUST 使用幂等 session 清理器同步撤销旧 session 的路由、连接账本和 fanout 所有权.  SDK transport 的 `close()` 仍 MUST 被调用.  如果 `close()` 同步抛错或 Promise rejection, daemon MUST 显式记录包含旧 session id 的错误, 并保留已经完成的路由撤销, 不得让旧 session 继续通过 `/mcp` 到达业务工具.

例外是**稳定 runtime 身份共用连接**, 适用于以下两种情况:

- **Codex 同 thread**: 新旧注册都声明 `agent_type='codex'`, 都携带通过校验的 `delivery.kind='codex-appserver'`, 且 `delivery.thread_id` 相同.
- **kimi 同 session**: 新旧注册都声明 `agent_type='kimi-code'`, 都携带通过校验的 `delivery.kind='kimi-server'`, 且 canonical 化后的 `delivery.base_url` 与 `delivery.session_id` 都相同.  canonical 化规则由注册持久化、共享 key 与 reconnect 查询共用: scheme/host 小写、默认端口移除 (均由 URL 解析器完成)、hash 剥离、尾部斜杠去除, 不可解析的输入退化为仅去尾斜杠.  kimi 的 endpoint URL 由 base_url 直接拼接 `/api/v1/...` 构成, 因此所有 kimi base_url 入口 — register schema、显式 kimi reconnect schema、以及 delivery 对象的写入校验 (validateDeliveryForWrite, 覆盖 `agent_type='custom'` 携带 kimi-server delivery 的旁路) — MUST 共用同一 validator 拒绝携带 query、fragment 或 userinfo 的 base_url; 判定 MUST 检查原始字符串中的 `?` / `#` 分隔符, 因为 WHATWG URL 对裸尾部 `?`/`#` 报告空 search/hash 却在序列化中保留分隔符.  canonical 化在 service 持久化边界执行, 不只在 MCP tool 层.  kimi 的 session id 只在单个 server 内唯一, 因此共享 key MUST 由 `(base_url, session_id)` 二元组构成 — 相同 `session_id` 出现在等价 URL 拼写上共享, 出现在真正不同的 `base_url` 上仍执行 TAKEOVER.  这覆盖 kimi 双引擎架构下同一逻辑 agent 的两条 MCP 连接 (TUI 进程内引擎与 server 引擎): server 侧 turn 的同名 re-register MUST NOT 关闭 TUI 侧连接.

满足任一情况时, daemon MUST 将这些 MCP session 视为同一 runtime 身份的并发连接.  内存账本 MUST 保留所有连接, MUST NOT 关闭任何已有 transport, MUST NOT 输出 takeover 日志, 且所有连接 MUST 继续以同一个 `agent_id` 调用业务工具.  任一连接关闭时, daemon MUST 只释放该连接, 其余同 key 连接保持有效.  不同的稳定 key (thread_id / base_url+session_id), 缺少对应的已校验 delivery, 或任何其他 agent 类型仍执行正常 TAKEOVER.

因此, collision 保护仍仅适用于同一 session 内的 Authorization mismatch.  跨 session 重用同一身份时, daemon 根据上述规则执行 TAKEOVER 或稳定 runtime 身份共存, 不得返回 collision.

When the request carries no `Authorization` header (or an empty one after trim), the daemon MUST NOT enforce Authorization-based collision detection.

Arriving on a different TCP socket (e.g. after keep-alive expiry) MUST NOT by itself trigger a collision.

#### Scenario: Different Authorization credentials on same session id

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX`
- **WHEN** a request with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenY` calls `register_agent`
- **THEN** response status is HTTP 409
- **AND** the response body is NOT a bare `{ "error": "agent_id_collision" }` object (it is empty or a valid JSON-RPC 2.0 error object)

#### Scenario: Cross-session same identity under different Authorization reuses agent_id

- **GIVEN** session `sess-A` has registered `(default, alice)` with `Authorization: Bearer tokenX`, then `sess-A` has been released (connection closed)
- **WHEN** session `sess-B` calls `register_agent` for `(default, alice)` with `Authorization: Bearer tokenY`
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (reuse, not collision)

#### Scenario: Cross-session takeover while prior session is still live

- **GIVEN** session `sess-A` has called `register_agent` for `(default, alice)` and the daemon's `sessions` Map still contains `sess-A`
- **AND** `sess-A` has NOT sent DELETE and its MCP transport is still open
- **WHEN** a new MCP session `sess-B` calls `register_agent` for `(default, alice)` (no Authorization header on either call)
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (200 OK, NOT 409)
- **AND** the daemon's in-memory connection binding for `('default', 'alice')` now points to `sess-B`
- **AND** the prior MCP transport for `sess-A` has been closed by the daemon
- **AND** `sess-A` no longer appears in the `sessions` Map

#### Scenario: Cross-session takeover emits a debug log

- **GIVEN** the conditions of the prior scenario hold
- **WHEN** the takeover is processed
- **THEN** the daemon emits a debug-level log line containing `takeover`, the old session id, the new session id, the team `'default'`, and the name `'alice'`

#### Scenario: 同一 Codex thread 的并发 MCP session 共存

- **GIVEN** `sess-A` 已通过 `agent_type='codex'` 和 `thread_id='T'` 注册 `(default, alice)`, 并获得 `agent_id='X'`
- **WHEN** `sess-B` 使用相同 `agent_type`, `(device, team, name)` 和 `thread_id='T'` 注册
- **THEN** `sess-B` 获得相同的 `agent_id='X'`
- **AND** daemon 不关闭 `sess-A`, 也不输出 takeover 日志
- **AND** `sess-A` 和 `sess-B` 都能继续调用 `get_inbox` 等业务工具
- **AND** 任一 session 关闭后, 另一个 session 仍保持注册状态

#### Scenario: 新 Codex thread 接管旧 thread 的所有连接

- **GIVEN** `sess-A` 和 `sess-B` 都以 `thread_id='T1'` 绑定到 `(default, alice)`
- **WHEN** `sess-C` 以相同身份和不同的 `thread_id='T2'` 注册
- **THEN** daemon 关闭 `sess-A` 和 `sess-B`
- **AND** 内存连接账本只保留 `sess-C`
- **AND** daemon 为两个被关闭的 session 分别输出 takeover 日志

#### Scenario: 同一 kimi session 的两条引擎连接共存

- **GIVEN** `sess-TUI` 已通过 `agent_type='kimi-code'` 和 `delivery={ kind:'kimi-server', session_id:'S', base_url:'http://127.0.0.1:58627' }` 注册 `(default, kimi-1)`, 并获得 `agent_id='X'`
- **WHEN** `sess-SRV` (server 引擎侧的新 MCP session) 使用相同 `agent_type`, `(device, team, name)` 和相同 `session_id='S'` 注册
- **THEN** `sess-SRV` 获得相同的 `agent_id='X'`
- **AND** daemon 不关闭 `sess-TUI`, 也不输出 takeover 日志
- **AND** 两条连接都能继续调用 `get_inbox` 等业务工具

#### Scenario: 不同 kimi session 的同名注册仍执行 takeover

- **GIVEN** `sess-TUI` 以 `session_id='S1'` 绑定到 `(default, kimi-1)`
- **WHEN** `sess-NEW` 以相同身份和不同的 `session_id='S2'` 注册
- **THEN** daemon 关闭 `sess-TUI` 并输出 takeover 日志
- **AND** 内存连接账本只保留 `sess-NEW`

#### Scenario: 相同 session_id 不同 base_url 仍执行 takeover

- **GIVEN** `sess-A` 以 `delivery={ kind:'kimi-server', session_id:'S', base_url:'http://127.0.0.1:58627' }` 绑定到 `(default, kimi-1)`
- **WHEN** `sess-B` 以相同身份、相同 `session_id='S'` 但 `base_url='http://127.0.0.1:59999'` 注册
- **THEN** daemon 关闭 `sess-A` 并输出 takeover 日志 (跨 server 的同名 session id 不是同一 runtime)
- **AND** agents row 的 delivery 指向 `sess-B` 的 base_url

#### Scenario: 等价 base_url 拼写视为同一 runtime

- **GIVEN** `sess-A` 以 `base_url='http://127.0.0.1'` + `session_id='S'` 绑定到 `(default, kimi-1)`
- **WHEN** `sess-B` 以相同身份、相同 `session_id='S'` 和 `base_url='HTTP://127.0.0.1:80/'` (大写 scheme + 默认端口 + 尾斜杠) 注册
- **THEN** 两条连接共享同一 runtime 身份, daemon 不关闭 `sess-A`, 不输出 takeover 日志
