# Design: add-claude-channel-transport

## Context

ts-agent-teams 是单 Fastify daemon + HTTP MCP (`POST /mcp` Streamable HTTP) + SQLite.  每个 agent 的 Claude Code / codex / opencode 通过 HTTP MCP 客户端连入, 由 daemon 维护 `agents`、 `messages`、 `events` 表.  现有 `poke` tool 直接在 daemon 侧 shell out 到 `tmux` 命令做键盘注入.

Claude Code Channels 的官方实现假设 channel server 是 stdio MCP 子进程, 由 Claude Code 通过 `.mcp.json` 派生, 用 `--channels plugin:<name>@<marketplace>` opt-in.  server 声明 `capabilities.experimental['claude/channel']: {}` 注册 notification listener, 通过 `notifications/claude/channel` 方法名推送事件.  事件以 `<channel source="<server>" <meta-keys...>>content</channel>` 形式注入 Claude 上下文.

两侧语境异构: daemon 在 HTTP MCP 服务端, Claude Code 的 channel server 在 stdio MCP 服务端.  本设计用独立 stdio proxy 进程做桥接.

## Goals

1.  对方 agent 是 Claude Code 且启用 channel plugin 时, `poke` 通过 channel notification 投递, 不再受 mid-turn / 用户输入干扰
2.  非 Claude Code agent (codex / opencode) 继续走 tmux poke, 对现有代码零破坏
3.  建立 transport 抽象, 未来新 agent 的类似机制只需新增一个 transport 实现
4.  channel 消息体只传 wake-up hint, 正文仍由 Claude 主动调 `get_inbox` 取, 维持单一 SoT

## Non-Goals

-  双向 reply 工具 (独立 `reply_via_channel`) — 留到后续变更
-  往 Anthropic 官方 allowlist 申请 — 开发期用 `--dangerously-load-development-channels`
-  重写 tmux poke 实现 — tmux 路径原样保留作为 fallback

## Decisions

### D1: 用独立 stdio proxy 进程桥接, 不改 daemon 架构

**选项**:

-  A. daemon 内维护 stdio MCP server, Claude Code 的 `.mcp.json` 直连 daemon 的 stdio 接口
-  B. 新增独立 stdio MCP 子进程 (channel proxy), 以 HTTP MCP client 身份连 daemon
-  C. 让 Claude Code 直连 daemon 的 HTTP MCP, 尝试在 HTTP MCP 上发 `notifications/claude/channel`

**选 B**.  理由:

-  daemon 是多 agent 共享的中央 HTTP MCP 服务, 不应为某个 Claude Code 实例专门开 stdio — A 破坏架构
-  HTTP MCP 上发 `notifications/claude/channel` 是否被 Claude Code 识别, 官方未承诺, 实测前不押注 — C 风险高
-  独立 proxy 是最小扰动: daemon 不感知 Channels 协议; proxy 承担 Channels 特定协议, 未来 Claude Code 协议变化只影响 proxy

### D2: proxy 与 daemon 的通信路径: 复用现有 MCP notification 管道

**选项**:

-  A. proxy 以普通 MCP client 身份连 daemon, 通过 Streamable HTTP 的 server→client notification 流接收事件
-  B. proxy 走独立的 `/channel-wake/:id` HTTP SSE endpoint (非 MCP)
-  C. 用 WebSocket 专门做 channel wake

**选 A**.  理由:

-  MCP Streamable HTTP 已经是稳定的 server→client notification 投递层, 契约事件用的就是它
-  不需要新 endpoint, 不需要新认证
-  新增一个 notification method (`notifications/channel_wake`) 走现有管道

### D3: channel_session_id 的生成与绑定: 协议侧 bind_channel

**选项**:

-  A. proxy 生成 csid, 通过 `notifications/claude/channel` 告知 Claude, Claude 在下次 `register_agent` 自觉把 csid 作为参数传入
-  B. proxy 通过 CLI 参数知道业主 `(team, name)`, 生成 csid 后调专门的 MCP tool `bind_channel({team, name, csid})` 做协议侧写入, 完全不依赖 Claude 的执行

**选 B**.  理由:

-  A 依赖 Claude 的执行力, 容易漏掉或走样
-  B 让 proxy 一侧全自动, Claude 无需感知 csid
-  `(team, name)` 信息在 Claude Code 启动 proxy 时已经可以通过 `.mcp.json` / CLI 参数传入 (proxy 代表的就是那个固定 agent 身份)

**流程**:

1.  用户在 `.mcp.json` 或启动命令配置: `ts-agent-teams-channel-proxy --daemon-url ... --agent-team default --agent-name alice`
2.  proxy 启动: 读/生成 csid (持久化到 `$XDG_CACHE_HOME/ts-agent-teams-channel/<team>-<name>.json`)
3.  proxy 连 daemon, `register_agent({role: '__channel_proxy__', name: 'channel-proxy-<pid>', team: 'default', model: 'proxy'})` 建立自己的 MCP session identity
4.  proxy 调 `bind_channel({team: '<agent-team>', name: '<agent-name>', channel_session_id: <csid>})`:
    -  若 agents 行已存在 → UPDATE `channel_session_id` 列 → 返回 `{ok: true}`
    -  若 agents 行不存在 → 返回 `{error: 'agent_not_registered'}`
5.  bind 失败时 proxy 以 exponential backoff (500ms 起, 封顶 30s, jitter) 重试, 直到业主 agent 完成 register_agent
6.  proxy 调 `subscribe_channel_wake({channel_session_id: <csid>})` 订阅 notification sink

### D4: Fallback 语义

`poke({target_agent_id, prompt})` 进入 dispatcher:

