# Codex CLI MCP config for cross-agent-teams-mcp

Codex CLI 始终使用独立 runtime.  用户选择在桌面 App 中启用 xats 时, App 再使用
第二个完全独立的 runtime:

| surface | endpoint | `CODEX_HOME` | binary |
| --- | --- | --- | --- |
| CLI / SSH | `ws://127.0.0.1:8799` | `~/.codex-cli` | PATH codex 优先, 可回退 App bundle |
| Codex/ChatGPT App (可选 xats) | `ws://127.0.0.1:8800` | 默认 `~/.codex` | 必须使用当前 App bundle, 不得回退 PATH |

首次启用前单独初始化 CLI home:

```zsh
mkdir -p "$HOME/.codex-cli"
CODEX_HOME="$HOME/.codex-cli" codex login
```

不要复制 App home 中的 `auth.json`, sessions 或整个状态目录.  CLI 和 App 需要
分别登录和配置 MCP.  把下面配置加到 CLI 的
`~/.codex-cli/config.toml`; 只有启用 App xats 时, 才在默认
`~/.codex/config.toml` 中保留一份:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

`experimental_use_rmcp_client = true` 必须放在**顶级**, 缺这条 codex 不会用 rmcp client, streamable-http 类型 MCP 加载不了.

如果 daemon 启动时带了 `--token`, **不要**用老写法 `[mcp_servers.X.headers]` —— Codex 0.130+ 不认 (会静默忽略, MCP 握手时被 daemon 401 拒掉, 然后 codex 把 401 body 当 JSON-RPC 帧解析失败, 报错 `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage`).  正确写法用 `bearer_token_env_var` (推荐) 或 `http_headers`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
bearer_token_env_var = "XATS_TOKEN"  # codex 启动时会读 $XATS_TOKEN 作为 Bearer
```

启动 codex 的 shell 里要 `export XATS_TOKEN=<daemon 的 --token 值>`.  如果 codex 在 `--remote` 模式下跑, env 要在启动对应 **app-server** 的那个 shell 里 export, 不是 TUI shell (见 [docs/launchers/free-xats-codex.md](../launchers/free-xats-codex.md) 的 caveats).

> **--remote 模式下 MCP 是 app-server 加载的**, 不是 TUI 加载的.  上面这段配置必须放在对应 app-server 启动时读到的 `CODEX_HOME` 里: CLI 是 `~/.codex-cli`, App 是默认 `~/.codex`.  仅在 TUI 启动时覆盖 `CODEX_HOME` 不起作用.  受信任项目的 `.codex/config.toml` 仍可按 thread cwd 合并.

## 推荐: `register_agent({ agent_type: "codex", thread_id, ... })`

Codex 0.124.0+ 在调用 MCP 工具时会向工具进程的环境变量里 export `CODEX_THREAD_ID`.  从 Codex agent 会话内, 直接调统一注册入口即可:

```text
register_agent({
  agent_type: "codex",
  name: "<agent-name>",
  thread_id: "<value of $CODEX_THREAD_ID>",
  project_dir: "<your project's absolute path>"
})
```

注意点:

- `thread_id` 是 codex 注册的必填项 (schema 层强制); 缺失或空字符串会被 Zod 拒绝
- 把 thread_id 注册成 `codex-appserver` delivery.  daemon 配置多个 endpoint 时会探测并保存唯一持有该 thread 的 URL; 显式 `ws_url` 仍可覆盖
- `model` 可省略, 默认 `gpt`
- **不要传 `ui_pid`** — codex 的 launcher 通过 `pre_register_codex_pane` 走另一条 pre-reg 流程做 tmux pane 自动绑定, 显式传 `ui_pid` 反而会关掉那条路径
- `team` 默认从 `project_dir` 的 basename 派生, 想要不同 team 才显式传

成功响应:

```json
{ "agent_id": "...", "team": "...", "thread_id": "...", "ws_url": "ws://127.0.0.1:8799" }
```

### Mac Codex App reconnect

Mac Codex App 的 MCP 工具进程同样会导出 `CODEX_THREAD_ID`.  对同一个 Codex task,
已验证的 context clear, MCP session replacement, 以及 conversation resume 场景中,
这个值仍然是同一个 conversation/thread identity.  因此忘记 `(team, name)` 后可以调用:

```text
reconnect({
  thread_id: "<value of $CODEX_THREAD_ID>"
})
```

`thread_id` 只用于查找本机候选身份.  daemon 在复用旧身份前仍会连接当前配置的
Codex app-server 并执行 `thread/resume`.  只有恢复握手成功后才会复用原
`agent_id`, takeover 旧 MCP session, 并重绑当前 connection 和 fanout.  握手失败时
不会修改 agent row.  App pid, app-server pid, 以及旧数据库行都不能单独作为恢复依据.

Mac Codex App quit/relaunch 后是否继续导出同一个 `CODEX_THREAD_ID` 取决于 App 的
conversation 恢复行为, 当前未验证, 不应仅凭旧 ID 假定身份仍然有效.  reconnect
仍会用实际 `thread/resume` 作为恢复前的必要验证.

Mac Codex App 连接 App 专用 `ws://127.0.0.1:8800`.  daemon 应配置
`CROSS_AGENT_TEAMS_CODEX_WS_URLS='["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]'`.
注册时不需要让 agent 记住端口; daemon 用 `thread_id` 自动匹配.  显式 `ws_url` 和旧
`CROSS_AGENT_TEAMS_CODEX_WS_URL` 仍优先, 用于兼容单 endpoint 部署.

