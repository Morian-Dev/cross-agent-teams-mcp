# cross-agent-teams-mcp

[English README](./README.md)

一个本地 MCP daemon, 让同一台机器上的多个 AI 编码 agent (Claude Code, Codex, opencode) 互相通信.  agent 注册到 daemon, 互发 1-to-1 消息, 在 team 或 role 内广播, 互相唤醒 — 全部通过一个本地 daemon 完成, 不依赖任何外部服务.

## 为什么不直接用 Claude Code 自带的 agent teams?

Claude Code 自己也有 agent teams 功能, cross-agent-teams 表面上和它有重叠, 但解决的是不同的问题.  三个具体的理由:

**跨 agent 支持.**  Claude Code 的 agent teams 是绑定在 Claude Code 自身的 — 每个成员都是 Claude Code 的 sub-agent.  cross-agent-teams 允许在同一个 team 里混用不同的 agent: Claude Code, Codex, opencode, Cursor 等都可以加入同一个 team, 通过同一个 daemon 协作.  按场景选最合适的 agent, 而不是被某一个 harness 锁死.

**更强的持久性与可控性.**  本项目的设计是每个 agent 进程都由你手动启动和停止.  这比"按需隐式拉起"麻烦, 但也更可控, 更持久 — agent 自己保留长期上下文, 记忆, 会话状态, 不会被编排器隐式重建.  一个专家 agent 可以挂着跑几小时甚至几天, 你一直跟同一个 session 对话.

**跨设备 / 跨用户协作.**  daemon 最近新增了跨物理机组 team 的能力 (见 [第 4 节](#4-跨主机--跨设备协作)).  也就是说你可以和跑在队友机器上的 agent 协作, 不同人手上可能有不同的专家 agent 或工作流 — 这是单进程内嵌的 teams 功能无法触达的边界.

## 快速开始

### 推荐: 让 code agent 替你完成配置

完整的设备配置 (zshrc 启动函数, daemon token, codex/opencode 配置) 已写成一份
agent 可读的操作手册: [README.agent.md](README.agent.md).  把下面这段粘贴给任何
能访问 URL、能执行 shell 命令的 code agent 即可:

```
读取 https://raw.githubusercontent.com/jtianling/cross-agent-teams-mcp/HEAD/README.agent.md
并按其内容在本设备上配置好 xats.
```

agent 会与你确认设备标签, `~/.zshrc` 改动, 以及是否也要在 Codex App 中启用
xats.  首次 `start-xats` 时自动生成 daemon token, 并配好
`free-xats-codex` / `xats-codex` / 可选的 `xats-codex-app` /
`free-xats-opencode` / `xats-opencode` / `xats-kimi` 启动函数以及 `start-xats` /
`stop-xats`.  想手工操作的话, 继续往下看.

### Claude Code

```bash
# 1. 启动 daemon (跑一次, 保持运行)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. 在你的项目下安装 MCP 配置
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code

# 3. 带上 channel loader 启动 Claude Code (需要手动确认权限)
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

### 其它 agent (Codex, opencode, ...)

```bash
# 1. 启动 daemon (跑一次, 保持运行)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. 在你的项目下安装 MCP 配置 (交互式选择对应 agent)
npx mcpsmgr add jtianling/cross-agent-teams-mcp

# 3. 按平时的方式启动对应 coding agent
```

注意: Claude Code 默认就能 push 唤醒.  Codex 和 opencode 也都有真正的 push 唤醒, 各自做一次性 launcher 配置即可 (见下面 section 2) — Codex 走 `--remote` app-server 通道, opencode 走 HTTP `prompt_async` 通道.  cursor / 其它 custom agent 只有跑在 tmux pane 里才能被 poke.  某个 agent 没接通 push 唤醒时, 让它手动查 inbox 即可 (跟它说"查一下我的 xats inbox").

之后用平时跟 agent 对话的语言就能用了:

```
# Agent A 里:
Register me to xats as backend on team default.

# Agent B 里:
Register me to xats as frontend on team default.
Send backend a message: the API has changed.
```

就这些.  下面是细节 — daemon 参数, 手动 MCP 配置, codex `--remote` 设置, 更多使用方式.

## 1. 启动 daemon

在本机起一次, 让进程保持运行 (单独终端 / `tmux` / `screen` / `launchd` 都行):

```bash
npx -y cross-agent-teams-mcp@latest daemon --port 9100
```

daemon 默认监听 `127.0.0.1:9100`.  MCP endpoint: `http://127.0.0.1:9100/mcp`, 健康检查: `http://127.0.0.1:9100/health`.

常用参数:

- `--port <n>` (默认 `9100`)
- `--host <addr>` (默认 `127.0.0.1`)
- `--device <label>` (默认从 hostname 派生)
- `--token <t>` (Bearer 鉴权)
- `--db <path>` (默认 `~/.cross-agent-teams-mcp/data.db`)
- `--pid-file <path>` (默认 `~/.cross-agent-teams-mcp/daemon.pid`)

多主机 / 多设备 (LAN, tailscale 等) 场景请看下面的 [第 4 节](#4-跨主机--跨设备协作).

## 2. 在 agent 端配置 MCP client

### 推荐: `mcpsmgr` (快速开始里已经演示)

[`mcpsmgr`](https://www.npmjs.com/package/mcpsmgr) 读取本仓库的 `mcpsmgr.json`, 一次性把对应 agent 需要的 MCP 条目写进配置 — 包括 Claude Code 的 stdio channel proxy 条目, Codex 的 `experimental_use_rmcp_client` 开关和 streamable-http MCP 条目.

覆盖 daemon 端口:

```bash
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code --port 9300
```

### 手动配置

如果不想用 `mcpsmgr` (私有 fork / 自定义 token / 自定义 stdio args / 或者就是想手写), 各 agent 的原始配置如下.

#### Claude Code (两个条目都需要 — HTTP 用于工具, stdio 用于 channel 唤醒)

`.mcp.json` (或 `~/.claude.json`):

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "type": "http",
      "url": "http://127.0.0.1:9100/mcp"
    },
    "cross-agent-teams-channel": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "cross-agent-teams-mcp@latest",
        "cross-agent-teams-channel",
        "--daemon-url",
        "http://127.0.0.1:9100/mcp"
      ]
    }
  }
}
```

启动 Claude Code 时加上 channel loader, 让它订阅 channel proxy 推过来的唤醒通知:

```bash
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

