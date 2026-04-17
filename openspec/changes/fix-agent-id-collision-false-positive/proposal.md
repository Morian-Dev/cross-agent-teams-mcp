## Why

2026-04-18 实测 Change 2 (`add-poke-mcp-tool`) 端到端时抓到真 bug: opencode 注册完一次后, 按自然语言 prompt 要求"自己补上 tmux_pane_id 重新 register 一次", 结果 daemon 返 `{ error: 'agent_id_collision' }` HTTP 409.  追源到 `src/mcp/transport.ts:60-88`: daemon 把 "是否同一个 owner" 的判定挂在 **TCP socket 上的 Symbol** (`tokenFor(req)`).  HTTP keep-alive 在 Node 默认 ~5s idle 后断开, 客户端下一次请求用新 socket, daemon 看到 `sessionOwners.get(sessionId) !== connToken` 就拦下, 误判成 session hijack.

spec `agent-registry/spec.md` 的 "agent_id collision across sessions returns 409" 原意是 **防 session id hijack**, 但现行实现把 HTTP 短连接场景当成攻击, 让同一 MCP session 的合法 re-register 在 daemon 运行几秒后就不可用.  real-world 上, 所有使用 `register_agent` upsert metadata (如补 `tmux_pane_id`) 的流程都会撞这个坑.

## What Changes

- **MODIFIED**: collision owner 判定从 TCP socket Symbol 换成**Authorization header 的 sha256 hash**.  同一 token = 同一 client, socket 换不换不相关.
- **MODIFIED**: 请求未携带 `Authorization` header 时, 不做 collision 拦截 (信任 `Mcp-Session-Id`; 无凭据可区分 client 身份).  请求带 `Authorization` header 时才基于其 sha256 hash 做 hijack 检测.  与 daemon 启动是否加 `--token` 参数无关 — 判定一律在请求级别.
- **MODIFIED**: agent-registry spec 的 `agent_id collision` requirement body 和 scenario 集合 — 原 "different TCP session" 改为 "different Authorization credential", 并新增 "same credential across sockets" / "no token mode never triggers collision" 两条 scenario.
- **ADDED**: 一条回归测试, 复现 2026-04-18 实测路径 (同 session id + 同 Authorization header + 不同 TCP socket), 断言 register_agent 成功.

## Capabilities

### Modified Capabilities

- `agent-registry`: 重写 `agent_id collision across sessions returns 409` requirement 的 body + scenarios.  其他 requirement (Agents table schema / register_agent / Repeated register_agent / list_agents / Mismatched agent_id 403 / last_seen_at / Tmux pane id persistence) 不变.

### New Capabilities

(无)

## Impact

- **Breaking?**: 否.  当前行为本来就 buggy (HTTP keep-alive 断开就误拦), 没人能真正依赖它.  修复后行为和 spec 原意一致.
- **Security**: 请求带 `Authorization` header 时 collision detection 反而更准 (不再靠 socket identity 这种不稳抽象, 靠 credential hash).  无 header 的请求不判 collision — 无法区分 client, 本来也没安全边界, 不算 regression.
- **DB**: 无变化.
- **代码**: 修改 `src/mcp/transport.ts` (sessionOwners 从 `Map<sessionId, Symbol>` 改成 `Map<sessionId, string>`, `tokenFor` 去掉或改名为 `authHashFor`).
- **下游依赖**: 其它 change (poke, 未来 bridge 能力) 都受益, 因为依赖 re-register 补字段或重放的流程终于可用.