后续 `poke` 走 `codex-appserver` transport (websocket 直接进对方 thread 里 start a turn).

下面的"方案 2"是更底层的入口和历史用法, 一般不需要.  Tmux pane 兜底 delivery 不再需要专门的本地脚本: `register_agent` 注册成功后会 best-effort 自动尝试 runtime 绑定; 如果响应里仍然带了 `hint`, 调用 `bind_runtime_identity(...)` 显式绑定即可.

## 方案 2, 使用 Codex app-server websocket delivery

如果你希望 daemon 通过 Codex 自带的 websocket app-server 唤醒一个正在运行的 Codex thread, 可以在 agent 侧启动 app-server, 然后把 `delivery.kind='codex-appserver'` 注册到 daemon.

优先推荐直接用统一入口 `register_agent`, 并显式带上 `agent_type: "codex"` 和 `thread_id`.  它会把你显式提供的 `thread_id` 注册成 `codex-appserver` delivery, 但不会自动绑定 tmux pane.  如果你还需要 tmux fallback delivery, 再单独调用 `bind_runtime_identity(...)`.

`register_agent({ agent_type: "codex", ... })` 不会再根据 loaded threads 自动猜“当前调用者自己的 thread”.  daemon 没有协议级信号把当前 MCP 调用者和某个 Codex loaded thread 强绑定.  如果你省略 `thread_id`, 工具会返回 `thread_id_required`, 并把当前可恢复的 thread ids 放在 detail 里供排查, 但不会继续注册.

### 1. 启动 CLI app-server

本地 loopback, 无鉴权:

```bash
CODEX_HOME="$HOME/.codex-cli" codex app-server --listen ws://127.0.0.1:8799
```

CLI app-server 读取 `~/.codex-cli/config.toml`.  确保其中**已经配了** `cross-agent-teams-mcp` MCP (见本文档开头), 否则 `--remote` 接进来的 codex agent 看不到 xats 的工具, `register_agent` 调不到, codex-appserver delivery 等于没装上.

如果你需要显式 bearer token, 先准备一个环境变量, 再让 app-server 和 TUI 都引用它:

```bash
export CODEX_REMOTE_TOKEN="replace-me"
CODEX_HOME="$HOME/.codex-cli" \
  codex app-server --listen ws://127.0.0.1:8799 --ws-auth capability-token
```

### 2. 让 Codex TUI 连接到同一个 app-server

无鉴权:

```bash
codex --remote ws://127.0.0.1:8799
```

带 token:

```bash
codex --remote ws://127.0.0.1:8799 --remote-auth-token-env CODEX_REMOTE_TOKEN
```

进入 TUI 后先发一条消息, 让它进入一个现有 thread.  `register_agent` 需要你显式提供这个 thread 的 `thread_id`.

### 2.1 可选: 启动桌面 App xats runtime

先确认用户接受以下取舍: 这种外部 app-server 模式支持 xats 注册和 poke, 但当前
不能使用 ChatGPT in Chrome 插件.  用户需要 Chrome 插件时跳过本节, 从 macOS
图标原生启动 App; 原生 App 不接收这里的 xats poke.

启用时, 桌面 App server 固定监听 8800, 保持默认 `~/.codex`, 并且只能使用当前
App bundle 内的 binary:

```zsh
app_codex="/Applications/Codex.app/Contents/Resources/codex"
[[ -x "$app_codex" ]] || \
  app_codex="/Applications/ChatGPT.app/Contents/Resources/codex"
env -u CODEX_HOME "$app_codex" \
  -c features.code_mode_host=true \
  app-server --analytics-default-enabled \
  --listen ws://127.0.0.1:8800
```

然后使用 `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8800` 启动桌面 App.
不要使用 `command -v codex` 作为 App server 的 fallback.  App 更新后要重启该
server, 确保 bundle binary 与 App 版本和签名身份一致.  完整 launcher 见
[README.agent.md](../../README.agent.md).

### 3. 用 `register_agent` 上报 `delivery`

