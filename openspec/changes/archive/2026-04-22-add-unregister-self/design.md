## Context

当前 agent 生命周期只有注册, 没有退出.  `register_agent` 会同时写数据库里的 agent row, 建立 transport 层当前 session 到 `agent_id` 的绑定, 并让后续业务工具通过 `requireAgent()` 识别调用者身份.

这次需求只是补一个最小的对称退出路径, 主要解决误注册和脏 agent row 无法清理的问题.  现有数据模型里, `messages`, `events`, `contracts`, `tasks` 对 agent 的引用大多是纯文本字段, 没有强制外键级联.  这让我们可以删除 agent row, 但也必须显式处理少数真正需要清理的关联数据, 同时避免留下进行中的任务 owner 空洞.

## Goals / Non-Goals

**Goals:**
- 提供 `unregister_self` MCP tool, 只允许当前已注册 session 注销自己
- 注销成功后删除当前 agent row, 清理 contract 订阅, 并让当前 session 立即回到未注册状态
- 阻止仍持有进行中 task 的 agent 注销, 避免制造不可完成的任务

**Non-Goals:**
- 不提供删除其他 agent 的管理员接口
- 不引入软删除 / inactive 状态 / `list_agents` 过滤扩展
- 不改写历史 messages, events, contracts 或 completed tasks 中已经落盘的 `agent_id`

## Decisions

### 1. 采用物理删除当前 agent row, 不引入 soft delete

选择物理删除而不是增加 `inactive_at` 一类状态字段.

原因:
- 这次需求的核心是清理误注册和脏 row, 物理删除最直接
- 现有 `agents_identity_idx(team, name)` 让后续同名重注册天然变简单, 无需再设计 inactive row 的复活语义
- 软删除会连带改动 `list_agents`, `register_agent`, repo 查询和测试矩阵, 超出这次小功能的必要范围

备选方案是 soft delete.  放弃原因是它需要更多 schema 和查询层改造, 与本次最小变更目标不符.

### 2. 注销前阻止进行中 task, 不做 force

`unregister_self` 在发现当前 agent 仍然拥有 `status='in_progress'` 的 task 时直接拒绝, 返回 task id 列表.

原因:
- 删除 agent 后, `claimed_by` 会变成历史孤儿文本, 当前 session 也无法再完成该任务
- 加 `force` 会把责任转移给后续人工修复, 反而增加状态复杂度
- 先拒绝是最保守也最容易理解的行为

备选方案是 `force` 注销.  放弃原因是需要同步定义 orphan task 的恢复路径, 不适合这次小功能.

### 3. 数据删除与 session 释放分两层完成

实现上分为两层:
- service/repo 层负责数据库事务: 校验进行中 task, 删除 `agents` row, 删除 `contract_subscriptions`
- MCP transport/tool 层负责释放当前 session 的内存身份: 清空当前 session 的 `agentIdHolder`, 解除 fanout attach, 释放 register service 里的 identity claim

原因:
- session 绑定存在于 transport 进程内存, 不能只靠数据库删除自动失效
- 数据库事务和 session 清理职责不同, 分层更容易测试

备选方案是只删数据库, 让下一次业务工具查询时自然变成 `unknown_agent`.  放弃原因是当前 session 内存里仍可能保留旧 `agent_id`, 行为不够干净.

## Risks / Trade-offs

- [删除后历史记录仍保留旧 agent_id] → 明确规定不回写历史数据, 把 `unregister_self` 限定为“停止当前身份”, 不是“抹除历史”
- [只清理 contract 订阅, 不清理其他文本引用] → 这是有意为之, 避免扩大改动面; 通过 spec 明确历史引用允许保留
- [session 释放若遗漏某个内存路径, 可能出现半注销状态] → 用集成测试覆盖“注销后同 session 调业务工具返回 unknown_agent”

## Migration Plan

1. 新增 `unregister_self` tool 和对应 service
2. 在 transport / tools 注册路径中加入注销后的 session 释放
3. 补充数据库和 MCP 集成测试
4. 无 schema 迁移需求, 可直接发布

## Open Questions

- None
