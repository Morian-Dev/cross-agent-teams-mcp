## Why

2026-04-18 real-world 测试实录: codex CLI 的 rmcp streamable-http client 在 idle 数十秒后返 `Transport send error: Client error: error decoding response body`, 必须重启 codex 才能恢复.  根因分两层:

1. **上游 (codex / rmcp)**: rmcp 的 HTTP connection pool 持有 stale TCP socket, idle 期间被 OS/NAT 断开后 rmcp 没感知, 下次请求把 bytes 写到已关闭 socket, 得到 partial body, HTTP decoder 崩.
2. **本 daemon 的加剧因素**: Fastify 用默认配置, `server.keepAliveTimeout = 5000ms`.  这意味着**每次**短 HTTP 请求完, 连接只给客户端 5s 的 keep-alive 窗口.  超过 5s 服务器主动断, 客户端试图复用就撞 stale socket.

我们修不了 codex 侧的 bug (不在本项目范围), 但可以做 daemon 侧的 best-effort 缓解:

- 把 `keepAliveTimeout` 拉到 **120s** (默认 5s 的 24 倍), 给 HTTP client 的连接池更长的窗口期.  多数 idle-then-reuse 场景 (< 2min) 不再撞 stale.
- 给 SSE 长连接 (GET /mcp 的 event stream, 用于 contract 订阅推送) 加应用层 heartbeat — 每 30s 对所有 attached sink 发一条 `notifications/heartbeat` 空 notification, 维持 TCP 活跃度, 避免中间盒 / OS idle 超时.

两个措施正交: 前者针对 streamable-http 短连接场景 (codex), 后者针对 SSE 长连接场景 (Claude Code / opencode 的订阅).

## What Changes

- **MODIFIED**: `src/daemon/server.ts` 在构建 Fastify 实例时显式传入 `{ keepAliveTimeout: 120000 }` (ENV `KEEP_ALIVE_TIMEOUT_MS` 覆盖).
- **MODIFIED**: `src/daemon/sse-fanout.ts` `SseFanout` 启动时注册定时器 (30s 默认, ENV `HEARTBEAT_INTERVAL_MS` 覆盖), tick 时对每个 attached sink 调 `sendHeartbeat()` 发送 `notifications/heartbeat` JSON-RPC notification.
- **MODIFIED**: `SseSink` interface 加 `sendHeartbeat(): void`.  现有一处 sink 定义 (`src/mcp/transport.ts:33-43`) 实现新方法, 走 `transport.send({ jsonrpc, method: 'notifications/heartbeat' })`.
- **ADDED**: `daemon-core/spec.md` 新 Requirement "HTTP keep-alive timeout default and env override" + "SSE heartbeat ticker on attached sinks".
- **MODIFIED**: `src/daemon/server.ts` `onClose` hook 清理 heartbeat 定时器 (防止测试 leak).
- **ADDED**: integration test 验证两条路径.
- **MODIFIED**: `docs/configs/README.md` 最后加一节 "Daemon keep-alive tuning", 说明默认值 + ENV 覆盖机制 + codex-相关限制 (坦白告知不能完全修 codex).

## Capabilities

### Modified Capabilities

- `daemon-core`: 加 HTTP keep-alive timeout default + SSE heartbeat ticker requirement.  其他 Requirement (bind address, port selection, pid file, graceful shutdown, storage unavailable envelope, bearer token auth 等) 不变.

### New Capabilities

(无)

## Impact

- **不改 DB schema**, **不改 wire format** (heartbeat 是 JSON-RPC notification, client 按 MCP spec 遇到未知 method 应 silent drop, 不干扰 contract_event / message 等业务 notification).
- **不 promise 完全修 codex**.  idle > 120s 场景仍会撞 stale socket; 那是 codex rmcp client 侧缺 retry-on-decode-error 的问题, 本 change 无能为力.  `docs/configs/README.md` 的新一节会写清楚这个局限.
- **Opencode / Claude Code 受益**: 两家订阅 SSE 流的客户端会收 heartbeat, TCP 活跃度更稳, 订阅稳定性提升.
- **性能开销**: heartbeat 每 sink 每 30s 发一条空 JSON (~60 字节), N 个 sink 时 N 字节/s.  忽略级.
- **下游无影响**: 不新增 tool, 不改既有 tool 行为.  不动 agents / messages / tasks / contracts / events 等任何 repo.
