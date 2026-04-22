## Context

这次 change 的目标不是增强全局 detector 的猜测能力, 而是改变绑定语义:

- 旧语义: daemon 在注册时 best-effort 猜一个 pane
- 新语义: 客户端声明 runtime identity, daemon 本地校验后再绑定 pane

其中, `cwd`, `title_contains`, `tty` 都只能是辅助线索。  真正可靠的是:

1. `ui_pid -> tty -> pane`
2. 或 `ui_tty + tmux_pane_id` 的显式配对

## Decisions

### 1. 新增 `bind_runtime_identity`, 不扩展 `register_agent`

`register_agent` 继续负责 identity upsert。  runtime pane 绑定改由新 tool 承担:

`bind_runtime_identity({ agent, ui_pid?, ui_tty?, tmux_pane_id?, process_pattern? })`

这样可以把 "注册" 与 "运行时校验绑定" 解耦, 也与已有的 `bind_channel`, `bind_opencode_session` 模式保持一致。

### 2. 以 `ui_pid` 为主证据, `ui_tty + tmux_pane_id` 为降级路径

主路径:

- 读取 `ps -p <ui_pid> -o tty=,command=`
- 校验 command 与 `agent` matcher 匹配
- 用 tty 对应到唯一 tmux pane

降级路径:

- 校验 `tmux_pane_id` 对应 pane 的 tty 等于 `ui_tty`
- 校验该 tty 上存在匹配 `agent` 的进程

### 3. 保留 `detect_tmux_pane`, 但退回 debug 用途

`detect_tmux_pane` 仍然适合人工诊断 "为什么没绑上", 但不再作为注册路径的隐式写入来源。  这样可以避免多实例环境下把 `ambiguous_match` 静默吞成 `NULL`.

### 4. 增加 runtime 元数据列

在 `agents` 表新增:

- `runtime_ui_pid INTEGER`
- `runtime_tty TEXT`
- `runtime_verification_mode TEXT`
- `runtime_bound_at TEXT`

`poke` 仍然读取 `tmux_pane_id`, 因此现有 transport 消费路径不需要大改。  新增列主要用于诊断与后续演进。
