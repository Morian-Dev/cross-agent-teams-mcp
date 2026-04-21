## Context

当前仓库已经完成了 delivery abstraction: `DeliverySpec` 中预留了 `codex-appserver`, `agents` 表也能持久化这类 payload, 但 write validator 仍拒绝它, poke 分派也只返回 `dispatcher_not_implemented`.  与此同时, `discuss/codex-appserver-poc/` 已证明用 websocket 连接 `codex app-server` 后, 执行 `initialize -> initialized -> thread/resume -> turn/start` 可以向运行中的 Codex TUI thread 注入一条 user message并触发模型响应.

这次 change 的核心不是重新设计 delivery 模型, 而是把已验证过的 Codex transport 补成正式能力, 并让 `register_agent` / `poke` / 文档 / 测试形成闭环.  约束包括:

- 必须继续留在当前工作目录和现有 OpenSpec 流程内完成.
- 不能读取 `.env` 类敏感文件, 因此任何 token 解析都只能走显式引用, 不能偷读本地 secrets 文件.
- 现有 `claude-channel` 和 `tmux` 语义要保持不变, 本次只补上 `codex-appserver` 路径.

## Goals / Non-Goals

**Goals:**

- 允许 `register_agent` 接受并持久化 `delivery={ kind: 'codex-appserver', thread_id, ws_url, auth_token_ref? }`.
- 让 poke 分派对 `delivery.kind='codex-appserver'` 执行真实 websocket 分派, 不再返回 stub 错误.
- 为 Codex transport 定义稳定的成功/失败语义, 让上层调用者和测试可以准确断言.
- 保持 `claude-channel` / `tmux` 路径兼容, 不破坏现有自动 poke 流程.
- 补齐相应测试和 Codex 配置文档.

**Non-Goals:**

- 不实现长连接池或多 target 共享 websocket 复用.
- 不实现 busy 态智能 `turn/steer`; 初版只走 `turn/start`.
- 不把 `bind_channel` 合并进 `register_agent`; Claude 路径保持现状.
- 不引入新的 secret store 或读取本地敏感文件; `auth_token_ref` 只解析为进程环境变量名.

## Decisions

### 决策 1: Codex dispatcher 采用 “每次 poke 建立短连接”

**选**: 每次 `poke` 到 `codex-appserver` 时创建一个短生命周期 websocket client, 完成一次注入后立即关闭.

**为什么**:

- 实现最小, 不需要额外的连接管理器, 重连策略, 心跳, 以及 daemon 关闭时的资源清理复杂度.
- 更符合当前 `poke` 的语义: 单次显式唤醒, 不需要维护长期订阅态.
- 失败边界更清晰, 测试可直接针对单次请求进行 stub 和断言.

**替代方案**:

- 常驻长连接并按 `thread_id` 复用: 运行效率更高, 但要维护 session 生命周期和断线恢复, 现在不值得.

### 决策 2: `auth_token_ref` 解释为环境变量名

**选**: 当 `delivery.auth_token_ref` 存在时, dispatcher 读取 `process.env[auth_token_ref]` 作为 bearer token.  若变量不存在或值为空白, 在任何网络动作前直接失败.

**为什么**:

- 避免在仓库内引入新的 secret 文件约定, 也符合“不读取 `.env`” 的约束.
- 与 Codex 现有 `--remote-auth-token-env <ENV_VAR>` 心智模型一致.
- 让测试可以通过临时环境变量覆盖完成验证.

**替代方案**:

- 把 `auth_token_ref` 解释为文件路径或 keychain key: 更复杂, 还会碰到权限和跨平台实现问题.

### 决策 3: 新增独立的 Codex app-server dispatcher 模块

**选**: 新增一个专门模块, 例如 `src/mcp/codex-appserver-dispatch.ts`, 由 `transport-dispatch.ts` 调用.

**为什么**:

- 当前 `transport-dispatch.ts` 已经承担 channel / tmux 路由职责, 再把 websocket 协议细节塞进去会快速失控.
- 独立模块更利于单测, 可以直接 stub websocket client 与 JSON-RPC 序列.

**替代方案**:

- 直接在 `transport-dispatch.ts` 内部硬写 websocket 流程: 文件耦合过高, 不利于继续扩展其他 transport.

