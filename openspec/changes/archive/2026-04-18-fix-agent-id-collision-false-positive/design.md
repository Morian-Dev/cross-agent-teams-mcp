# Design — fix-agent-id-collision-false-positive

## Context

Change `build-agent-teams-mcp` (已归档) 里 `src/mcp/transport.ts:60-88` 实现了 session-id hijack detection.  意图是拦 "两个不同 client 用同一 session id", 但实现用 TCP socket 上的 Symbol 做 owner 身份, 这是一个**不稳抽象**: Node HTTP 的 keep-alive idle 超时 (默认约 5s) 会关闭 socket, 客户端下一次请求就是新 socket → 新 Symbol → 误判 collision.

2026-04-18 实测 Change 2 时首次在 real-world 路径上暴露: opencode 注册后, 用户自然语言让它"补 tmux_pane_id re-register", 中间隔几秒, HTTP keep-alive 已断, 新 socket 被误判, 返 409.  这是所有 `register_agent` upsert 流程的通用毒药.

## Goals

1. 修正 collision owner 判定, 使其基于**请求承载的凭据身份**, 而非 TCP 连接身份.
2. 保留 spec 原意的 hijack detection: 请求带 `Authorization` header 时, 不同 header 值想共用同一 session id → 拒绝.
3. 不引入 DB schema 变化.
4. 不破坏其他 requirement (Repeated register_agent upsert / Mismatched agent_id 403 / 等).

## Non-Goals

- **不做**: 重新设计 MCP session 生命周期管理或 token 认证流程.
- **不做**: 修改 `--token` CLI 参数的语义.
- **不做**: codex rmcp idle transport 问题 (Change 3b scope).
- **不做**: `register_agent` 响应加 `hint` 引导 pane_id (Change 3b / 3c scope).
- **不做**: 将 collision 扩展成 per-tool / per-method 的通用 hijack detection (现在只在 register_agent 上触发).

## Key Decisions

### 1. Owner 身份从 socket Symbol 改为 Authorization hash

**决策**: 用 `sha256(request.headers.authorization)` 的 hex 作为 sessionOwners 的 value.  daemon 用 `require('node:crypto').createHash('sha256').update(header).digest('hex')`.

**理由**:
- Authorization header 是**客户端在每个请求里自报的凭据**, 稳定跨 TCP socket.
- sha256 比直接存原文更安全 (不在内存中保留明文 token).  32 字节 hex 存取开销可忽略.
- 比较时直接字符串相等即可, 不用 constant-time compare (因为 owner 已经是 hash, 不是原密钥).

**拒绝的替代方案**:
- **User-Agent / Client-Info header 作 owner**: 不可靠 (多个客户端用同种 UA 是常见的).
- **IP address 作 owner**: NAT / proxy / localhost 全部折叠到同 IP, 不能区分.
- **请求首次的 socket Symbol**: 就是当前 bug 的根源.
- **完全删掉 collision 检查**: 放弃了 spec 的 hijack detection 语义; 启用 token 的场景失去防护.

### 2. 请求未带 `Authorization` header 时不做 collision 拦截

**决策**: 如果请求没有 `Authorization` header (或为空字符串), daemon **不写入** sessionOwners, **不检查** sessionOwners.  相当于 collision detection 在 local dev 模式下 silent opt-out.

**理由**:
- 没有 header 无法区分不同 client.  强行 hash 空字符串会让所有无 token 请求落同一 hash, 然后"同 hash 不同 session" 永远不 match — 逻辑退化.
- MVP 本地模式本来就没安全边界, hijack 不是威胁模型.
- 未来如果强制 token (另一 change), 这条分支会失效 — 对该变化无副作用.

**拒绝的替代方案**:
- **空 header hash 当作一个特殊 owner**: 会在 local dev 下继续误拦同 session 的 re-register.
- **强制必须带 token 才能 register_agent**: breaking, 与现有 `--token` 可选的 CLI 语义冲突.

### 3. 保留 sessionOwners map (不删)

**决策**: 继续保留 Map 结构, 只换 value 类型.

**理由**: hijack detection 语义保留; 数据结构本来就适合.  删掉再重建成本高且丢掉防护.

### 4. 清理: daemon 进程内 map 不持久化, 重启即清空

**决策**: 现有行为 (in-memory Map, daemon 进程生命周期) 保留.  daemon 重启后所有 session 都要重新 initialize + register_agent, 这是 MCP session 本身的语义, 与 collision 判定无关.

## Risks

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| Authorization header 里有多余 whitespace / case 差异导致 hash 不等 | 低 | 合法同 token 被误判 | 做一次 `trim()` 规范化后再 hash; 不做大小写折叠 (token 本身是 case-sensitive) |
| client 中途更换 token (轮转) 被误判 hijack | 低 | 合法 token 轮转场景被拦 | 本 MVP 不支持 token rotation; 未来做时需增强 (out of scope) |
| 某些 client 完全不发 Authorization header 却期待 collision 防护 | 极低 | 对 local dev 无防护 | 开启 `--token` 的部署才有防护; 文档提醒 |

## Alternatives Considered

1. **删掉整个 collision 检查**: 最简, 但失去 hijack 防护; 违背 spec 原意.
2. **用 `Mcp-Session-Id` + 客户端自带的 Instance-Id header 组合**: MCP spec 不定义 Instance-Id, 需要客户端侧协调; 不现实.
3. **Challenge-response 握手**: daemon 在首次 register 时返回 nonce, 后续请求需 echo; 对多 client 和 session resume 都增加复杂度, 远超本 bug scope.

## Rollout

- 修复纯 daemon 侧, 客户端 (Claude Code / opencode / codex) 不用任何改动.
- daemon 重启后新行为立即生效.
- spec 里 collision 相关的 scenario 更新, 避免新老 scenario 冲突.
- 测试: 单元测试 drive internal helper, 集成测试用真 MCP HTTP 复现 keep-alive 场景 (`http.Agent` 关掉 keep-alive 模拟新 socket).
