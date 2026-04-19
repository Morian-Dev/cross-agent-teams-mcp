## Why

E2E 测试 (2026-04-19) 暴露: `broadcast` 当前默认 `auto_poke=false`, 在落 mailbox 后无人被叫醒. 当前部署的所有 team 成员数都很小 (典型 2-4 个 agent), "广播 = 全员 spam" 的担忧不成立; 反过来, 默认不 poke 让"广播"事实上等于"消息黑洞" — 收件方除非主动 `get_inbox`, 否则永远不知道. 用户口语原话: "只要不 poke, 那就相当于发消息没有 agent 知道."

LLM 收到广播后不会自发 chain `poke` 已经被 `add-auto-poke-on-send` 证实是协议层的硬伤 (memory 文件 `project_fire_and_forget_tools_need_poke_hint.md` 也记录过同类问题). `send_message` 已经在那个 change 里翻成"默认 auto_poke + guard + 失败后 retry-backoff"; broadcast 必须对齐, 否则用户必须每次手动补 fan-out poke, 与初衷 (服务端把"正确行为"做成默认) 相悖.

## What Changes

- **MODIFIED**: `src/mcp/broadcast.ts` `BroadcastService.broadcast()` 默认值翻转: `auto_poke` 缺省时按 `true` 处理 (改 `if (input.auto_poke !== true)` → `if (input.auto_poke === false)`). 显式 `false` 仍可 opt-out.
- **MODIFIED**: `src/mcp/tools.ts` `broadcast` tool description 重写: 把 "Does NOT auto-poke by default" 改为 "Auto-pokes every eligible recipient by default (per-pane parallel quiet-guard)" + 保留 retry-backoff 描述. 删掉 "auto_poke:true to poke" 的 opt-in 措辞.
- **MODIFIED**: `tests/broadcast-auto-poke.test.ts` — 把"default broadcast 不 poke"用例改成"default broadcast 走 fan-out auto-poke", 增加 "explicit `auto_poke:false` 关闭" 用例; 复用现有"explicit auto_poke:true with active pane → retry" 用例 (无需改).
- **ADDED**: `tests/broadcast-auto-poke.test.ts` 新场景: "explicit `auto_poke:false` 完全跳过 fan-out", 验证不调 guard / 不调 poke / `retry_scheduled:false`.
- **MODIFIED**: `openspec/specs/mailbox/spec.md` 通过 delta 反向更新 — 见下方 Capabilities 段.
- **MODIFIED**: `docs/configs/README.md` 更新 "Auto-poke on send" 节, 把 broadcast 行为从"opt-in"改为"opt-out".

## Capabilities

### Modified Capabilities

- `mailbox`:
  - REMOVED Requirement: `Broadcast auto-poke is opt-in` (由 `add-auto-poke-on-send` 引入, 默认 false). 替换为下面的新 Requirement.
  - MODIFIED Requirement: `broadcast excludes sender` — 移除"`broadcast` MUST NOT auto-poke any recipient"段落和 2 个相关的 anti-poke 场景, 仅保留"sender not in recipients"原本场景.
  - MODIFIED Requirement: `Fire-and-forget delivery contract for send_message and broadcast` — 重命名为 `Fire-and-forget delivery contract for send_message`, 移除 broadcast 相关条款和场景 (broadcast 不再适用此契约).
  - ADDED Requirement: `Broadcast auto-poke default with parallel fan-out` — 新默认 true; opt-out via `auto_poke:false`; 复用 send_message 的 quiet-guard + retry-backoff 行为.

### New Capabilities

(无)

## Impact

- **不改 DB schema**: 默认值翻转纯参数层.
- **不改 wire format**: `broadcast` 的 response 字段 (`poked`, `poke_skip_reasons`, `retry_scheduled`, `retry_delays_s`) 全部已经存在 (由 `add-auto-poke-on-send` + `add-auto-poke-retry-backoff` 引入). 客户端解析无需改.
- **不改 fan-out 实现**: `auto-poke-fanout.ts` 已经 `Promise.all` 并行, 且已经处理 retry 排队. 本 change 只翻 default, 不动核心逻辑.
- **行为变化**:
  - 调用方语义: `broadcast({body})` 之前 = "纯落盘", 之后 = "落盘 + 对每个 idle 收件人 poke". 这是显式的 behavioral change.
  - 性能: broadcast 同步等待 `POKE_QUIET_MS` (default 2000), 与 send_message to_role 同等. 测试用 env 调到 100ms.
  - opt-out 路径: 凡是 LLM 判断"这只是 status update 不需要打扰"时, 显式传 `auto_poke:false`.

## Archive 顺序约束

本 change 的 spec delta 引用了 `Broadcast auto-poke is opt-in` Requirement (REMOVED 操作). 该 Requirement 由 `add-auto-poke-on-send` change 引入, 至本 change 创建时尚未 archive 到 main spec. 因此:

1. 必须先 archive `add-auto-poke-on-send` (使其 ADDED Requirements 进入 main spec).
2. 再 archive 本 change `add-auto-poke-on-broadcast` (使 REMOVED + ADDED 操作生效).

如果顺序颠倒, 本 change 的 REMOVED 找不到目标会失败. 请在 sync/archive 阶段确认顺序.
