## Context

当前 `poke` 和 auto-poke 共用同一套 transport dispatch, 只认识两类目标: Claude Code channel sink, 与 tmux pane。  这让 opencode 即使已经通过 MCP 接入本 daemon, 仍然只能依赖 `tmux_pane_id` 才能被唤醒。  

我们已经确认 opencode 提供官方 server/session 接口, 外部 client 可以对指定 session 发起 prompt。  这意味着 opencode 更适合走一个 session-based transport, 而不是复用 Claude 的 `notifications/claude/channel` 协议。  

这个 change 同时受以下约束:

- 仓库当前已经把 `channel_session_id` 作为一个专用 transport 字段落在 `agents` 表中。
- 当前 `dispatchPoke()` 同时服务 direct `poke` 与 mailbox auto-poke, 所以 transport 改动必须覆盖两条路径。
- 本仓库默认是本机可信模型, 但 daemon 不应因为一个 agent 上报任意 URL 而引入 SSRF 面。
- 不应把 secrets 持久化进 SQLite。

## Goals / Non-Goals

**Goals:**

- 让 opencode agent 可以在没有 tmux pane 的情况下被 daemon 直接 poke。
- 定义一个自绑定流程, 使 opencode host 能把自己的 `base_url` 和 `session_id` 写入当前 agent 行。
- 复用现有 transport abstraction, 让 direct `poke` 与 auto-poke 共享相同选择逻辑。
- 保持现有 Claude channel 优先行为不变, 不破坏已存在的 `channel_session_id` 路径。
- 将新 transport 的失败语义做成可测试的错误 envelope。

**Non-Goals:**

- 不在本 change 中引入通用 `delivery_payload` 抽象, Codex 等其他 transport 以后单独设计。
- 不支持非 loopback 的 opencode server 地址。
- 不在本 change 中持久化 bearer token, token 文件路径, 或其他 secrets。
- 不处理 opencode 正在进行中的 turn steering, cancel, 或队列管理。

## Decisions

### 1. 用显式列保存 opencode binding, 不做泛化 payload

`agents` 表新增两列:

- `opencode_base_url TEXT NULL`
- `opencode_session_id TEXT NULL`

`list_agents` 也返回这两个字段, 便于诊断 transport 绑定状态。

选择显式列, 而不是 `delivery_payload JSON`, 原因是:

- 当前 schema 已经有 `channel_session_id` 这种 transport-specific 列, 延续现有模式最小变更。
- typed columns 更易写测试, 也更利于 SQL 查询和迁移。
- 本次只落 opencode, 先把行为跑通比过早抽象更重要。

备选方案是加 `delivery_kind + delivery_payload`, 优点是可扩展。  但这会把一次 transport 增量扩成 delivery framework 重构, 超出本 change 范围。

### 2. 新增 `bind_opencode_session` 自绑定工具, 不扩展 `register_agent`

新增 MCP tool:

`bind_opencode_session({ base_url: string, session_id: string })`

行为与 `bind_channel` 对齐:

- 调用方必须已注册, 否则返回 `{ error: 'unknown_agent' }`
- `base_url` 必须是 trim 后非空的绝对 URL
- `session_id` 必须是 trim 后非空字符串
- `base_url` 主机必须是 loopback, 仅接受 `127.0.0.1`, `localhost`, 或 `::1`
- 校验通过后, 更新调用方自己的 `agents.opencode_base_url` 与 `agents.opencode_session_id`

不把这两个字段放进 `register_agent`, 原因是:

- `register_agent` 已承担 identity upsert, 再叠 transport binding 会混淆职责。
- opencode session 可能在 register 之后才可知, 自绑定流程更符合实际启动顺序。
- 现有 Claude channel 已经采用 `register_agent` 之后再 `bind_channel` 的两阶段模式, 保持一致更好理解。

备选方案是让 `register_agent` 接受 opencode metadata。  这种方式参数面更大, 也会把已有关于 "`register_agent` 不是 transport 列 writer" 的约束打破, 因而放弃。

