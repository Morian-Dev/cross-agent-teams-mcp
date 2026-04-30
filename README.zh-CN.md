# cross-agent-teams-mcp

[English README](./README.md)

一个本地 MCP daemon, 让同一台机器上的多个 AI 编码 agent (Claude Code, Codex, opencode) 互相通信.  agent 注册到 daemon, 互发 1-to-1 消息, 在 team 或 role 内广播, 互相唤醒 — 全部通过一个本地 daemon 完成, 不依赖任何外部服务.

## npm 包内容

`cross-agent-teams-mcp` 在同一个包里发两个 bin:

- **`cross-agent-teams-mcp daemon`** — 长驻 HTTP daemon.  把 agent 注册表和邮箱存在本地 SQLite 文件里, MCP endpoint 在 `http://127.0.0.1:9100/mcp`.
- **`cross-agent-teams-channel`** — stdio MCP shim, 让 Claude Code 通过 `notifications/channel_wake` 接收唤醒通知 (Claude Code 的 experimental channel capability).  Claude Code 需要它接收 wake; Codex 用自己的 app-server 通道, opencode 走 tmux-pane 文本注入, 都不需要 channel proxy.

## 1. 启动 daemon

在本机起一次, 让进程保持运行 (单独终端 / `tmux` / `screen` / `launchd` 都行):

```bash
npx -y cross-agent-teams-mcp@latest daemon --port 9100
```

daemon 默认监听 `127.0.0.1:9100`.  MCP endpoint: `http://127.0.0.1:9100/mcp`, 健康检查: `http://127.0.0.1:9100/health`.

常用参数:

- `--port <n>` (默认 `9100`)
- `--token <t>` (Bearer 鉴权)
- `--db <path>` (默认 `~/.cross-agent-teams-mcp/data.db`)
- `--pid-file <path>` (默认 `~/.cross-agent-teams-mcp/daemon.pid`)

## 2. 在 agent 端配置 MCP client

### Claude Code (两个条目都需要 — HTTP 用于工具, stdio 用于 channel 唤醒)

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

`server:<name>` 后缀 **必须** 等于 `.mcp.json` 里的 MCP server key (上例中是 `cross-agent-teams-channel`).  如果 daemon 启动带了 `--token <t>`, 在 HTTP 条目里加 `"headers": { "Authorization": "Bearer <t>" }`.

### Codex CLI

Codex 直接通过 Streamable HTTP 跟 daemon 通信, 不需要 channel proxy — Codex 没有 `claude/channel` capability, 唤醒走 Codex 自己的 app-server websocket (或 tmux paste 兜底).

`~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

(daemon 带了 `--token <t>` 时, 加 `[mcp_servers.cross-agent-teams.headers]` 和 `Authorization = "Bearer <t>"`.)

如果你希望别的 agent 能**唤醒**这个 Codex thread (不只是给它发邮件), 在跑 Codex 之前把 codex app-server 一起拉起来:

```bash
codex app-server --listen ws://127.0.0.1:8799     # 一个终端
codex --remote ws://127.0.0.1:8799                # 另一个终端 (TUI)
```

不启 app-server 也能用 — `send_message` 给这个 Codex 仍然会写到邮箱, 但需要你自己调 `get_inbox` 拉读, 没有推送唤醒.

详细配置 (auth header, tmux fallback, 底层 `register_agent` 用法): [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

### 其它编码 agent (opencode, cursor, ...)

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
