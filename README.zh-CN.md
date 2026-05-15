# cross-agent-teams-mcp

[English README](./README.md)

一个本地 MCP daemon, 让同一台机器上的多个 AI 编码 agent (Claude Code, Codex, opencode) 互相通信.  agent 注册到 daemon, 互发 1-to-1 消息, 在 team 或 role 内广播, 互相唤醒 — 全部通过一个本地 daemon 完成, 不依赖任何外部服务.

## 快速开始

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

注意: 只有 Claude Code 默认就能收到 push 唤醒.  Codex 需要 `--remote` + launcher 配置 (见下面 section 2) 才能被 poke; 没配的话只有邮箱, 不会自动醒.  opencode / cursor 等其它 agent 只有跑在 tmux pane 里才能被 poke.  没接通 push 唤醒的情况下, 让 agent 自己手动收信即可 (跟它说"查一下我的 xats inbox").

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

### 跨主机 (LAN) 协作

要让可信局域网里另一台机器上的 agent 使用这个 daemon, 把 daemon 绑定到 LAN 地址并设置共享 bearer token:

```bash
npx -y cross-agent-teams-mcp@latest daemon \
  --host 192.168.1.10 \
  --port 9100 \
  --token "$XATS_TOKEN" \
  --device jt-laptop
```

然后在对端机器上让 Claude Code channel proxy 连回这个 daemon:

```bash
npx -y -p cross-agent-teams-mcp@latest cross-agent-teams-channel \
  --daemon-url http://192.168.1.10:9100/mcp \
  --token "$XATS_TOKEN" \
  --device gx-laptop
```

agent 身份现在按 `(device, team, name)` 命名空间区分.  裸的 `send_message({to_agent_name:"creator"})` 会解析到调用者自己的 device; 要发给另一个 device 上同 team 的 agent, 用 `creator:gx-laptop`.  `list_agents` 会显示 `device` 字段, 方便拼出这个地址.

安全说明: 非 loopback 的 `--host` 必须带 `--token`, 并且这个 token 会被所有能使用该 daemon 的人共享.  LAN 暴露只适合可信团队环境; 当前模式没有 per-agent 鉴权, device 白名单或 TLS.

升级说明: 升级到这个版本后首次启动会自动迁移存储 schema, 把身份从 `(team, name)` 改为 `(device, team, name)`, 并用 daemon 本机的 `--device` 标签回填旧数据.  如果已经注册了多个 device 上相同 `(team, name)` 的 agent 再回滚, 可能违反旧版本的唯一性假设.

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

`~/.codex/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

`experimental_use_rmcp_client = true` 必须放在**顶级**, 缺这条 streamable-http MCP 加载不了.

(daemon 带了 `--token <t>` 时, 加 `[mcp_servers.cross-agent-teams-mcp.headers]` 和 `Authorization = "Bearer <t>"`.)

这种最小配置下 `send_message` 给这个 codex 会写邮箱, 但需要手动调 `get_inbox` 拉读, 没有跨会话 push 唤醒.

##### 让别人能唤醒你 (codex-appserver poke)

要让别的 agent 能**主动唤醒**这个 codex thread (而不只是发邮件), 需要 `codex-appserver` delivery.  这里有个不直观的坑要写清楚:

> **`codex --remote` 模式下, MCP server 是 app-server 加载的, 不是 TUI 加载的**.  上面那段 MCP 配置必须放在 **app-server** 启动时读到的 `CODEX_HOME` 里 — 一般就是全局 `~/.codex/config.toml`.  仅在 TUI 这边设 `CODEX_HOME` 在 `--remote` 模式下对 MCP 不起作用.

启动顺序:

```bash
# 1) 在某个长跑终端起 codex app-server (它的 CODEX_HOME 决定 MCP set)
codex app-server --listen ws://127.0.0.1:8799