`server:<name>` 后缀 **必须** 等于 `.mcp.json` 里的 MCP server key (上例中是 `cross-agent-teams-channel`).  如果 daemon 启动带了 `--token <t>`, 在 HTTP 条目里加 `"headers": { "Authorization": "Bearer <t>" }`, 并在 channel proxy args 里加 `--token <t>`.

#### Codex CLI

Codex 通过 Streamable HTTP 跟 daemon 通信.  唤醒走 Codex 自己的 app-server WebSocket, 不经 channel proxy.

##### 最小配置 (只能收邮箱, 没有 push 唤醒)

主要的 CLI runtime 使用标准的 `~/.codex/config.toml`.  由 xats 管理的
桌面 App 则使用隔离的 `~/.codex-app/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

`experimental_use_rmcp_client = true` 必须放在**顶级**, 缺这条 streamable-http MCP 加载不了.

daemon 带了 `--token <t>` 时: 在启动 codex 的 shell 里 `export XATS_TOKEN=<t>`, 然后在 `[mcp_servers.cross-agent-teams-mcp]` 块里加 `bearer_token_env_var = "XATS_TOKEN"`.  (Codex 0.130+ 会**静默忽略**老写法 `[mcp_servers.X.headers]` — 它真正认的 key 是 `http_headers` 和 `bearer_token_env_var`, 后者更推荐, token 不会落进可能被签入仓库的配置里.)

这种最小配置下 `send_message` 给这个 codex 会写邮箱, 但需要手动调 `get_inbox` 拉读, 没有跨会话 push 唤醒.

##### 让别人能唤醒你 (codex-appserver poke)

要让别的 agent 能**主动唤醒**这个 codex thread (而不只是发邮件), 需要 `codex-appserver` delivery.  这里有个不直观的坑要写清楚:

> **`codex --remote` 模式下, MCP server 是 app-server 加载的, 不是 TUI 加载的**.  当前版本的 codex (0.144.x 实测) 中, app-server 会**按每个 thread 的 cwd** 解析配置, 把受信任 (trusted) 项目的 `.codex/config.toml` layer 合并到自身 `CODEX_HOME` 之上.  主要的 CLI server 使用标准的 `~/.codex`, 由 xats 管理的 App server 使用隔离的 `~/.codex-app`.  记得传 `-C "$PWD"` 让 thread cwd 指向项目.  仅在 TUI 这边设 `CODEX_HOME` 在 `--remote` 模式下对 MCP 依然不起作用.

启动顺序:

```bash
# 1) 启动使用标准 ~/.codex 状态目录的常驻 CLI server
env -u CODEX_HOME codex app-server --listen ws://127.0.0.1:8799

# 2) 在另一个终端启动 codex TUI, 只连接 CLI server
codex --remote ws://127.0.0.1:8799
```

如果桌面 App 也需要 xats poke, 它必须使用 8800 上的第二个 server.  这个 server
要从当前 Codex 或 ChatGPT App bundle 启动, 并启用
`features.code_mode_host=true`; App 启动时设置
`CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8800`.  不要为 App runtime 回退到 PATH
中的 binary, 以保证 App 和 app-server 版本匹配.  但外部 app-server 模式当前
不能使用 ChatGPT in Chrome 插件.  daemon
使用 `CROSS_AGENT_TEAMS_CODEX_WS_URLS='["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]'`,
注册时会用传入的 `thread_id` 探测并持久化唯一匹配的 endpoint.  完整生命周期函数和
迁移步骤见 [README.agent.md](README.agent.md).  如果 Chrome 插件更重要, 只为 CLI
启用 xats, App 继续从 macOS 图标原生启动; 此时 App 本身不能被 xats poke 唤醒.

如果当前 app-server 的 `CODEX_HOME` 和 thread 所在受信任项目的 `.codex/config.toml` 里都没配 `cross-agent-teams-mcp`, `--remote` 进去的 codex agent 根本看不到 MCP 工具, `register_agent` 调都调不到.

##### 推荐: launcher 函数 (tmux pane 自动绑定)

为了让 daemon 把 wake-hint 直接 inject 到 codex thread (而不是只 paste 到 tmux pane), daemon 需要知道 codex 进程在哪个 tmux pane.  launcher 通过 `pre-register-codex-pane` CLI 在 exec codex 之前先把 pane 占住.  把下面的函数加到 `~/.zshrc`:

```zsh
free-xats-codex() {
    local xats_agent_id
    xats_agent_id="$(uuidgen)"

    if [[ -n "$TMUX_PANE" ]]; then
        npx -y cross-agent-teams-mcp pre-register-codex-pane \
            --pane "$TMUX_PANE" \
            --agent-id "$xats_agent_id" \
            >/dev/null 2>&1 \
            || echo "[xats] pre-register failed (continuing without pane claim)" >&2
    fi

    exec codex \
        --remote ws://127.0.0.1:8799 \
        -C "$PWD" \
        -c xats.agent_id="\"$xats_agent_id\"" "$@"
}
```

行为:

- tmux 内 (`$TMUX_PANE` 非空): 先发一条 pre-register (pane_id + UUID + 120s TTL) 给 daemon.  codex agent 之后调 `register_agent({agent_type: "codex", thread_id: $CODEX_THREAD_ID, ...})` 时, daemon 会用 pending pre-reg + 匹配 codex 进程 argv 自动绑 `tmux_pane_id`.
- `--remote ws://127.0.0.1:8799` 让 codex 连步骤 (1) 起好的 app-server.
- `-C "$PWD"` 设定 thread cwd, 同时也是 app-server 合并受信任项目 `.codex/config.toml` layer (项目级 xats 安装) 的依据 — 不需要 `CODEX_HOME`.
- `-c xats.agent_id="\"$uuid\""` 把 UUID 暴露在 codex argv 里, daemon 用它反向校验 pane.

