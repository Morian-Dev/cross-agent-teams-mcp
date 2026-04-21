## Context

当前 `register_codex_self` 的实现先连接 app-server, 再对 `thread/loaded/list` 返回的每个 thread 执行 `thread/resume`, 然后在“恰好只有一个可恢复 thread”时直接注册这个 thread.  这个流程默认“全局唯一 resumable thread = 当前调用者自己的 thread”, 但 MCP transport 只向工具暴露了当前 MCP session id, 没有暴露 Codex caller 的 `thread_id`.  因此 daemon 无法从协议层证明某个 loaded thread 属于当前调用者.

实际后果是:

- 同机存在其他 Codex remote 会话时, `register_codex_self` 可能把当前 agent 错绑到别人的 thread.
- 当 app-server 的 loaded-thread 视图和 rollout 运行态短暂不同步时, 工具会返回 `codex_resume_failed`, 但真正的问题不是“当前 thread 恢复失败”, 而是“工具压根不知道哪个 thread 才是当前调用者的”.

本 change 的目标不是发明新的 Codex 身份发现协议, 而是在现有能力下把工具改成安全语义.

## Goals / Non-Goals

**Goals:**

- 移除 `register_codex_self` 对“当前 thread 可自动推断”的错误假设.
- 让调用者通过显式 `thread_id` 完成确定性注册.
- 在缺少 `thread_id` 时安全失败, 并返回足够的排查信息, 而不是继续猜测.
- 保留现有的 tmux pane 持久化行为: 显式 `tmux_pane_id` 优先, 否则 best-effort 检测, 检测失败不影响成功注册.

**Non-Goals:**

- 不尝试从 Codex 私有本地状态, sqlite, 日志或 session 文件反推当前 thread.
- 不修改 `codex-appserver` transport 的 poke 行为.
- 不引入新的 daemon <-> Codex side-channel 来自动传播 `thread_id`.
- 不改动 `register_agent` 的低层显式 `delivery.kind='codex-appserver'` 路径.

## Decisions

### 决策 1: `register_codex_self` 增加显式 `thread_id`

**选**: 工具新增可选入参 `thread_id`.  一旦提供, 工具只校验并恢复这个 thread, 不再扫描并挑选其它 thread.

**为什么**:

- 这是唯一能在现有协议边界内做到确定性绑定的输入.
- 改动集中在 `register_codex_self` 的入参, 服务逻辑, 测试和文档, 不影响 `register_agent` 的能力面.

**替代方案**:

- 继续依赖“唯一 resumable thread”自动猜测: 已被实际现场证明不安全.
- 读取 Codex 私有 sqlite / 日志 / 进程 fd 来反推 thread: 对外部实现细节耦合过深, 不适合写进正式能力.

### 决策 2: 缺少 `thread_id` 时返回新的显式错误

**选**: 当调用者未提供 `thread_id` 时, 工具仍可调用 `thread/loaded/list` 和 `thread/resume` 生成一个可供排查的 resumable thread 列表, 但最终返回 `{ error: 'thread_id_required', detail: { ws_url, thread_ids } }`, 不执行注册.

**为什么**:

- 直接失败能阻止错误注册.
- 附带 `thread_ids` 能帮助调用者或运维排查和手工确认, 不需要把工具变成黑盒失败.

**替代方案**:

- 缺少 `thread_id` 时直接报 generic error: 更安全, 但排障体验差.
- 只有在唯一 resumable thread 时才自动成功: 仍然保留错误前提, 不能解决这次问题.

### 决策 3: 保留现有 tmux pane 行为, 但只在成功注册后生效

**选**: tmux pane 逻辑不参与 thread 归属判断.  它仍然只负责“成功注册后把 pane id 一并持久化”, 其优先级和 best-effort 规则保持不变.

**为什么**:

- pane id 不是 Codex thread identity, 不应再被误用为 thread 归属证据.
- 这样能把本 change 聚焦在 thread 绑定, 避免一次性改太多轴线.

**替代方案**:

- 尝试用 tmux pane / tty / cwd 去推断 thread: 仍然缺少协议级强绑定, 容易产生新的误判.

## Risks / Trade-offs

- **[Risk] 用户体验比原来多一步** → Mitigation: 文档和错误 detail 明确告诉调用者需要提供 `thread_id`, 并返回可用线程列表帮助确认.
- **[Risk] 现有依赖自动探测的调用会回归失败** → Mitigation: 这是有意的安全收紧; 测试和 README 明确标记新语义.
- **[Risk] `thread_id_required` 暴露 thread 列表会让调用方“继续猜”** → Mitigation: 文档明确这些 id 仅供确认和调试, 工具本身不再代替调用者做选择.

## Migration Plan

1. 更新 OpenSpec delta spec, 把 requirement 从“autodetect current thread”改成“explicit thread binding or safe failure”.
2. 修改 `register_codex_self` 输入 schema, 服务实现和错误类型.
3. 更新测试, 覆盖显式 `thread_id` 成功和缺少 `thread_id` 的安全失败.
4. 更新 README 与 Codex 配置文档.

回滚:

- 如需回滚, 恢复旧实现和旧 spec 即可, 无数据库迁移.
- 已注册的 `delivery.kind='codex-appserver'` 行不受影响, 因为 payload 形状没有变化.

## Open Questions

- Codex CLI / app-server 后续是否会正式暴露“当前调用者的 thread identity”?  如果会, 未来可以在新的 change 中恢复真正安全的自动识别.