# 2) 在另一个终端启动 codex TUI, 连同一个 app-server
codex --remote ws://127.0.0.1:8799
```

如果第 1 步的 app-server 的 `CODEX_HOME` 里没配 `cross-agent-teams-mcp`, `--remote` 进去的 codex agent 根本看不到 MCP 工具, `register_agent` 调都调不到.

##### 推荐: launcher 函数 (tmux pane 自动绑定)

为了让 daemon 把 wake-hint 直接 inject 到 codex thread (而不是只 paste 到 tmux pane), daemon 需要知道 codex 进程在哪个 tmux pane.  launcher 通过 `pre-register-codex-pane` CLI 在 exec codex 之前先把 pane 占住.  把下面的函数加到 `~/.zshrc`:

```zsh
free-xats-codex() {
    local xats_agent_id codex_home search_dir
    xats_agent_id="$(uuidgen)"
    search_dir="$PWD"
    while [[ "$search_dir" != "/" ]]; do
        if [[ -f "$search_dir/.codex/config.toml" ]]; then
            codex_home="$search_dir/.codex"
            break
        fi
        search_dir="${search_dir:h}"
    done

    if [[ -n "$TMUX_PANE" ]]; then
        npx -y cross-agent-teams-mcp pre-register-codex-pane \
            --pane "$TMUX_PANE" \
            --agent-id "$xats_agent_id" \
            >/dev/null 2>&1 \
            || echo "[xats] pre-register failed (continuing without pane claim)" >&2
    fi

    if [[ -n "$codex_home" ]]; then
        CODEX_HOME="$codex_home" exec codex \
            --remote ws://127.0.0.1:8799 \
            -c xats.agent_id="\"$xats_agent_id\"" "$@"
    else
        exec codex \
            --remote ws://127.0.0.1:8799 \
            -c xats.agent_id="\"$xats_agent_id\"" "$@"
    fi
}
```

行为:

- tmux 内 (`$TMUX_PANE` 非空): 先发一条 pre-register (pane_id + UUID + 120s TTL) 给 daemon.  codex agent 之后调 `register_agent({agent_type: "codex", thread_id: $CODEX_THREAD_ID, ...})` 时, daemon 会用 pending pre-reg + 匹配 codex 进程 argv 自动绑 `tmux_pane_id`.
- `--remote ws://127.0.0.1:8799` 让 codex 连步骤 (1) 起好的 app-server.
- `-c xats.agent_id="\"$uuid\""` 把 UUID 暴露在 codex argv 里, daemon 用它反向校验 pane.

详细配置 (auth header, 底层 `register_agent` 用法): [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

#### 其它编码 agent (opencode, cursor, ...)

非 Claude Code 也非 Codex 的工具 — opencode, cursor, 编辑器扩展, 自己的 harness — 直接通过 Streamable HTTP 连 daemon, 注册时用 `agent_type="custom"` (agent 自己会判断).  这些 agent 没有专用的唤醒通道; 跨 agent poke 通过把文本注入到 agent 所在的 tmux pane 实现, 所以把 agent 跑在 tmux 窗口里, 注册时 daemon 会自动解析 `pid → tty → pane`.

各工具的具体配置片段在 [docs/configs/opencode.md](docs/configs/opencode.md) (其它在 `docs/configs/`).

## 3. 从 agent 里使用

agent 连上 daemon 后, 你不需要去记工具名字.  直接用平时跟 agent 对话的语言告诉它你想干嘛, agent 会自己挑工具 — 下面列的是 *你说的话*, 不是底层 API.

> 注意: 这些都要在 agent 会话内说.  不要用 `curl` 或其它外部 HTTP client 去注册或发消息 — 那会开一个不同的 MCP session, 消息送不到你这里.

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

## 更多

- 完整工具列表和参数: 启动 daemon 后调 MCP endpoint 的 `tools/list`.
- 各 agent 详细配置: `docs/configs/`.
- 源码: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).
