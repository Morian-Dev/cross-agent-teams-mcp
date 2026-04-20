# Codex app-server poke POC

验证: 外部进程可以通过 `codex app-server` 的 websocket 协议, 向一个用户 TUI 正在使用的 thread 注入一条 user message, 触发模型回应.

这是为 `cross-agent-teams-codex-channel` 桥接方案做的可行性验证. 跑通了再写 OpenSpec change.

## 拓扑

```
终端 A                终端 B                  终端 C
codex app-server      codex --remote ws       tsx poke.ts
   (server)        ▶     (TUI client)      ▶    (external client)
       ▲                                           │
       └─────────── ws://127.0.0.1:8799 ◀──────────┘
```

- app-server 绑在 127.0.0.1 → loopback 免鉴权 (`--ws-auth` 仅对非 loopback 强制)
- TUI 和 POC 脚本都是 app-server 的 client, 共享同一 thread 空间

## 运行步骤

### 1. 终端 A: 启动 app-server

```bash
codex app-server --listen ws://127.0.0.1:8799
```

保持前台运行.  看到 listen 日志即可.

### 2. 终端 B: 启动 TUI 并新开一个对话

```bash
codex --remote ws://127.0.0.1:8799
```

进入 TUI 后, 随便打一句话让它进入一个 thread (例如 `hi`), 让模型回一次.  不关闭, 留着.

### 3. 终端 C: 跑 POC

```bash
cd /Users/jtianling/workspace/cross-agent-teams-mcp-workspace/cross-agent-teams-mcp
npx tsx discuss/codex-appserver-poc/poke.ts
```

脚本会:
1. 连 app-server
2. 发 `initialize`
3. 发 `thread/loaded/list` 拿到当前 in-memory 的 threadIds
4. 挑第一个(就是终端 B 那个 TUI 的 thread)
5. 发 `turn/start` 注入文本: `POC poke from external client`
6. 订阅 30 秒内的 server notifications, 打印到 stdout

也可以显式指定 threadId 和消息内容:

```bash
npx tsx discuss/codex-appserver-poc/poke.ts <threadId> "自定义消息"
```

环境变量:

```bash
APP_SERVER_URL=ws://127.0.0.1:9000 npx tsx discuss/codex-appserver-poc/poke.ts
```

## 观察点 (验证通过的证据)

| 观察项 | 期望 |
|---|---|
| `initialize` response | 无 error, 返回 server capabilities |
| `thread/loaded/list` | data 数组非空, 至少包含 TUI 对应的 threadId |
| `turn/start` response | 无 error, 返回 `turn` 对象 |
| 终端 C 打印的 notifications | 能看到 `turn/started`, `item/agentMessage/delta` (模型回应流), `turn/completed` |
| 终端 B (TUI) | 视觉上能看到 `POC poke from external client` 作为 user 消息被加入对话, 然后模型回应 |

**端到端通过的判定**: 终端 B 的 TUI 里出现 POC 注入的消息, 且模型回应了它.

## 风险点 (POC 要专门试)

### A. 并发 turn
如果 TUI 正在一个 turn 中 (模型还没回完), 外部再 `turn/start` 会如何?

预期两种结果之一:
- 服务端拒绝, 返回 error (应使用 `turn/steer` 注入当前 turn)
- 排队, 等当前 turn 完成后再起

**测法**: 在 TUI 提一个耗时问题(让它慢慢想), 立刻在终端 C 跑 POC, 看 `turn/start` 返回.

### B. 鉴权 (loopback 之外)
当前用 loopback 免鉴权.  生产中 daemon 可能不在同一机器, 需要 `--ws-auth capability-token --ws-token-file <path>`.  POC 不覆盖这步, 但协议 help 中的字段已确认存在:

- `--ws-auth capability-token`
- `--ws-token-file <PATH>` (absolute path, 文件内容即 bearer token)
- `codex --remote --remote-auth-token-env <ENV_VAR>` 传 token

### C. threadId 的外部流通
POC 用 `thread/loaded/list` 挑第一个, 生产里 daemon 怎么拿到"特定 agent 身份"对应的 threadId?

设计答案(下一阶段 OpenSpec change 要覆盖): TUI 启动后, 由用户(或 TUI 自动)调一次 `cross-agent-teams-mcp` 的 register-agent 工具, 同时上报当前 threadId.  daemon 存入 `agents.delivery_payload`.  poke 时读这一列.

## 产出

- 如果 4 个观察点都过: 写 OpenSpec change `refactor-delivery-abstraction` (第一步).
- 如果在某点失败: 记录失败现象 + 具体 error, 决定是找绕路, 还是改方案.

## 清理

POC 跑完后关掉终端 A 和终端 B 即可.  无持久化副作用(thread 本来就在 `~/.codex/sessions/` 里, POC 只是往里加了一轮对话).