更简单的推荐用法:

```text
register_agent({
  agent_type: "codex",
  model: "gpt-5",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111"
})
```

可选覆盖:

```text
register_agent({
  agent_type: "codex",
  model: "gpt-5",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111",
  ws_url: "ws://127.0.0.1:8799",
  auth_token_ref: "CODEX_REMOTE_TOKEN"
})
```

返回:

```json
{
  "agent_id": "...",
  "team": "cross-agent-teams-mcp",
  "thread_id": "11111111-1111-4111-8111-111111111111",
  "ws_url": "ws://127.0.0.1:8799"
}
```

补充说明:

- `register_agent({ agent_type: "codex", ... })` 是新的推荐入口
- 未显式指定 `team` 时, 推荐传 `project_dir` 为当前工作目录, daemon 会用目录名派生默认 team
- `bind_runtime_identity` 才是写入 `tmux_pane_id` 的路径
- `detect_tmux_pane(...)` 仅用于调试

如果没有 loaded thread, 工具会返回:

```json
{ "error": "no_loaded_threads" }
```

如果你省略 `thread_id`, 工具会返回:

```json
{ "error": "thread_id_required", "detail": { "ws_url": "ws://127.0.0.1:8799", "thread_ids": ["..."] } }
```

如果你仍然想手动指定 `delivery`, 可以继续用下面这种低层方式:

无鉴权:

```text
register_agent({
  model: "...",
  role: "...",
  team: "...",
  name: "...",
  delivery: {
    kind: "codex-appserver",
    thread_id: "11111111-1111-4111-8111-111111111111",
    ws_url: "ws://127.0.0.1:8799"
  }
})
```

带 token 引用:

```text
register_agent({
  model: "...",
  role: "...",
  team: "...",
  name: "...",
  delivery: {
    kind: "codex-appserver",
    thread_id: "11111111-1111-4111-8111-111111111111",
    ws_url: "ws://127.0.0.1:8799",
    auth_token_ref: "CODEX_REMOTE_TOKEN"
  }
})
```

约束:

- `thread_id` 必须是 UUID.
- `ws_url` 只能是 `ws://` 或 `wss://`.
- `auth_token_ref` 是环境变量名, 不是文件路径.  daemon 会读取 `process.env[auth_token_ref]`, 缺失或空白会直接返回 `missing_auth_token`.
- 当你显式提供 `codex-appserver` delivery 时, `register_agent` 不会再返回 tmux hint.

### 4. `poke` 的返回

Codex transport 成功时, `poke` 返回:

```json
{ "ok": true, "transport_used": "codex-appserver", "thread_id": "11111111-1111-4111-8111-111111111111" }
```

失败时会返回 transport-aware 错误, 例如:

```json
{ "error": "codex_connect_failed", "detail": "ECONNREFUSED", "transport_used": "codex-appserver" }
```

`codex-appserver` 是显式 delivery.  如果 websocket 连接或远端 RPC 失败, daemon 不会自动 fallback 到 tmux.

## 迁移与手工验收

以下步骤需要用户选择合适时间手工执行.  安装或升级文档的 agent 不应自动退出正在
运行的 App, 也不应替换当前 listener.  先询问用户是否在 App 中启用 xats.

启用 App xats 时:

1. 保存 CLI 和 App 中正在进行的工作, 手工退出桌面 App.
2. 确认 `~/.codex-cli` 已独立登录并配置 xats MCP, App 默认 `~/.codex` 保持原状.
   不复制 `auth.json` 或 sessions.
3. 执行 `stop-xats && start-xats`, 确认 9100, 8799, 8800 都在监听.
4. 在同一个 project 先运行 `xats-codex`, 创建一个 CLI task; 再运行
   `xats-codex-app`, 确认 App 不会列出或接管该 CLI task.
5. 在 App 创建独立 task.  两边分别调用 `register_agent`, 确认 CLI 返回并持久化
   8799, App 返回并持久化 8800.  从另一个 agent 分别 `poke`, 确认两边都能唤醒.
6. 明确告知用户此 App runtime 当前不能使用 ChatGPT in Chrome 插件.  bundle
   binary 和 `features.code_mode_host=true` 只保证 App/app-server 版本匹配, 不能
   恢复插件能力.

不启用 App xats 时:

1. 只启动并验证 9100 和 8799, 不由 xats launcher 启动或停止 8800.
2. 从 macOS 图标原生启动 App, 验证 ChatGPT in Chrome 插件可用.
3. 明确告知用户该原生 App 不接收 xats poke, CLI xats 不受影响.

旧 `~/.codex` 中已经存在的 session 保留给 App.  新 CLI session 从迁移后写入
`~/.codex-cli`; 不建议跨 home 搬运 session 文件.
