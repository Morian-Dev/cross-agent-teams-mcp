# cross-agent-teams-mcp

[English README](./README.md)

一个本地 MCP daemon, 让同一台机器上的多个 AI 编码 agent (Claude Code, Codex, opencode) 互相通信.  agent 注册到 daemon, 互发 1-to-1 消息, 在 team 或 role 内广播, 共享任务列表, 互相唤醒 — 全部通过一个本地 daemon 完成, 不依赖任何外部服务.

## npm 包内容

`cross-agent-teams-mcp` 在同一个包里发两个 bin:

- **`cross-agent-teams-mcp daemon`** — 长驻 HTTP daemon.  把 agent 注册表, 邮箱, 任务列表存在本地 SQLite 文件里, MCP endpoint 在 `http://127.0.0.1:9100/mcp`.
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

Codex 直接通过 Streamable HTTP 跟 daemon 通信, 不需要 channel proxy; 唤醒走 Codex 自己的 app-server 通道.  配置示例见 [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

### opencode

opencode 直接通过 Streamable HTTP 连 daemon 调工具.  这个 daemon 里没有专门的 opencode 唤醒通道 (之前的 `opencode-server` transport 已删除); 跨 agent poke 通过把文本注入到 opencode 所在的 tmux pane 实现.  把 opencode 跑在 tmux 窗口里, 注册时 daemon 会自动解析 `pid → tty → pane`.  详见 [docs/configs/opencode.md](docs/configs/opencode.md).

## 3. 在 agent 内完成注册和通信

agent 的 MCP client 连上后, 在 agent 会话内调用注册 helper — 不要用 `curl` 或其它外部 HTTP client (那会创建另一个 MCP session, 后续工具就找不到注册身份了).

### 注册

Claude Code:

```text
register_claude_self({
  name: "<agent-name>",
  ui_pid: <Claude Code CLI 的 pid; 在 Bash 工具里就是 $PPID>,
  project_dir: "<项目的绝对路径>"
})
```

Codex (harness 已 export `CODEX_THREAD_ID` 时):

```text
register_codex_self({
  name: "<agent-name>",
  thread_id: "<$CODEX_THREAD_ID 的值>",
  project_dir: "<项目的绝对路径>"
})
```

统一入口 (任意 client):

```text
register_agent({
  client: "claude-code" | "codex" | "opencode" | "custom",
  name: "<agent-name>",
  model: "<model-name>",
  project_dir: "<项目的绝对路径>",
  ui_pid: <runtime pid>          // 可选, 但非 codex 强烈建议传
})
```

`team` 默认派生自 `project_dir` 的 basename; 想用不同 team 才显式传.  Claude Code 注册成功时, 响应里会带 `channel_session_id`, 表示唤醒通道已经自动接好了.

### 发消息和查收件箱

```text
send_message({ to_agent_name: "<对方名字>", subject: "...", body: "..." })
broadcast({ subject: "...", body: "..." })            // 同 team 广播
broadcast_to_role({ role: "<role>", subject, body })  // 同 team 同 role
get_inbox()                                            // 看自己的收件箱
```

`send_message` 默认会 auto-poke 收件人, 推一条短的 wake-up hint, 邮件正文要 `get_inbox` 拉.  `need_reply` 默认 `true`, FYI 类消息设 `false`.  按 agent_id 发用 `send_message_by_id`.

### 共享任务列表 (每个 team 一份)

```text
task_add({ title, description? })
task_list({ status?: "open" | "claimed" | "done" })
task_claim({ task_id })
task_complete({ task_id, result? })
```

## 更多

- 完整工具列表和参数: 启动 daemon 后调 MCP endpoint 的 `tools/list`.
- Codex / opencode 详细配置: `docs/configs/`.
- 源码: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).