### 决策 4: 初版协议序列固定为 `initialize -> initialized -> thread/resume -> turn/start`

**选**: dispatcher 固定执行这 4 步, 注入文本走 `turn/start`, input 形状与 POC 一致.

**为什么**:

- 这是仓库里已经被 POC 证明可行的最小路径.
- 可以先把 “可达” 做成正式能力, 再迭代 busy 态和更复杂的 steer 语义.

**替代方案**:

- 预检 thread busy 并在某些情况下改走 `turn/steer`: 行为更聪明, 但会引入额外分支和新的失败模式.

### 决策 5: `codex-appserver` 是显式 delivery, 失败时不自动回退到 tmux

**选**: 当 target 明确注册为 `delivery.kind='codex-appserver'` 时, daemon 只尝试 Codex transport.  如果 websocket 连接或远端 RPC 失败, 直接返回 Codex transport 错误, 不自动回退 tmux.

**为什么**:

- `delivery.kind` 应该是 authoritative routing, 否则显式注册的 transport 和实际执行路径可能不一致.
- 自动回退虽然“更能发出去”, 但会让调用方难以判断消息究竟是被 app-server 处理还是被 tmux 粘贴.

**替代方案**:

- 失败后回退到 `tmux_pane_id`: 用户体验上更宽容, 但分派语义不稳定, 也不利于测试.

### 决策 6: `poke` 返回 transport-aware 成功结果

**选**: `poke` 成功结果按 transport 区分:

- tmux: `{ ok: true, transport_used: 'tmux-poke', pane_id, pane_tail_before, pane_tail_after }`
- Claude: `{ ok: true, transport_used: 'claude-channel', channel_session_id }`
- Codex: `{ ok: true, transport_used: 'codex-appserver', thread_id }`

Codex 失败时返回机器可判别的 transport-specific 错误码, 如 `codex_connect_failed`, `codex_initialize_failed`, `codex_resume_failed`, `codex_turn_start_failed`, `missing_auth_token`.

**为什么**:

- 现有返回已经对 Claude 和 tmux 区分了 `transport_used`, 补齐 Codex 最自然.
- 上层 auto-poke, 测试, 以及未来运维排障都需要知道到底用了哪条通道.

## Risks / Trade-offs

- **[风险] Codex app-server 协议未来变化** → 缓解: 将协议细节集中在独立 dispatcher 模块和单测中, 便于后续只改一处.
- **[风险] `turn/start` 在 busy thread 上失败或排队语义变化** → 缓解: 初版先把错误原样映射为 `codex_turn_start_failed`, 后续再做 `turn/steer` 优化.
- **[风险] 新增 websocket client 依赖或实现复杂度** → 缓解: 限定为单 transport 使用, 并用窄接口隔离在 dispatcher 模块里.
- **[风险] token 引用丢失导致生产不可用** → 缓解: 在连接前做显式环境变量检查, 返回带 `ref` 的错误 detail.
- **[取舍] 不自动回退 tmux** → 失去某些“兜底可达性”, 但换来更稳定, 更可观测的 delivery 语义.

## Migration Plan

1. 先更新 spec 与实现, 让 `register_agent` 接受 `codex-appserver`.
2. 增加 dispatcher 与路由接线, 让 `poke` 对 Codex target 可用.
3. 补上测试和文档, 包括 Codex 配置, app-server 启动方式, 以及 `auth_token_ref` 的环境变量约定.
4. 部署时无需数据库迁移; 本 change 复用已有 `delivery_kind` / `delivery_payload` 列.

回滚:

- 代码回滚后, 数据库中已有的 `delivery_kind='codex-appserver'` 行仍可被旧版本读取, 但旧版本会重新回到 reject / stub 行为.
- 若需要彻底回退使用路径, 调用方可重新 `register_agent` 为 `delivery={ kind: 'none' }` 或使用已有 tmux / Claude delivery.

## Open Questions

- `codex app-server` 在需要认证时, 具体 websocket 鉴权头部形状是否稳定为 `Authorization: Bearer <token>`?  初版按此实现, 若实际协议不同需在实现阶段核实.
- 是否需要在 `send_message` 的 auto-poke 中也支持 `codex-appserver` target?  当前设计默认通过复用 `poke()` 路径自然获得, 但仍需测试覆盖.
