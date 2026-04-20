## Context

当前 `agents` 表有一列 `channel_session_id: TEXT NULL`, 由 `bind_channel` MCP tool 写入; 非 NULL 表示该 agent 通过 Claude Code 的 `claude/channel` experimental capability 接收 poke.  daemon 在 poke 时, 按 `channel_session_id != NULL` 走 `ChannelWakeFanout`, 否则回退到 tmux 或报 `no_transport_available`.

即将接入 Codex CLI 的 `app-server` websocket 作为第二种投递后端.  POC (见 `discuss/codex-appserver-poc/`) 验证了关键协议路径 `initialize → initialized → thread/resume → turn/start` 端到端可行, 且句柄形状是 `{ thread_id: UUID, ws_url: string, auth_token_ref?: string }`, 与 Claude channel 的单个 session id 不同构.  单列模型无法容纳; 强行塞同一列会把类型判别耦合到调用点.

同时用户反馈希望"身份注册 + 绑定投递通道"收敛到同一个 skill/入口 — 现状分 `register_agent` 和 `bind_channel` 两步只是 Claude 侧协议约束 (proxy 是另一个进程) 的副产物, 对 Codex 接入无此约束, 应合并.

## Goals / Non-Goals

**Goals:**

- 把 agents 表的投递通道字段泛化为 `DeliverySpec` (kind + payload), 使新增 transport 后端仅改 payload schema, 不改表结构.
- 在 `register_agent` 入参上提供可选 `delivery` 字段, 让一次调用能完成"身份 + 通道"绑定 (对 Codex 接入至关重要).
- 保持 Claude channel 路径的运行时行为完全不变 (bind_channel 入参/出参 / ChannelWakeFanout / proxy 启动顺序), 仅底层写入去向改变.
- 为 `list_agents` 返回项新增 `delivery` 字段, 同时保留派生的 `channel_session_id` 字段以兼容现有消费者.

**Non-Goals:**

- 不实现 Codex app-server 分派器 — 那是下一个 change.
- 不删除旧 `channel_session_id` 列 — 保留为 legacy, 由后续 change 在所有消费者迁走后再清理.
- 不合并 `bind_channel` 到 `register_agent` (即不弃用 bind_channel) — 只让它底层写入新字段, 保持入口兼容.
- 不改动 `claude-channel-transport` 的对外协议 (MCP capability, JSON-RPC notification method 名, ChannelWakeFanout 语义) — 仅改 daemon 内的读写路径.

## Decisions

### 决策 1: 双列 (`delivery_kind`, `delivery_payload`) vs 单 JSON 列

**选**: 双列.

`delivery_kind TEXT NOT NULL DEFAULT 'none'` + `delivery_payload TEXT NULL` (JSON).

**为什么**:

- `kind` 单独出列让"按 kind 过滤 / 索引 / 分派"不需要解析 JSON.  未来 `SELECT * FROM agents WHERE delivery_kind='codex-appserver'` 是 O(log n), 单 JSON 列则要全表扫 + json_extract.
- 默认值 `'none'` 让老行迁移到新 schema 无需 UPDATE 即合法 (见"迁移计划").
- JSON payload 承载 kind-specific 数据, 新增 kind 不动表结构.

**替代方案**:

- 单 JSON 列 (`delivery TEXT`): 简单但 kind 查询要解析 JSON; 拒绝.
- 每 kind 一列 (`claude_session_id`, `codex_thread_id`, …): 列膨胀, 新 kind 要改 schema; 拒绝.

### 决策 2: 列是否 NOT NULL

**选**: `delivery_kind NOT NULL DEFAULT 'none'`, `delivery_payload NULL`.

`kind='none'` 语义上表示"无投递通道, poke 时回退到 tmux 或 fail", 与旧 `channel_session_id IS NULL` 行为等价, 且让"没通道"是一等 kind 而非 NULL 魔法值.

### 决策 3: `channel_session_id` 列保留还是删除

**选**: 保留作 legacy read-only column, 不再独立写入.

本 change 只做引入 + 迁移回填, **不删**旧列.  `list_agents` 返回的 `channel_session_id` 字段从 `delivery` 派生填充 (仅当 `kind='claude-channel'` 时), 其它情况为 null.  `bind_channel` 继续可调用, 但底层写入 `delivery_*` 两列而非 `channel_session_id` 列.  旧列在表上保留为 read-only, 后续 change 验证所有消费者已迁走再清理.

**为什么分两步**:

- 避免本 change 同时做 schema 变更 + 读写路径改写 + 字段删除, 降低回滚成本.
- 现有 tests (`tests/agents-channel-session-id-column.test.ts` 等) 的断言形式决定它们需要单独一轮迁移, 不宜和 schema 改一起做.

### 决策 4: 迁移策略

**选**: 启动时迁移 (additive + backfill), 不走 versioned migration 文件.

daemon 启动时执行:

1. `ALTER TABLE agents ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'none'` (幂等: 先 PRAGMA table_info 判断)
2. `ALTER TABLE agents ADD COLUMN delivery_payload TEXT`
3. 一次性回填: `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', channel_session_id) WHERE channel_session_id IS NOT NULL AND delivery_kind='none'`

SQLite 不支持 `DROP COLUMN` 在老版本上, 但本 change 不删列, 只加; ALTER ADD COLUMN 是支持的.  `better-sqlite3` 版本已足够.

### 决策 5: `DeliverySpec` 在 TypeScript 侧的形状