详细配置 (auth header, 底层 `register_agent` 用法): [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

#### opencode

opencode 自带一流的 headless HTTP API (`POST /session/{id}/prompt_async`), daemon 用它作为专用唤醒通道 — 不需要 tmux pane 注入.  通过 `agent_type="opencode"` 加 `base_url` (指向 opencode 进程的 HTTP 服务器) 注册即可激活.

别的 agent poke 这个 opencode 时, daemon 把 wake hint POST 到 `prompt_async`, **拉起 opencode 一个新的 agent turn** — agent 自己醒来读 inbox, 不需要任何手动提示, 跟 Claude Code 和 Codex 一样是一等公民的 push 唤醒 (而不是 `custom` agent 回落的那种被动 tmux paste).

把下面的 `free-xats-opencode` zsh 函数加到 `~/.zshrc` (镜像 `free-xats-codex` 的模式):

```zsh
free-xats-opencode() {
    local port
    port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    OPENCODE_XATS_BASE_URL="http://127.0.0.1:${port}" exec opencode --port "${port}" --hostname 127.0.0.1 "$@"
}
```

然后用 `free-xats-opencode` 替代原本的 `opencode`:

```bash
free-xats-opencode                              # 默认 agent
free-xats-opencode --agent build --model glm-5.2   # 透传用户参数
```

launcher 做的事:

- 在 `127.0.0.1` 上分配一个空闲 TCP 端口 (支持多个 opencode 实例并发, 不冲突).
- 导出 `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>`, 让 agent 的 Bash 工具能读到, 并把它作为 `base_url` 传给 `register_agent`.
- `exec opencode --port <port> --hostname 127.0.0.1` 启动 TUI, 同时把 HTTP 服务器绑定到 loopback.

在 opencode TUI 里说:

> 注册到 xats, name: oc-1, team: default

agent 会自动检测 `$OPENCODE_XATS_BASE_URL`, 选 `agent_type="opencode"`, 把 env 值作为 `base_url` 传过去, 并省略 `session_id` (daemon 自动解析为 base_url 上 `time_updated` 最大的那个 session).  只有当 opencode 服务器以 `OPENCODE_SERVER_PASSWORD` 启动时才需要 `auth_token_ref`, 这种情况下也传 `auth_token_ref: "OPENCODE_SERVER_PASSWORD"`.

如果你直接用 `opencode` 启动 (没用 wrapper), env 变量缺失, agent 会回退到 `agent_type="custom"` 加 `agent_type_name="opencode"`, poke 通过 tmux pane 注入投递 (见下一节).

#### kimi-code

Kimi Code 自带 `kimi web` — 本地 REST+WebSocket 守护进程 (默认端口 58627, 仅 loopback, bearer 鉴权), 暴露 `POST /api/v1/sessions/{session_id}/prompts`, 可以把 prompt 塞进一个已存在 session 的队列.  (以前叫 `kimi server run`; kimi 0.28.0 把 `kimi server` 子命令废弃成了空壳, 现在只能用 `kimi web` 启动, 生命周期管理也移到了 `kimi web kill` / `kimi web ps`.)  daemon 用它作为专用唤醒通道 (`kimi-server` delivery kind) — 不需要 tmux pane 注入.  通过 `agent_type="kimi-code"` 加 `base_url` (指向 kimi server) 加显式 `session_id` 注册即可激活 (与 opencode 不同, daemon 不会自动解析 session_id).

把下面的 `xats-kimi` zsh 函数加到 `~/.zshrc` (仅 yolo 模式):

```zsh
xats-kimi() {
    local base_url port token session_id title
    base_url="${KIMI_XATS_BASE_URL:-http://127.0.0.1:58627}"
    port="${base_url##*:}"
    port="${port%%/*}"
    [[ -z "$port" || "$port" == "$base_url" ]] && port=58627
    if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
        echo "[xats] kimi server not listening on port $port, starting it" >&2
        mkdir -p "$HOME/.config/xats"
        kimi web --no-open \
            >>"$HOME/.config/xats/kimi-server.log" 2>&1 &!
        local i
        for i in {1..20}; do
            nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && break
            sleep 0.5
        done
        if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
            echo "[xats] failed to start kimi server on $base_url; see $HOME/.config/xats/kimi-server.log" >&2
            return 1
        fi
    fi

    # 通过 kimi server REST API 预创建 session, 拿到精确的 session id
    # (从 ~/.kimi-code/session_index.jsonl 猜测在同目录多 kimi 会话时会拿错).
    token="$(cat "$HOME/.kimi-code/server.token" 2>/dev/null)"
    if [[ -z "$token" ]]; then
        echo "[xats] kimi server token missing at ~/.kimi-code/server.token" >&2
        return 1
    fi
    title="xats-kimi $(date '+%H:%M:%S')"
    session_id="$(curl -sf -m 10 -X POST \
        -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        -d "{\"title\":\"$title\",\"metadata\":{\"cwd\":\"$PWD\"}}" \
        "$base_url/api/v1/sessions" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])' 2>/dev/null)"
    if [[ -z "$session_id" ]]; then
        echo "[xats] failed to pre-create kimi session on $base_url" >&2
        return 1
    fi
    # server 创建的 session 不带 model; server 驱动的 turn (初始化 prompt, xats poke)
    # 会立刻以 model.not_configured 失败, 必须先设置.
    local model
    model="$(sed -n 's/^default_model *= *"\(.*\)".*/\1/p' \
        "$HOME/.kimi-code/config.toml" 2>/dev/null | head -n1)"
    if [[ -n "$model" ]]; then
        curl -sf -m 10 -X POST \
            -H "Authorization: Bearer $token" \
            -H 'Content-Type: application/json' \
            -d "{\"agent_config\":{\"model\":\"$model\",\"permission_mode\":\"yolo\"}}" \
            "$base_url/api/v1/sessions/$session_id/profile" >/dev/null \
            || echo "[xats] warning: failed to set session model on $base_url" >&2
    fi
    # CLI 在 session 的 agents/ 状态存在之前拒绝挂载; 发一条初始化 prompt 使其落地.
    curl -sf -m 30 -X POST \
        -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        -d '{"content":[{"type":"text","text":"(xats-kimi 启动器自动初始化消息, 回复 ok 即可)"}]}' \
        "$base_url/api/v1/sessions/$session_id/prompts" >/dev/null
    local j sess_dir
    for j in {1..30}; do
        for sess_dir in "$HOME"/.kimi-code/sessions/*/"$session_id"(N); do
            [[ -d "$sess_dir/agents/main" ]] && break 2
        done
        sleep 1
    done

    KIMI_XATS_BASE_URL="$base_url" \
    KIMI_XATS_SESSION_ID="$session_id" \
        exec kimi --session "$session_id" --yolo "$@"
}
```

然后用 `xats-kimi` 替代原本的 `kimi`:

```bash
xats-kimi                                      # 预创建 session, 透传用户参数
xats-kimi --model kimi-code/kimi-for-coding    # 透传用户参数
```

launcher 做的事:

- 把 base URL 解析为 `${KIMI_XATS_BASE_URL:-http://127.0.0.1:58627}` (`kimi web` 的默认绑定端口).
- 端口上没有监听时, 先启动 `kimi web --no-open` 并等待端口就绪.  `kimi web` 是前台运行的, 所以启动器用 `&!` (后台 + disown) 把它甩到后台, `--no-open` 阻止它自动开浏览器.  不传 `--host` 就保持 loopback 绑定.
- 通过 `POST /api/v1/sessions` 预创建 session 并导出 `KIMI_XATS_SESSION_ID` (精确 id).  这一点很关键: 从 `~/.kimi-code/session_index.jsonl` 取 `workDir` 匹配的最后一行, 在同目录多个 kimi 会话时会拿错 — poke 会唤醒别的 session 却报告 `delivered`.
- 通过 `POST /api/v1/sessions/<id>/profile` 给 session 设置 model (从 `~/.kimi-code/config.toml` 的 `default_model` 读) 和 `permission_mode: "yolo"`.  两者都是必须的: server 创建的 session 不带 model (所有 server 驱动的 turn 立刻以 `model.not_configured` 失败), 且 server 驱动的 turn 用的是 session 的 permission mode 而不是 CLI 的 `--yolo` 参数 — 不设置的话, poke 唤醒的 turn 里每次工具调用都会卡在无人应答的审批上.
- 发一条初始化 prompt, 让 CLI 能挂载 server 创建的 session (否则 kimi 报 `Agent "main" was not found`).
- `exec kimi --session <id> --yolo "$@"` 用挂了预创建 session 的 kimi TUI 替换当前 shell.

**session 永远删不掉 — 所以默认每次新建, 复用需要显式开启.**  kimi 的 REST API **没有删除 session 的路由**: 整个接口面只有三个 `DELETE`, 没有一个是 sessions 的; `DELETE /api/v1/workspaces/{id}` 也只是注销 workspace ("does not remove on-disk content"), 它下面的 session 照样列着.  每次启动新建一个 session 确实会永久泄漏 — 但这仍是默认行为, 因为反过来更糟: 上下文坏掉的 session (比如被卡死的工具调用循环污染) 会在每次复用时准时回来, 而新 session 天然干净.

需要续用旧 session 时设 `XATS_KIMI_REUSE=1`: `xats-kimi` 会走 find-or-create — 优先复用当前目录对应池子里**最新的空闲** session (标题以 `xats-kimi` 开头且 `metadata.cwd` 等于 `$PWD`), 只有全部被占用时才新建.  池子大小收敛于你在该目录下的**并发峰值**, 而不是累计启动次数.  复用到的 session 如果上下文已经坏了, 归档它 (`POST /api/v1/sessions/<id>:archive`) 即可移出池子.

复用模式下, 占用状态只能由启动器自己维护, 因为 kimi 答不了这个问题: `kimi web ps` 和服务端的 `connections` 只统计 web 客户端, TUI 挂载对两者都不可见.  所以认领 session 用的是 `~/.config/xats/kimi-locks` 下 `mkdir` 原子创建的锁目录, 里面存 TUI 的 pid —— `exec` 会用 kimi 替换掉 shell, 所以 `$$` 就是 kimi 进程本身.  pid 已死的锁会在下次启动时被回收, 也就是说 TUI 正常退出或崩溃都会自动释放 session, 不需要清理钩子.  `XATS_KIMI_DRYRUN=1 xats-kimi` 会打印池子里每个 session 的 `OCCUPIED` / `FREE` 状态然后退出, 不认领也不启动.

一个注意点: 用裸 `kimi --session <id>` 挂载池子里的 session **不会加锁**, 之后 `xats-kimi` 可能把同一个 session 再交给第二个 TUI.  池子里的 session 只通过 `xats-kimi` 打开.  kimi 没有 session 级的占用 API, 所以这一点没法强制.

`start-xats` 也会拉起 kimi server: 当 PATH 上有 `kimi` 二进制且端口空闲时, 运行 `kimi web --no-open` 并记录结果 (通过 `_xats-log-event`); 二进制缺失时静默跳过.  `stop-xats` 通过 `kimi web kill` 停掉它, 子命令失败时回退到直接 kill 58627 端口上的监听进程 (比如老版本 kimi 起的 server, `kimi web ps` 看不到).  `start-local-xats` / `stop-local-xats` 以同样方式管理 kimi server.

**MCP 配置.**  上面的启动器和 poke 通道只解决了**唤醒**这一半, agent 还得能拿到 xats 工具本身.  kimi 按三个文件解析 MCP server, 后面的覆盖前面的: `$KIMI_CODE_HOME/mcp.json` (回落 `~/.kimi-code/mcp.json`)、`<git root>/.mcp.json`、以及 `<cwd>/.kimi-code/mcp.json` —— 注意最后一个锚在**当前工作目录**而不是 git root, 所以从子目录启动 kimi 是读不到仓库根那份的.

因为 kimi 原生读 `<git root>/.mcp.json` —— 也就是 Claude Code 用的那个文件 —— 一个已经配好 Claude Code 的仓库看起来不用额外配置就能用.  别依赖这一点: `.mcp.json` 里还声明了 `cross-agent-teams-channel`, 这是 **Claude Code 专用**的 stdio server, kimi 会不停尝试启动它并不停报错.  给 kimi 单独一份 `<repo>/.kimi-code/mcp.json`, 显式禁用它:

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "transport": "http",
      "url": "http://127.0.0.1:9100/mcp",
      "bearerTokenEnvVar": "CROSS_AGENT_TEAMS_MCP_TOKEN"
    },
    "cross-agent-teams-channel": { "enabled": false }
  }
}
```

`npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a kimi-code -y` 会帮你把两条都写好, 包括禁用那条 (`--global` 写到 `~/.kimi-code/mcp.json`).  禁用必须是显式 `"enabled": false`, 不能靠省略: kimi 对这三个文件是按 key 的对象展开合并, 所以在 `.kimi-code/mcp.json` 里不写 channel, `<git root>/.mcp.json` 里那条**照样生效**.  只有当根文件确实声明了 channel 时这条才有意义; 只配了 kimi 的仓库没有东西要盖.

同样因为是按 key 合并, **`mcpsmgr remove` 对 kimi 不等于完整卸载**: 从 `.kimi-code/mcp.json` 删掉一条之后, `<git root>/.mcp.json` 里的同名条目会重新生效.  这是 kimi 分层设计的固有属性 —— 真要卸载, 根文件里那条也得删.

另外两点.  优先用 `bearerTokenEnvVar` 而不是明文 `headers.Authorization` —— kimi 会校验引用的变量, 变量没设时直接丢弃该 server, 而且它自己的规范就是别把 secret 放进 `mcp.json`.  还要注意**一条写坏会废掉整个文件**: kimi 是把每个 `mcp.json` 当作一个整体做 schema 校验的, 失败就整份报 `CONFIG_INVALID`, 那个文件里所有 server 一起失效.

在 kimi TUI 里说:

> 注册到 xats, name: kimi-1, team: default

agent 会自动检测 `$KIMI_XATS_BASE_URL`, 选 `agent_type="kimi-code"`, 把 env 值作为 `base_url` 传过去, 并直接从 `$KIMI_XATS_SESSION_ID` 读 `session_id` — 不需要猜测.  poke 时 daemon 从 `~/.kimi-code/server.token` 读 bearer token (`kimi web` 跨重启持久化, `kimi web rotate-token` 可以让旧 token 立即失效); 只有非默认 token 部署才需要传 `auth_token_ref` (env 变量名).  注册时不做健康检查: 如果 poke 时服务器没在跑, poke 以 `kimi_connect_failed` 失败, 由 mailbox 重试机制接管.

**同一个 kimi session 的两条 MCP 连接共存, 不互相顶掉.**  kimi 的双引擎架构让一个逻辑 agent 拥有两条 MCP 连接: TUI 的进程内引擎, 和跑 poke 唤醒 turn 的 server 引擎.  server 侧 turn 醒来时未绑定, 会用同一个名字 re-register; 由于两次注册都声明 `agent_type="kimi-code"` 且 `(base_url, session_id)` 二元组相同 (base URL 按 canonical 形式比较 —— 大小写、默认端口、尾斜杠都不影响), daemon 把它们当作同一 runtime 身份的并发连接 —— re-register 不会关闭 TUI 那条连接.  server 引擎每条新 MCP session 上第一次 `unknown_agent` → register 依然是预期且正确的; 只有*不同的* session (另一个 `session_id`, 或同名 id 出现在真正不同的 server 上) 抢占同名身份时才执行真正的 takeover 并关闭旧连接.  context clear 后丢了身份: 用 `reconnect({ agent_type: "kimi-code", base_url, session_id })` 找回 —— `agent_type` 让分派变得确定 (空注册表直接回 `need_register`, 而不是去探测 opencode server), `session_id` 必传 (kimi session 永不按最近使用自动解析), daemon 会先向 kimi server 复验该 session (返回必须指认这个 session 本身且未归档) 再重绑, 恢复的连接与同 session 的在线引擎连接共享绑定.  最常见的恢复方式就是重启 TUI: `xats-kimi` 会重新导出 `KIMI_XATS_BASE_URL` / `KIMI_XATS_SESSION_ID`.

如果你直接用 `kimi` 启动 (没用 wrapper), 两个 env 变量都缺失, agent 会回退到 `agent_type="custom"` 加 `agent_type_name="kimi-code"`, poke 通过 tmux pane 注入投递 (见下一节).

已知限制 (kimi 侧的问题, 不是 xats 的): poke 通过 server 驱动的 turn 唤醒 session, 但**安装版** kimi TUI 不会实时刷新自己被 server 驱动的 session — 被唤醒的 turn (收信, 回复等) 要重新加载 session 后才会出现在 TUI 记录里.  活照样干了, 只是少了实时显示.  **对 xats 用户这已经解决**: `xats-kimi` 默认启动本地 patched TUI (server-sync observer, `~/workspace/kimi-code` main), 外部 turn 实时可见 (状态栏提示 + 输入排队), turn 结束后自动刷新 transcript.  安装版 TUI 的限制会长期存在 (已决定不向上游提 issue); 在那上面需要实时显示的话, 用 `kimi web` 打开同一个 session.

不要通过问 kimi agent 本人来确认这一点: 它跑在 session **内部**, 通过 session 状态看自己的对话, 而不是通过渲染出来的终端.  你问它 TUI 有没有刷新, 它会如实报告 turn 跑过了, 并回答 "刷新了, 实时可见" —— 而这是它结构上无法观察的断言.  只有人去看真实终端才能判定.

**poke 前会做一次 session 前置检查.**  往一个已经在跑 turn 的 session 里注入, 等于让两个引擎同时写同一个 session, 所以每次 `POST /prompts` 之前 daemon 会先探测目标, 必要时拒绝注入.  两个输入, 按这个顺序判定:

1. `GET /api/v1/sessions/<id>` —— `pending_interaction != 'none'` 返回 `kimi_pending_interaction`; `main_turn_active` 为真返回 `kimi_session_busy`, `reason: main_turn_active`.
2. `~/.kimi-code/sessions/*/<id>/agents/main/wire.jsonl` 的 mtime —— 最近 10 秒内被写过, 返回 `kimi_session_busy`, `reason: tui_recent_write`.

这个门判定的是 `main_turn_active`, **不是** `busy`.  后台任务活着的时候 `busy` 也是真, 而后台任务可以跑很久却完全不跟注入的 prompt 冲突 —— 用 `busy` 会把本来安全的 poke 也挡掉.

`kimi_session_busy` (无论来自这个门, 还是来自 `POST /prompts` 自己回的 `SESSION_BUSY` 拒绝) 会按 tmux 路径同一套梯度重试 —— **30s / 180s / 600s**, 每次都重新跑一遍完整的前置检查.  `kimi_pending_interaction` **不重试**: 没人应答的审批会让 turn 一直挂着, 重试只是白白烧掉梯度.  梯度耗尽后 daemon 什么都不做: 不强行注入, 不回落 tmux.  消息发出时 mailbox 行就已经落库了, agent 下次 `get_inbox` 照样看得到 —— 唤醒是对它的优化, 不是投递手段本身.

**两个盲区, 明说.**  REST 探测看不见 TUI: `busy` 和 `main_turn_active` 只反映 kimi **server** 进程里的引擎, 而你在 TUI 里跑的 turn 走的是 TUI 自己的进程内引擎 —— 跟上面"不实时刷新"是同一个双引擎根因.  wire 日志 mtime 就是为这种情况打的启发式补丁, 文件缺失或读不到时 fail open (照常注入).  另外这个门是 check-then-inject, 永远不是原子的: 探测和 POST 之间仍可能起一个 turn.  两个探测输入都刻意 fail open, 所以探测答不上来时退化成改动前的无门行为, 而不是投递中断.  这是缓解, 不是保证; 真正的修法是 kimi 上游把 TUI 收敛到 server 引擎上.

**门的判定会在 daemon log 里留痕.**  每次推迟都会输出一条结构化记录 `{"event":"kimi_poke_deferred","session_id":…,…}`, 带上子原因 (`main_turn_active` / `tui_recent_write` / `session_busy_response`, 或具体的 pending interaction).  放行时如果 wire 日志的 age 低于观察上限 (默认 120s, 用 `KIMI_WIRE_AGE_OBSERVE_MS` 改), 会额外输出 `{"event":"kimi_poke_proceeded","session_id":…,"wire_age_ms":…}` —— 这是"注入可能恰好撞上 TUI turn 思考间隙"那类 near-miss 的可观测影子.  这个上限只用于观察, 永远不改变注入/推迟的判定; 空闲 session (没有 wire 日志, 或 age 达到上限) 什么都不记.  两类记录合起来, 为将来调 10s 窗口提供双侧证据.

**跑很久的注入 turn 只记日志, 绝不中止.**  注入成功后 daemon 会记下返回的 prompt id, 超过阈值 (默认 10 分钟, 用 `XATS_KIMI_PROMPT_OBSERVE_MS` 改) 后检查这个 prompt 是否还在跑, 还在就打一条日志.  它不会去停这个 turn, 也不提供停的开关.  用时长判断"卡住"是错的判据: 这个项目里被 poke 唤醒的 turn 干真活跑过五分钟很常见, 而触发这次改动的失控案例特征是**毫无进展** —— 每 ~10 秒重复一模一样的 TodoList 轮次.  按时长中止会稳定地杀掉健康的那种, 只是顺带撞上生病的那种.

#### 其它编码 agent (cursor, ...)

非 Claude Code, 非 Codex, 也非通过 launcher 启动的 opencode — cursor, 编辑器扩展, 自己的 harness — 直接通过 Streamable HTTP 连 daemon, 注册时用 `agent_type="custom"` (agent 自己会判断).  这些 agent 没有专用的唤醒通道; 跨 agent poke 通过把文本注入到 agent 所在的 tmux pane 实现, 所以把 agent 跑在 tmux 窗口里, 注册时 daemon 会自动解析 `pid → tty → pane`.

各工具的具体配置片段在 [docs/configs/opencode.md](docs/configs/opencode.md) (其它在 `docs/configs/`).

## 3. 从 agent 里使用

agent 连上 daemon 后, 你不需要去记工具名字.  直接用平时跟 agent 对话的语言告诉它你想干嘛, agent 会自己挑工具 — 下面列的是 *你说的话*, 不是底层 API.

> 注意: 这些都要在 agent 会话内说.  不要用 `curl` 或其它外部 HTTP client 去手搓 MCP 协议注册或发消息 — 那会开一个不同的 MCP session, 更糟的是 `curl` 版 `register_agent` 会触发跨 session 的 **takeover**, 把你真正的 session 强制关掉.  如果你的 MCP client 传输已经挂了, 只是需要一个救生艇, 用下面这个 loopback-only 的 REST API — 它不碰你的 session.

**救生艇: loopback REST API.**  当 agent 的 MCP client 传输挂掉时, 它连一个 xats 工具都调不了 — 甚至没法说自己卡住了.  正是为了这种情况, daemon 在同一个端口上以 `/api/` 前缀暴露了一个极小的 **loopback-only** REST 接口.  它按 `(team, name)` 解析 agent, 复用和 MCP 工具完全相同的 send / inbox / list-agents 逻辑, 并且**对 session 零副作用** (不 takeover, 哪怕你的 MCP session 还活着也安全).  远程调用一律 `403`; 如果 daemon 带 `--token` 启动, 像 `/mcp` 一样带上 token (`Authorization: Bearer <token>` 或 `?token=<token>`).

```bash
# 以一个已注册的 agent 身份发消息
curl -s http://127.0.0.1:<port>/api/send \
  -H 'content-type: application/json' \
  -d '{"from":{"team":"default","name":"alice"},
       "to":{"team":"default","name":"bob"},
       "body":"我的 MCP client 卡死了 — 正在重启"}'

# 读收件箱 — 省略 since_event_id 会推进你的已读游标,
# 传了则是只读查看, 不推进游标
curl -s 'http://127.0.0.1:<port>/api/inbox?team=default&name=alice'

# 列出某个 team 的 agent
curl -s 'http://127.0.0.1:<port>/api/agents?team=default'

# 删掉一行过期的注册记录 (agent_id 从上面的列表里取)
curl -s -X DELETE http://127.0.0.1:<port>/api/agents/<agent_id>
```

REST 上刻意没有 `register_agent` — 创建或重新绑定身份正是这个接口要规避的 takeover 陷阱, 所以 agent 必须先 (通过 MCP) 注册过一次, 才能用这个救生艇.

**删除注册行.**  `DELETE /api/agents/<agent_id>` 只删这一行, 成功返回 `{"deleted":true,"agent_id":...,"team":...,"name":...}`; id 匹配不到任何行时返回 `404 {"error":"unknown_agent"}`, 所以重复删除会明确告诉你"本来就没了".  它按 `agent_id` 而不是 `(team, name)` 寻址是刻意的 —— 带着 daemon 已经不再使用的 device 标签的那些行, 正是最值得清理的, 而绑定到本机 device 的 `(team, name)` 查找根本够不着它们.  也刻意不看存活状态: 对于注册时既没有 pid 也没有 tmux pane 的 runtime (kimi-code), `online` 会退化成一个以天计的 `last_seen_at` 窗口, 拿它当门槛只会把最该删的行挡在外面.

这是**注册表**操作, 不是停止 agent 的手段.  它不杀任何东西: 不杀进程, 不杀 pane, 不杀 session.  一个正在运行的 agent 被删掉行之后, 它的下一次 xats 调用会以未注册 session 被拒, 需要重新 `register_agent`.  kimi-code 的落差更大 —— kimi session 会继续运行、继续接收 prompt (kimi 的 REST API 压根没有删除 session 的路由), 所以删行只是终结了它在 xats 里的可寻址性.  agent 删自己用 `unregister_self` 工具; 删**别的** agent 刻意没有提供 MCP 工具.

> 安全提示: "loopback-only" 也包含同机的浏览器, 所以给 daemon 带上 `--token` 才能挡住本机网页访问 `/api/`.  不带 token 时, 恶意本机网页最多能通过跨站 `GET /api/inbox` 推进某个 agent 的收件箱游标 — 它读不到任何响应 (CORS), 发不了消息, 也冒充不了别人; 唯一后果是那个 agent 可能漏掉未读消息.  这是一个有界的、经过权衡后接受的风险; 带 token 就能彻底消除.

### 注册当前会话

agent 第一次连上 xats 时不会自动注册, 要等你开口.  直接说:

> Register me to xats as alice.

或者指定 team:

> Register me to xats as alice on team backend.

不传 team 的话, agent 会用当前工作目录的 basename 作为默认 team — 一般情况下你不用操心.

### 跟其它 agent 对话

按名字, 按 team, 按 role 都行:

> Send a message to bob: how is the migration going?
>
> Tell my team I'm starting the deploy.
>
> Send the frontend role a heads-up that the API will change.
>
> What's in my inbox?

agent 会自动挑对应工具 (`send_message`, `broadcast`, `broadcast_to_role`, `get_inbox`).  发消息的同时会自动唤醒收件人, 不用单独再 poke.

### 看看还有谁在线

> Who else is registered on xats?
>
> List agents on team backend.

## 4. 跨主机 / 跨设备协作

大部分用户只用单机就够了, loopback 场景下 `device` 这个轴是透明的, 本节可以完全跳过.  只有当你想让多台物理机器 (LAN, tailscale 等) 共享一个 daemon 时, 才需要往下看.

跨设备需要三处配套修改 — **daemon bind**, **远端 `.mcp.json`**, **agent 注册**.  agent 身份按 `(device, team, name)` 命名空间区分: 裸的 `send_message({to_agent_name:"creator"})` 解析到调用者自己的 device, 用 `creator:host-b` 可以指到另一个 device 上同 team 的 agent.

### 1. Daemon 侧: bind 到非 loopback

停掉旧 daemon, 用非 loopback `--host` 和 `--token` 重启.  `--host` 非 loopback 时 `--token` **必填**, 否则 daemon 拒绝启动 (`token_required_for_non_loopback_bind`).  `--device` 可选, 不传则从 daemon 主机的 hostname 派生 (小写 + 非 `[a-z0-9_-]` 替换为 `-`):

```bash
npx -y cross-agent-teams-mcp@latest daemon \
  --host 0.0.0.0 \
  --port 9100 \
  --token "$XATS_TOKEN" \
  --device host-a
```

想限定监听接口, 把 `0.0.0.0` 换成具体 LAN IP (例如 `10.0.0.10`) 或者 tailscale CGNAT IP (`100.x.x.x`) 都行.  macOS 第一次绑非 loopback 端口会弹"允许 node 接受网络连接", 选允许.

### 2. 远端机器侧: 改 `.mcp.json`

每台远端同事的 Claude Code 相对默认 loopback 配置都要改两处 — HTTP 入口加 `Authorization: Bearer …` 头, channel proxy 加 `--token` 和 `--device`.

> **`--device` 对跨主机场景是关键配置.**  daemon 端会拒掉任何不带 device 的远程 `register_agent` (返回 `device_required_from_remote`), 因此 channel proxy 缺 `--device` 时会陷入 register/fail/respawn 死循环, 永远叫不醒目标 agent — auto-poke 会静默退化成 `no_pane`.  v0.5.18 起 proxy 在 daemon 非 loopback 且未传 `--device` 时会用 `os.hostname()` 自动派生一个 label 并 stderr 打 notice, 但派生值仍可能与 daemon 本机标签撞 (触发 `device_spoofing_local_label_from_remote`), 跨主机部署务必为每台机器在配置里显式钉死 `--device`:

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "type": "http",
      "url": "http://10.0.0.10:9100/mcp",
      "headers": {
        "Authorization": "Bearer xats"
      }
    },
    "cross-agent-teams-channel": {
      "command": "npx",
      "args": [
        "-y", "-p", "cross-agent-teams-mcp@latest",
        "cross-agent-teams-channel",
        "--daemon-url", "http://10.0.0.10:9100/mcp",
        "--token", "xats",
        "--device", "host-b"
      ]
    }
  }
}
```

如果远端用的是主要 Codex CLI, 改 `~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams-mcp]
url = "http://10.0.0.10:9100/mcp"
bearer_token_env_var = "XATS_TOKEN"
```

启动前 `export XATS_TOKEN=xats`.

**daemon 所在机器** (host-a 这台) 的 `.mcp.json` 同样需要加 `headers.Authorization` — daemon 一旦设了 `--token`, 所有 `/mcp` 请求 (包括 loopback) 都要带 token, 没例外.

### 3. Agent 注册

重启远端的 Claude Code (或 codex), channel proxy 用新的 `--device` 启动后, startup hint 会把 device 直接嵌进引导文案, 用户回复时一并带上即可:

> Register me to xats as alice, device host-b.

如果远端 `register_agent` 不传 device, daemon 回 `device_required_from_remote` 直接拒.  device 进入身份键 `(device, team, name)`, 所以两台机器都可以有 `team=default` 下的 `creator`, 不会撞名.

### 4. 跨设备寻址

注册完成后, 用 `name:device` 后缀寻址同 team 不同 device 的 agent:

> Send creator on host-a a message: build is green.

这条解析成 `creator:host-a`, 路由到 `(device=host-a, team=…, name=creator)` 这一行.  裸名字 `creator` 始终解析到 caller 自己 device.

要点:

- `list_agents` 每条返回都有 `device` 字段, 用它看清 team 里哪些 device 在贡献 agent, 再拼对的 `name:device`.
- `get_inbox` 每条消息都带 `from_name` 和 `from_device`.  回复时如果 `from_device !== 自己 device`, 用 `from_name:from_device`; 同 device 用裸名即可.  `send_message_by_id({to_agent_id: from_agent_id, ...})` 是 device 无关的安全兜底.
- 安全提醒: bearer token 在能连到 daemon 的所有人之间共享, 把 LAN 暴露当作可信团队边界处理 — 本模式没有 per-agent 鉴权, 没有 device 白名单, 也没有 TLS.
- 升级说明: 引入 `device` 轴之后首次启动会自动迁移存储 schema, 把身份从 `(team, name)` 改为 `(device, team, name)`, 并用 daemon 本机的 `--device` 标签回填旧数据.  如果已经注册了多个 device 上相同 `(team, name)` 的 agent 再回滚, 可能违反旧版本的唯一性假设.

### 5. 跨设备场景下 Codex 特有的坑

`--token` + Codex `--remote` 模式下会暴露三个本地单设备 setup 看不到的问题:

- **app-server 的 env 在启动时固化**.  `codex app-server --listen ...` 继承启动它那个 shell 的环境.  你在另一个 shell `export XATS_TOKEN=…` 之后, 已经在跑的 app-server 看不到 —— codex MCP 握手时报 `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` (codex 把 daemon 返回的 401 body 当 JSON-RPC 帧解析失败).  解决: 在已经 `export` 好 `XATS_TOKEN` 的 shell 里重启 app-server.

- **`--remote` 会劫持工作目录**.  `codex --remote …` 下 session 的 cwd 是 **app-server 进程的 cwd**, 不是 TUI 的, 所以 launcher 无论在哪个目录跑都会落回 app-server 启动时的目录.  在 `codex` 命令上加 `-C "$PWD"` 覆盖 (上面 launcher 已经带了).

- **项目级 `.codex/config.toml` 会覆盖全局**.  陈旧的 per-project 配置块 —— 尤其在 iCloud / Dropbox 之类跨机同步的目录里 —— 会盖掉你的全局鉴权设置, 报错形如某个 `codex mcp list` (只反映全局) 里看不到的 server 名启动失败.  审计: `find ~ -path '*/.codex/config.toml' -print`, 删掉或更新陈旧条目.

## 更多

- 完整工具列表和参数: 启动 daemon 后调 MCP endpoint 的 `tools/list`.
- 各 agent 详细配置: `docs/configs/`.
- 源码: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).
