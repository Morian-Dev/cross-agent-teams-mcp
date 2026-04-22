# Design: 强标识驱动的 runtime 绑定

Status: Draft.
Date: 2026-04-21.
Scope: `register_agent`, `register_codex_self`, `detect_tmux_pane`, `agents` runtime metadata.

## 背景

当前 `register_agent` 会在注册时 best-effort 调 `detect_tmux_pane`, 然后把结果写入 `agents.tmux_pane_id`.  这条链路在单实例场景还能工作, 但在下面这些真实场景里会失效:

- 同一个 `cwd` 下同时开多个 agent session.
- 同一个 tmux session 内同时跑 `claude-code`, `opencode`, `codex`.
- 某些客户端实际发 MCP 的进程并不是 UI 进程, 自己没有 tty.
- 同名标题, 相同 `cwd`, 相同命令模式, 导致 detector 平分.

根因不是 detector 没被调用, 而是服务端在缺少强标识时只能做全局猜测.  `cwd`, `tty`, `title_contains` 都只能是弱信号, 没法作为最终身份键.

## 目标

1. 让 tmux pane 绑定尽量基于可验证的强标识, 而不是全局猜测.
2. 在同仓库多 session, 同 tmux session 多 agent 的情况下仍然能稳定命中正确 pane.
3. 不破坏现有 `agents.tmux_pane_id` 的消费路径, `poke` 和 auto-poke 尽量少改.
4. 明确区分 "已校验绑定" 与 "启发式猜测", 避免静默写入错误 pane.

## 非目标

1. 不试图从单独的业务 `thread_id` 直接反推出 tmux pane.
2. 不要求所有客户端第一期都支持自动上报全部 runtime 信息.
3. 不在第一期重写 `poke` transport 优先级.

## 核心判断

### 1. `pid` 比 `thread_id` 更适合作为强标识

如果服务端拿到的是 UI agent 的真实进程 id, 就可以走下面这条校验链:

`ui_pid -> tty -> tmux pane_tty -> pane_id`

这条链路通常是唯一的.  相比之下:

- `cwd` 可能重复.
- `title` 可能重复.
- `tty` 如果不是直接来自 UI 进程, 也可能缺失.
- 业务 `thread_id` 通常只是应用层会话 id, 除非客户端额外维护 `thread_id -> ui_pid` 映射并上报, 否则 daemon 无法直接使用.

### 2. 要求客户端自报强标识, daemon 负责校验

这件事不应该继续靠 daemon 全局枚举 tmux pane 猜测.  更稳的模型是:

- 客户端告诉 daemon, "我认为我当前 UI 在这个 pane 上, 对应这个 `ui_pid`."
- daemon 本地验证这条声明是否成立.
- 验证通过后才写 `tmux_pane_id`.

这和现有 `bind_channel`, `bind_opencode_session` 的思路一致, 都是 "稳定注册" 与 "运行时绑定" 分两步.

## 方案概览

### 方案选择

推荐新增一个专门的 runtime 绑定工具, 而不是继续把复杂逻辑塞进 `register_agent`.

推荐新工具名:

`bind_runtime_identity`

理由:

1. `register_agent` 当前负责 team/name/model/delivery 的 identity upsert, 职责已经清晰.
2. runtime 绑定是高频变化, 可重绑, 可失效的瞬时信息, 跟注册不是同一层语义.
3. 现有系统已经接受 "register 后再 bind transport" 的模式, 如 `bind_channel`, `bind_opencode_session`.

## 新工具设计

### `bind_runtime_identity`

建议输入:

```ts
{
  agent: 'codex' | 'claude-code' | 'opencode' | 'custom',
  ui_pid?: number,
  ui_tty?: string,
  tmux_pane_id?: string,
  process_pattern?: string,
  session_hint?: string,
  cwd?: string,
  title_contains?: string,
}
```

建议返回:

```ts
{
  ok: true,
  tmux_pane_id: string,
  verification_mode:
    | 'verified_pid_tty_pane'
    | 'verified_pid_tty_unique_pane'
    | 'verified_tty_pane',
  tty: string,
  ui_pid?: number,
}
```

