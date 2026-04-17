# Design — add-poke-mcp-tool

## Context

2026-04-17 的 e2e 实测 (见 conversation trace at Change 1 Phase 1 讨论) 已证明: 外部进程 `tmux paste-buffer -t %<pane> -p + send-keys Enter` 能把任意文本投递到 Claude Code / opencode / codex 的输入框, 被接收 agent 当作"用户输入"触发模型 reasoning + tool calls.  此能力如果作为 MCP tool 内嵌到 daemon, 就能让"跨 agent 主动唤醒" 成为 in-band 协议, 无需外部 bridge 进程.

Change 1 已落地 `agents.tmux_pane_id` 字段, 为 daemon 侧"按 target_agent_id 查 pane"提供事实源.  本 change 只需在 MCP tool 层 + tmux cli 包装层补齐.

## Goals

1. 新 MCP tool `poke`, 签名极简: 只接 `target_agent_id` + `prompt`.
2. 单次 tool call 只送一次 key, retry 策略由调用方 LLM 自律 (最多 3 次在 tool description 里写作 soft hint).
3. 成功返回前后 pane 快照 (tail 8 行), 让 LLM 一次调用就能看到运行时反应, 无需再 poll list_agents / get_inbox.
4. 权限边界严格: 同 team / 不戳自己 / target pane_id 必须已 set.
5. daemon 对 tmux cli 的调用必须 无 shell 注入, 用 `child_process.execFile` 参数数组.
6. 无 tmux 环境下, tool 返 `tmux_unavailable`, 其他 tool 完全不受影响; integration test 在无 tmux 环境下 skip.

## Non-Goals

- **不做 retry loop**: daemon 单次 tool call 只做一次 paste+Enter.  重试由 LLM 决定.
- **不做 counter / rate-limit**: 本 MVP 不拦滥用, 靠调用方 LLM 自律 + 后续 change 再加.
- **不做 pane 活性主动巡检**: 只在 poke 当次返回的 tmux error 里反应 pane_dead, 不后台扫.
- **不支持 `pane_id` 直传 override**: 所有 pane 解析必须经过 agents 表, 一条路径.
- **不做 prompt sanitization**: 接受任意字节串, 仅限制长度.  信任同 team 内部通讯.
- **不新增 events outbox 条目**: poke 是即时同步调用, 不产生 persisted event (`send_message` 才有 events 条目).

## Key Decisions

### 1. Retry / 现场反馈语义: Minimal retry + 双快照 (见 Phase 1 Q1/Q2)

**决策**: 单次 tool 调用 daemon 只做一次 paste+Enter; 返回 `pane_tail_before` 和 `pane_tail_after` (各 ~8 行) 让 LLM 判断是否需要再次 poke.

**理由**:
- 用户明确 "LLM 应该能判断是否有问题" — daemon 不应代替 LLM 做启发式验活.
- 双快照比单 after 快照更精确: LLM 能对比 "我送 prompt 前" vs "我送完后" 的 diff, 直接看到 agent 是否在输入框吸收了文本、是否开始 reasoning 输出.
- 双 capture 成本 2 次 tmux 命令 < 100ms, 可忽略.

**拒绝方案**:
- Daemon 内部 retry loop: 复杂度高, 且"对方还没响应"的判断没有可靠启发式 (agent reasoning 慢 vs agent 死掉 vs 输入框满) — 留给 LLM 判断.
- Counter 防滥用: YAGNI, MVP 靠 LLM 自律.

### 2. 权限边界 (见 Phase 1 Q3/Q4)

**决策**: caller 与 target 必须同 team; self-poke (target_agent_id == caller agent_id) 拒绝; target 的 `tmux_pane_id` 必须 non-NULL.

**拒绝方案**:
- 允许 self-poke: 会有 LLM 把"poke 自己"当作 reasoning-trigger 的潜在死循环.  测试场景可以直接写测试文件, 无需借 self-poke.
- 允许 cross-team: 与现有 list_agents / send_message 的 team scoping 不一致.

### 3. 错误 envelope (见 Phase 1 Q5)

**决策**: 所有错误返 `{ error: <code>, detail?: string }`.  `detail` 携带 tmux stderr 或 Node error message, 供 LLM debug.

**Error code 清单**:

| code | 何时返回 | 是否带 detail |
|---|---|---|
| `unknown_agent` | caller 自己未 register (session 无 agent 身份) | 否 |
| `unknown_target` | `target_agent_id` 在 agents 表中不存在 | 否 |
| `tmux_pane_not_set` | target.tmux_pane_id IS NULL | 否 |
| `self_poke_denied` | target_agent_id == caller.agent_id | 否 |
| `cross_team_denied` | target.team != caller.team | 否 |
| `prompt_too_long` | prompt UTF-8 字节长度 > 8192 | `{ max: 8192, got: N }` (结构化而非字符串) |
| `tmux_unavailable` | `execFile('tmux', ['-V'])` 非 0 或 ENOENT | stderr |
| `pane_dead` | tmux 命令返回 "can't find pane" / pane_dead option = 1 | tmux stderr |
| `tmux_cmd_failed` | 其他 tmux cli 未预期错误 | stderr + stage (which cmd) |

**理由**: 用户明确要带 detail (开发体验好, 本项目 MVP 本地运行, 路径/env 泄露不是威胁).

### 4. daemon tmux 调用序列

**顺序**:

1. `tmux capture-pane -t <pane_id> -p -S -8` → stdout → `pane_tail_before` (8 行 tail, bracketed by `-p`)
2. Write prompt 字节串到 `tmux load-buffer -b <scoped_buf> -` (从 stdin, 避免 set-buffer 的命令行长度限制) — buffer 名用 `poke-<random-6>` 避免同 tmux server 上多 daemon 互踩
3. `tmux paste-buffer -b <scoped_buf> -t <pane_id> -p -d` (`-p` bracketed paste, `-d` 粘贴后删除 buffer)
4. `setTimeout(400ms)` (让 agent TUI 吸收 paste)
5. `tmux send-keys -t <pane_id> Enter` → 提交输入框
6. `setTimeout(400ms)` (让 agent 开始 reasoning 输出第一帧)
7. `tmux capture-pane -t <pane_id> -p -S -8` → stdout → `pane_tail_after`

**理由**:
- `load-buffer -` 从 stdin 喂, 避免大 prompt 被 shell arg 长度 (`ARG_MAX` ~ 200KB 但 tmux 实际有更紧限制) 截断, 同时完全规避 shell injection.
- `paste-buffer -p` 用 bracketed paste: 让 TUI (Claude Code / opencode / codex) 把整段当一次 paste 处理, 不会被中途的 newline/ctrl 字符意外触发行为.
- `paste-buffer -d` 送完即删 buffer, 不累积内存.
- 两次 400ms sleep: 前者让 paste 显示到 TUI 输入框, 后者让 agent 的"处理中"帧出现.  实测 300ms 在低性能机器偶尔丢帧, 400ms 稳定.  不暴露为参数.
- 所有步骤用 `child_process.execFile` 而非 `exec`, 避免 shell 解释元字符.

### 5. tmux 可用性探测

**决策**: `src/daemon/tmux-cli.ts` 导出 `isTmuxAvailable()`, 在 daemon boot 阶段调一次缓存结果.  `poke` tool 调用时第一步检查该缓存, 假若 false 直接返 `{ error: 'tmux_unavailable' }`, 不再走后续.

**测试侧**: `tests/poke-e2e.test.ts` 调用 `isTmuxAvailable()` 作为 skip gate.  CI 里无 tmux 的 runner 自动跳过 integration test, 但 unit test (mock child_process 的) 永远运行.

### 6. tool description 的 LLM-facing hint

**决策**: MCP tool 的 description 字段写:

> Wake another agent in the same team by injecting `prompt` into its tmux pane.  Returns both pre/post tmux capture tails so you can decide whether to retry.  Soft recommendation: retry at most 3 times for the same target within a short window; if still unresponsive, fall back to `send_message` or escalate to the human.  Requires the target agent to have registered with `tmux_pane_id`.

**理由**: LLM 读 tool description 时会把 "soft recommendation" 当行为准则.  实测 Claude / GPT / Gemini 都能理解并遵循这种柔性约定.

### 7. 新 capability 命名 `agent-interrupts`

**理由**:
- `poke` 只是一种 interrupt (唤醒).  未来可能加 `cancel_agent` / `stop_streaming` / `reset_context` 等.
- `mcp-transport` 只管 transport 层, 不合适挂业务 tool.
- `agent-registry` 只管身份/liveness, poke 是行为不是身份, 独立更清晰.

**拒绝方案**: `agent-wake` (太窄), `agent-bridge` (bridge 概念已被外部脚本词占用, 歧义).

## Risks

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| target agent TUI 正在 streaming 输出时 paste+Enter 被吞 | 中 | poke 显示成功但 agent 未处理 | capture_after 能让 LLM 看到"输入框仍是原状态", 自然 retry |
| tmux load-buffer 从 stdin 喂 utf8 中 `\x00` 字符可能被截断 | 低 | 罕见 prompt 尾部被截 | 约定 prompt 不含 `\x00`; 如出现则 `{ error: 'tmux_cmd_failed', detail: 'null byte in prompt' }` |
| 同 daemon 多并发 poke 同一 pane 会让 TUI 看到两次 paste | 低 | agent 输入框混乱 | 默认不加锁 (最坏情况 LLM 看 pane_tail_after 发现乱了, 自己 recover); 未来可加 per-pane-mutex |
| tmux server 崩溃时所有 poke 全 fail | 低 | 所有 pane 失联 | `tmux_unavailable` error 明确告知, LLM / 用户决定 restart tmux |
| daemon 跑在 docker / 无 tmux 的 host | 低 | 整个 poke 能力失效 | `isTmuxAvailable()` 首次调用返 false, 永久 `tmux_unavailable`; 部署文档注明要求 |
| LLM 不自律, 无限 retry | 中 | tmux server 过载 / 对方 pane 被 spam | MVP 不做 rate-limit, 留给将来 change; 实际 LLM 看到 pane_tail_after 无变化会有判断力 |
| 8 KB 上限对某些 agent 来说仍超出 TUI 输入框 buffer | 低 | paste 被 TUI 截 | 文档说明 "推荐 ≤2KB, 硬上限 8KB"; LLM 看 pane_tail_after 发现截断可 fall back 到 send_message |

## Alternatives Considered

1. **外部 bridge 脚本 poll events 表 + 自动 send-keys**: 测试阶段已验证可行但耦合松散, 另需 bridge 进程生命周期管理.  放弃.
2. **在 send_message 里叠加 auto-notify (M2/M3 模式)**: Change 2 开场讨论已明确否定.  保留 M1 分离语义.
3. **把 poke 做 batch version (`poke_many({ targets[], prompt })`)**: YAGNI.  LLM 想 batch 直接循环调就行.
4. **把 capture 的 tail 行数变成参数 `tail_lines?`**: YAGNI + 小 scope, 未来 change 再加.

## Rollout

- Phase 2 所有任务通过后, 重启 daemon, 新 tool 自动注册到 MCP server.
- 三家 agent 在下次 list tools 时自动看到 `poke`.
- 不需要 DB schema 变化, 不需要 client 端配置改动.
- `docs/configs/README.md` 新增 "Cross-agent poke scenario" 说明调用路径.