```
row = SELECT channel_session_id, tmux_pane_id FROM agents WHERE agent_id = target
(self-poke, cross-team 检查不变)
if row.channel_session_id 非空 AND channelWakeFanout 有 live sink:
    send_channel_wake(row.channel_session_id, {content, meta})
    成功 → return {ok, transport_used: 'claude-channel', channel_session_id}
    失败 → 继续尝试 tmux
if row.tmux_pane_id 非空:
    走现有 tmux paste flow
    return {..., transport_used: 'tmux-poke'}
return {error: 'no_transport_available'}
```

channel 成功不 double-poke tmux.  channel 失败才降级.  `transport_used` 字段用于观测和测试.

### D5: channel_wake payload 与 meta key 约束

```json
{
  "method": "notifications/channel_wake",
  "params": {
    "content": "你在 ts-agent-teams 有 N 条未读, 请调 get_inbox",
    "meta": {
      "source": "ts_agent_teams",
      "message_count": "3",
      "latest_sender": "alice",
      "latest_event_id": "42"
    }
  }
}
```

-  meta values 必须是 string
-  meta keys 必须匹配 `/^[A-Za-z0-9_]+$/`; 含 `-` 的 key 被 Claude Code 静默丢弃, 所以 daemon 侧也 silent drop (保持一致)
-  content 仅含 hint 和元数据, 不含消息正文 — 正文由 Claude 调 `get_inbox`

### D6: fanout 与 session 生命周期

-  `ChannelWakeFanout` 是独立 in-memory `Map<channel_session_id, sink>`, 不混入 `SseFanout`
-  `subscribe_channel_wake` 的 sink 从 MCP 调用的 Streamable HTTP transport 派生
-  daemon 的 MCP session `transport.onclose` 回调中, 调 ChannelWakeFanout 的 `detachBySession(sessionId)` 清理该 session 名下的所有订阅
-  re-subscribe (相同 csid) 替换旧 sink, 旧 sink 丢弃

### D7: bind_channel 的授权

-  `subscribe_channel_wake` 必须 role=`__channel_proxy__`; 其他 role 调用返回 `{error: 'forbidden_role'}`
-  `bind_channel` 同样限制 role=`__channel_proxy__` — 防止普通 agent 误写别人的 channel_session_id 造成劫持

## Risks & Trade-offs

| 风险 | 影响 | 缓解 |
|---|---|---|
| Channels research preview 协议改动 | `notifications/claude/channel` 或 `--channels` 语法变化 | 协议逻辑隔离在 proxy 单文件; daemon 不感知 channels |
| claude.ai 登录限制 | API key 用户无法用 | fallback tmux 路径保留; API key 用户不受影响 |
| mid-turn notification 行为未文档化 | "可靠"承诺可能在对方生成期间不成立 | 安排 runtime-verify 任务, 对照 idle / mid-turn 两种状态 |
| proxy 断线 | channel_wake 送不到, 自动降级 tmux | proxy 断线时主动退出, Claude Code 重启它; 期间 poke 走 tmux 路径 |
| proxy 重启丢 csid | 重启后 fanout 里 sink 已经 detach | csid 持久化到文件, 重启后 re-subscribe 相同 csid |
| 两个 transport 同时投递 | 用户同时收到两份通知 | dispatcher 成功即停, 不 cascade |
| dev 加载 `--dangerously-load-development-channels` 被组织策略禁用 | 无法本地开发 | 设计层面无解, 在 README 提示 |
| 并发多 Claude Code 实例 | 每个实例都派生 proxy, csid 需隔离 | csid 持久化文件按 `<team>-<name>.json` 隔离; fanout 按 csid 索引天然不混 |

## Alternatives Considered

1.  **Stop hook + inbox drain**: Claude Code 的 Stop hook 可返回 `{"decision": "block"}` 阻止停止并注入新 prompt.
    -  只在 turn 结束时生效, 无法 mid-turn 感知
    -  需要在每台机器的 `settings.json` 配 hook, 不如 plugin 分发
    -  Non-goal; 作为 API key 用户的 fallback 方案可单独做
2.  **桌面通知 (`osascript` / `terminal-notifier`)**: 只通知用户, 不解决自动投递
3.  **Redis / NSQ pubsub 中转**: 过度设计, 单机 SQLite + MCP notification 已够

## Migration Plan

-  数据库: MVP fresh-boot, 重启后 `agents` 表直接带 `channel_session_id` 列
-  已部署 agent: 既有 `tmux_pane_id` 仍工作; `channel_session_id` 为空时走 tmux
-  Claude Code 用户启用 channel 需要:
    -  claude.ai 登录 (非 API key)
    -  `.mcp.json` 加 channel plugin 条目, 配置 `--agent-team` / `--agent-name`
    -  启动命令加 `--channels` 和 `--dangerously-load-development-channels`
-  回滚: 删除 `.mcp.json` 的 channel plugin 条目即可; `agents.channel_session_id` 列留存无害

## Open Questions

Q1: proxy 的 channel_session_id 持久化路径, `$XDG_CACHE_HOME/ts-agent-teams-channel/<team>-<name>.json` 是否合适?  Windows 下 `$XDG_CACHE_HOME` 通常未设, 用 `%LOCALAPPDATA%` 代替.  **Phase 2 决定**.

Q2: proxy 是否应该在业主 agent 长期 offline 时自动退出?  还是保持 idle 等待?  **保持 idle** (符合"Claude Code 生命周期控制 proxy"的原则).

Q3: bind_channel 的无限重试是否会在业主 agent 永远不上线时造成资源浪费?  **可接受**, 因为 proxy 本身的存在就意味着业主 Claude 已经启动并派生 proxy, 后续 register_agent 是必然事件; 重试代价极小 (每次一个 HTTP 请求).