**选**: 判别联合 (discriminated union):

```ts
type DeliverySpec =
  | { kind: 'none' }
  | { kind: 'claude-channel'; channel_session_id: string }
  | { kind: 'codex-appserver'; thread_id: string; ws_url: string; auth_token_ref?: string }
```

- 持久化形式: `delivery_kind = spec.kind`, `delivery_payload = JSON.stringify(payload)` (payload = spec 剥掉 kind 字段; `none` kind 的 payload 为 NULL).
- 在 `none` 与其它 kind 之间穿梭应走一个窄 `fromRow(row) / toRow(spec)` helper, 不让调用方拼 JSON.
- 本 change 的 `kind` 全集只含 `'none' | 'claude-channel'`; `'codex-appserver'` 在 TypeScript 类型定义中**预留**, 但验证器只接受前两种 (写入时拒绝 codex-appserver, 避免读到 payload 无 handler 时 panic).

### 决策 6: `register_agent.delivery` 的语义

**选**: 可选字段, 缺省即 `{kind: 'none'}`.  本 change 的 register_agent MCP 工具新增入参校验, 但**不改变既有默认行为** (Claude proxy 启动后仍走 bind_channel 绑通道, 而不是在 register_agent 传 delivery).  `delivery` 字段的实际使用在下一个 change (Codex 接入) 才启用 — 在本 change 里先打开字段, 保证 schema 和 tool 协议一致, 为下一 change 铺路.

### 决策 7: 兼容层 — `list_agents.channel_session_id` 的派生

**选**: 从 `delivery` 字段派生:

```ts
const channel_session_id =
  delivery.kind === 'claude-channel' ? delivery.channel_session_id : null
```

所有 `list_agents` 的现有消费者继续工作, 直到它们改用 `delivery`.

## Risks / Trade-offs

- **[风险] 迁移回填对大量历史行较慢** → 缓解: 这是单次启动开销, 现有部署 `agents` 表规模是单位数到百级, 不阻塞; 回填用单条 `UPDATE ... WHERE channel_session_id IS NOT NULL` 限定范围.

- **[风险] 两套写入路径临时共存 (旧 `channel_session_id` 列 + 新 `delivery_*` 两列)** → 缓解: 本 change 明确旧列**只读**, 所有 write path 通过 `AgentsRepo` 的 helper 只写新列; grep `UPDATE agents ... channel_session_id` 应无剩余; 通过 AgentsRepo 单点 API 封死写入面.

- **[风险] 测试断言依赖 `channel_session_id` 列值** → 缓解: 测试断言改为检查 `list_agents` 返回字段或 AgentsRepo API 返回; 不直接 `SELECT channel_session_id FROM agents` (当前 `agents-channel-session-id-column.test.ts` 要改成断言 `delivery_kind / delivery_payload` 列 + 读取派生的 `channel_session_id`).

- **[取舍] `kind='none'` vs NULL** → 选 `kind='none'` 是为了让分派 switch case 完整, 否则每个读取点都要先判 NULL 再判 kind.

- **[取舍] `delivery` 作可选字段而非必填** → 选可选是为了兼容 Claude proxy 当前"先 register_agent, 后 bind_channel"的两步流程不变.  如改成必填, proxy 流程要重构, 超出本 change 范围.

## Migration Plan

**部署顺序**:

1. 升级 daemon (本 change 的代码), 启动时自动跑 ALTER ADD + 回填 SQL.
2. 回填完成后, bind_channel 继续可调用, 但底层已写新列; 旧 `channel_session_id` 列不再有 write.
3. 如果 daemon 启动后发现 `PRAGMA table_info('agents')` 已有 `delivery_kind` 列, 跳过 ALTER; 回填仅对 `delivery_kind='none' AND channel_session_id IS NOT NULL` 的行执行一次.

**回滚**:

- 代码回滚: 老 daemon 读不到 `delivery_kind` 列是 OK 的 (SQLite 对未知列宽容, 但 `SELECT *` 风格会多字段), 关键 write path 仍然写 `channel_session_id` 列 → 兼容.  实测需要跑一轮老 daemon 启动测试确认 (放到 tasks 里).
- 数据回滚: 新增的两列不清理也无害 (默认值 'none' 不影响旧读取路径).  真要清理则手动 `ALTER TABLE agents DROP COLUMN delivery_kind; DROP COLUMN delivery_payload` (需要 SQLite ≥ 3.35, better-sqlite3 当前版本满足).

## Open Questions

- **OQ-1 (订阅语义)**: POC 观察到外部 client 需要显式 `thread/resume` 才能加入 app-server 的 notification 分发名单.  Codex 分派器实现时 (下一 change) 是否要为每个 poke 起临时连接并 resume, 还是维持长连并复用订阅? → 不阻塞本 change.

- **OQ-2 (busy 态分派)**: POC 观察到 `turn/start` 在 thread busy 时看似被排队 (消息最终到达).  Codex 分派器是否用 `thread/status` 预检并在 busy 时 fallback 到 `turn/steer`, 还是永远 `turn/start`? → 不阻塞本 change.

- **OQ-3 (payload 密钥引用)**: Codex kind 的 payload 里 `auth_token_ref` 是一个引用 (例如环境变量名或 keyring key), 不是明文 token.  这个 ref 的解析约定 (谁负责解, daemon 还是 dispatcher) 在本 change 不定, 由下一 change 的 dispatcher spec 定.