### 3. transport 选择顺序为 `claude-channel` → `opencode-server` → `tmux-poke`

更新 `dispatchPoke()` 的目标查询与分发顺序:

1. 若 `channel_session_id` 有 live sink, 继续优先走 Claude channel。
2. 否则若 `opencode_base_url` 与 `opencode_session_id` 都存在, 尝试走 opencode server transport。
3. 若 opencode transport 不可用或未配置, 且 `tmux_pane_id` 存在, 再回退到 tmux。
4. 若三者都不可用, 返回扩展后的 `no_transport_available`。

这样设计的理由是:

- 保持当前 Claude host 的行为与优先级不变。
- opencode transport 是一次真实 session 调用, 成本高于内存 fanout, 所以排在 channel 后。
- tmux 仍然是最后兜底, 兼容已有 agent。

备选方案是让 opencode 优先于 channel。  但那会改变已有 Claude host 的无网络快路径, 没有收益。

### 4. opencode 通过 async prompt 交付 poke, 不走 silent message

opencode transport 使用官方 server/session prompt 接口, 语义上等价于:

- 向已存在 session 注入一条 user prompt
- 立即启动该 session 的一次回复

对应到当前系统语义, 这与 tmux paste + Enter 最接近。  因此 direct `poke` 与 auto-poke 都应走 async prompt, 而不是仅插入 message/no-reply。

备选方案是 silent message。  这样虽然更像“提醒”, 但不会触发 agent 行为, 与当前 `poke` 语义不一致, 因而放弃。

### 5. loopback-only, 且错误分类显式化

由于 daemon 会主动发 HTTP 请求, 本 change 只接受 loopback `base_url`, 以避免 agent 借 `bind_opencode_session` 让 daemon 访问任意内网地址。

新增错误分类:

- `invalid_opencode_base_url`
- `opencode_session_not_bound`
- `opencode_unreachable`
- `opencode_session_not_found`
- `opencode_session_busy`
- `opencode_request_failed`

其中:

- metadata 缺失属于配置错误
- 连不上 server 属于可重试环境错误
- 找不到 session 说明 binding 已过期
- session busy 表示目标正在处理 turn, 本 change 明确不上 `steer`

## Risks / Trade-offs

- `[Busy session semantics may differ across opencode versions]` → 用单独的 `opencode_session_busy` 错误包住, 不把忙碌态混成通用网络失败。
- `[Bound session metadata may become stale after opencode restart]` → 通过自绑定覆盖旧值, 并在 `session_not_found` 时提示重新绑定。
- `[Schema grows more transport-specific over time]` → 本 change 先接受显式列的局部最优, 等第二个 server-based transport 真正落地后再统一抽象。
- `[loopback-only limits remote daemon/operator setups]` → 作为有意识的安全边界保留, 远程地址与 auth 支持以后单开 change。

## Migration Plan

1. 数据库迁移新增 `opencode_base_url` 与 `opencode_session_id`, 默认 `NULL`。
2. 更新 `AgentsRepo.list()` 与 `list_agents` 返回结构。
3. 新增 `bind_opencode_session` tool 与 service, 完成自绑定写入。
4. 新增 opencode client/helper, 接入 `dispatchPoke()`。
5. 更新 direct `poke` 与 mailbox auto-poke 的测试矩阵。
6. 文档补充 opencode 的绑定说明。

回滚策略:

- 代码回滚后, 新增列保留但不再被读取, 属于安全的向后兼容残留。
- 若需要软禁用, 可以先移除 `bind_opencode_session` 注册并让 dispatch 忽略 opencode 列。

## Open Questions

- opencode server 对“session 正忙”的稳定错误码是否足够固定, 以便实现中精确区分 busy 与 generic request failed。
- 是否需要后续补一个 `unbind_opencode_session()` 工具, 供 agent 主动清理过期绑定。  本 change 先不阻塞这一点。