或显式错误:

```ts
{ error: 'unknown_agent' }
{ error: 'invalid_ui_pid' }
{ error: 'pid_not_found' }
{ error: 'pid_has_no_tty' }
{ error: 'agent_process_mismatch' }
{ error: 'invalid_ui_tty' }
{ error: 'tmux_unavailable', detail: string }
{ error: 'tmux_pane_not_found' }
{ error: 'pid_pane_tty_mismatch', detail: { pid_tty: string, pane_tty: string } }
{ error: 'tty_maps_to_no_agent_process' }
{ error: 'ambiguous_tty_match', candidates: [...] }
```

### 输入约束

至少满足下面一种:

1. `ui_pid` 存在.
2. `ui_tty` 与 `tmux_pane_id` 同时存在.

仅靠 `cwd`, `title_contains`, `session_hint` 不允许完成绑定, 它们只能当辅助 sanity check 或 debug 信息.

## 校验算法

### 路径 A: `ui_pid` 优先, 这是主路径

1. 读取 `ps -p <ui_pid> -o tty=,command=`.
2. 校验该进程命令是否匹配 `agent` 或 `process_pattern`.
3. 如果 tty 为空, `?`, 或 `ttys???` 不可用, 返回 `pid_has_no_tty`.
4. 读取 `tmux list-panes -a` 建立 `pane_id -> pane_tty`.
5. 找到 `pane_tty == pid_tty` 的 pane.
6. 如果调用方还声明了 `tmux_pane_id`, 则要求它与第 5 步一致, 否则报 `pid_pane_tty_mismatch`.
7. 校验通过后写入该 pane.

这条路径的优势是, 唯一性来自 OS 进程和 tty, 不是来自目录或标题.

### 路径 B: `ui_tty + tmux_pane_id`, 这是降级路径

适用于客户端拿不到 `ui_pid`, 但能明确知道 UI tty 和 pane id 的情况.

1. 校验 `ui_tty` 格式.
2. 校验 `tmux_pane_id` 存在且其 `pane_tty` 等于 `ui_tty`.
3. 用 `ps -t <ui_tty>` 检查该 tty 上至少有一个进程匹配 `agent` 或 `process_pattern`.
4. 通过后允许绑定.

这条路径比纯启发式强, 但仍弱于 `ui_pid`.

### 路径 C: 旧的 `detect_tmux_pane`, 保留为 debug, 不再是主注册路径

`detect_tmux_pane` 继续保留, 用于:

- 用户手工调试.
- 客户端开发阶段查看候选 pane.
- 无强标识时辅助诊断.

但默认不应再由 `register_agent` 静默调用并自动落库.

## 数据模型

为了最小变更, 建议保持 `agents.tmux_pane_id` 作为当前消费字段, 同时补一组 runtime 校验元数据.

建议新增列:

- `runtime_ui_pid INTEGER NULL`
- `runtime_tty TEXT NULL`
- `runtime_verification_mode TEXT NULL`
- `runtime_bound_at TEXT NULL`

原因:

1. `poke` 仍然只读 `tmux_pane_id`, 兼容现有代码.
2. 调试时能知道这个 pane 是怎么绑定出来的.
3. 后续如果某个 pane 失效, 可以结合 `runtime_ui_pid` 更容易诊断.

不建议第一期单独开新表, 因为当前 transport metadata 也都直接挂在 `agents` 上, 保持模式一致更省改动.

## 工具层改动

### `register_agent`

建议改成纯注册, 不再自动探测 pane.

输入维持简单:

```ts
{ model, name, role?, team?, delivery? }
```

成功返回中可以附一个 hint:

`runtime identity not bound, tmux poke delivery is off until bind_runtime_identity succeeds`

这样语义更清楚, 不会再让用户误以为注册时已经可靠完成 pane 绑定.

### `register_codex_self`

`register_codex_self` 仍然负责:

- 校验 codex appserver.
- 绑定 `delivery.kind='codex-appserver'`.

但 pane 绑定建议走同一个 `bind_runtime_identity` helper.  两种接法都可以:

1. 工具层继续两步, 先 `register_codex_self`, 再 `bind_runtime_identity`.
2. `register_codex_self` 内部如果拿到了 `ui_pid` 等强标识, 就复用同一个 verifier.

第一期更推荐第 1 种, 因为职责最清楚.

## 客户端约定

### Claude Code

最理想的是由 Claude Code MCP 集成层直接上报 UI 进程的真实 pid.  如果拿不到, 次选上报 `ui_tty + tmux_pane_id`.

### Codex

`thread_id` 继续只用于 appserver delivery 绑定.  若要绑定 tmux pane, 仍需额外上报 `ui_pid` 或 `ui_tty + tmux_pane_id`.

### Opencode

如果当前发 MCP 的是无 tty 的 helper 进程, 则必须区分:

- helper pid, 不能直接用于 pane 绑定.
- UI pid, 才是 `bind_runtime_identity.ui_pid` 需要的值.

也就是说, 字段名必须明确叫 `ui_pid`, 不要叫泛泛的 `pid`, 避免客户端把错误进程 id 传上来.

## 兼容策略

### Phase 1

1. 新增 `bind_runtime_identity`.
2. `register_agent` 停止自动 detect 并写 pane.
3. `detect_tmux_pane` 保留, 仅作 debug.
4. `poke` 和 auto-poke 保持读取 `agents.tmux_pane_id`.

### Phase 2

1. 各客户端逐步实现自动调用 `bind_runtime_identity`.
2. 当主流客户端都接入后, 文档中删除 "注册时自动检测 pane" 的描述.

### 过渡期回退

如果担心一次性切断自动探测影响现有用户, 可保留一个显式开关:

- `register_agent({ ..., delivery, legacy_detect_tmux?: true })`

但默认值应为关闭.  这个回退只用于兼容, 不建议长期保留.

## 为什么不推荐继续强化全局 detector

可以继续给 `detect_tmux_pane` 叠加 `cwd`, `title_contains`, `tty`, 甚至业务 `thread_id` hint.  但这些都无法解决根问题:

1. 同一个 `cwd` 可同时有多个 session.
2. 同一个标题可重复.
3. 同一种命令模式可重复.
4. 服务端缺少 "这次调用对应哪个 UI 进程" 这个关键事实.

也就是说, 继续做 detector 只能提升命中率, 不能提供可靠绑定语义.

## 测试建议

至少覆盖下面这些场景:

1. `ui_pid -> tty -> pane` 成功绑定.
2. `ui_pid` 存在, 但命令不匹配 `agent`, 返回 `agent_process_mismatch`.
3. `ui_pid` 对应 tty, 但声明的 `tmux_pane_id` 不一致, 返回 `pid_pane_tty_mismatch`.
4. `ui_tty + tmux_pane_id` 成功绑定, 且该 tty 上存在目标 agent 进程.
5. `register_agent` 成功但不再自动写 `tmux_pane_id`.
6. 已有 `tmux_pane_id` 的 agent 再次绑定时可以覆盖旧值, 并刷新 `runtime_*` 元数据.
7. `detect_tmux_pane` 仍然可用于 debug, 但不会被注册路径依赖.

## 开放问题

1. 某些客户端是否能稳定拿到 UI pid, 需要分别验证.
2. 对没有 tty 的 UI 形态, 是否要支持客户端直接上报 `tmux_pane_id` 并做弱校验, 还是直接拒绝.
3. `runtime_ui_pid` 是否需要在 pane dead 时自动清空, 还是保留为历史调试信息.

## 推荐结论

推荐方向是:

1. 把 tmux pane 绑定从 `register_agent` 中拆出来.
2. 新增 `bind_runtime_identity`, 以 `ui_pid` 为主证据.
3. `thread_id` 仅作为客户端内部映射 hint, 不作为 daemon 的一手身份键.
4. `detect_tmux_pane` 从 "注册自动化" 退回 "调试工具".

这样改完后, pane 绑定的语义会从 "daemon 猜了一个看起来像的 pane" 变成 "客户端声明 UI 进程, daemon 验证后确认这个 pane".  这才是多 session, 多 agent, 同 cwd 场景下足够稳的方案.
