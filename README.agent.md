# README.agent.md — xats 设备配置指南 (写给 code agent)

> 阅读对象: 在一台新设备上负责配置 xats (cross-agent-teams-mcp) 启动环境的 code agent.
> 你 (agent) 按本文顺序执行, 完成后这台设备就能用统一的 shell 命令启动带 xats
> 通信能力的 codex / opencode / claude-code agent.

配置完成后的目标 UX:

1. 设备级常驻服务用 `start-xats` / `stop-xats` 管理 (daemon + codex app-server);
2. 每个项目里最多跑一次 `npx mcpsmgr add jtianling/cross-agent-teams-mcp -a <agent>`
   完成项目级配置 (目前只有 opencode / claude-code 需要, codex 不需要, 见第 3 节);
3. 直接运行 `free-xats-codex` / `xats-codex` / `free-xats-opencode` / `xats-opencode`
   即可启动对应 agent, xats 的 transport poke 等能力开箱即用.
   `free-` 前缀 = yolo 模式 (跳过审批/沙箱), 无前缀 = 正常审批模式.

## 0. 开始前: 需要向用户确认的 3 件事

1. **daemon token**: daemon 用 `--token` 启动后, 所有 agent 侧配置必须带同一个
   token, 任何不匹配都会 401.  token **不需要向用户索取**: 首次运行 `start-xats`
   时自动生成, 格式 `<hostname>-<6 位随机数字>`, **每设备唯一, 不要复用其他设备
   的值**.  生成后会打印告知用户, 并持久化到 `~/.config/xats/token`, 之后每个新
   shell 由 zshrc 自动 export.  本文出现 `<TOKEN>` 的地方, 都指
   `$CROSS_AGENT_TEAMS_MCP_TOKEN` 的当前值.  daemon 监听 `0.0.0.0` (跨设备互通
   需要), 所以必须有 token.
2. **device 标签**: 每台设备一个短且唯一的标签 (如 `jt`, `jtianling-mac-mini`),
   跨设备寻址时用作 `name:device` 后缀.  问用户定一个.
3. **修改 ~/.zshrc 的同意**: 本仓库约定永远不静默修改用户 shell 配置.  把第 2.1
   节的片段展示给用户, 得到同意后再写入.

## 1. 架构速览 (为什么是这些步骤)

- **daemon** (port 9100): 所有 agent 通信的中枢, 常驻进程, 每设备一个.
- **codex**: TUI 以 `--remote` 连接常驻的 codex app-server (port 8799).
  关键约束: **`--remote` 模式下 MCP 由 app-server 的 CODEX_HOME 加载**, 通常是
  全局 `~/.codex/config.toml`.  所以 codex 的 xats MCP 配置是**设备级**的,
  项目级 `.codex/config.toml` 在 `--remote` 下对 MCP 不生效.
- **opencode**: 每个实例自带 HTTP server.  launcher 分配随机 loopback 端口并导出
  `OPENCODE_XATS_BASE_URL`, daemon 通过它做 push 唤醒 (prompt_async), 不依赖 tmux.
  MCP 配置是**项目级** `opencode.json`, 由 mcpsmgr 写入.
- **claude-code**: MCP + channel server 配置是项目级 `.mcp.json`, 由 mcpsmgr 写入;
  启动时需要 `--dangerously-load-development-channels` 挂 channel.
- **pre-register-codex-pane**: codex launcher 在 tmux 里启动前, 先向 daemon 预告
  "pane X 即将运行 agent UUID Y", 之后 codex 内 `register_agent` 时 daemon 自动
  绑定 tmux pane, 无需手动 `bind_runtime_identity`.

## 2. 设备级一次性配置

### 2.1 ~/.zshrc 片段

先检查旧版本: `grep -n 'xats' ~/.zshrc`.  如果已有 `free-xats-codex` /
`free-xats-opencode` / `start-xats` / `XATS_TOKEN` 等旧定义, 与用户确认后**删除或
注释掉旧块**再写入下面的片段, 避免新旧定义共存 (zsh 后定义覆盖先定义, 但残留
alias 会干扰 function, 残留旧变量名会误导排查).

把整段追加到 `~/.zshrc` (替换 `<TOKEN>` 和 `<DEVICE>`):

```zsh
# ===== xats (cross-agent-teams-mcp) =====
# 唯一 token 变量: daemon --token 和 codex bearer_token_env_var 都引用它.
# 值由首次 start-xats 自动生成并持久化, 不要手写.
XATS_TOKEN_FILE="$HOME/.config/xats/token"
[[ -f "$XATS_TOKEN_FILE" ]] && export CROSS_AGENT_TEAMS_MCP_TOKEN="$(<"$XATS_TOKEN_FILE")"
XATS_DEVICE="<DEVICE>"

start-xats() {
    if [[ -z "$CROSS_AGENT_TEAMS_MCP_TOKEN" ]]; then
        mkdir -p "${XATS_TOKEN_FILE:h}"
        printf '%s-%06d' "$(hostname -s)" \
            "$(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 ))" \
            > "$XATS_TOKEN_FILE"
        chmod 600 "$XATS_TOKEN_FILE"
        export CROSS_AGENT_TEAMS_MCP_TOKEN="$(<"$XATS_TOKEN_FILE")"
        echo "[xats] generated daemon token: $CROSS_AGENT_TEAMS_MCP_TOKEN"
        echo "[xats] saved to $XATS_TOKEN_FILE (remove the file to regenerate)"
    fi

    npx -y cross-agent-teams-mcp@latest daemon \
      --host 0.0.0.0 \
      --port 9100 \
      --token "$CROSS_AGENT_TEAMS_MCP_TOKEN" \
      --device "$XATS_DEVICE" &

    codex app-server --listen ws://127.0.0.1:8799 &
}

stop-xats() {
    local label port found=0
    local -a pids
    for spec in "xats daemon:9100" "codex app-server:8799"; do
        label="${spec%%:*}"; port="${spec##*:}"
        pids=("${(@f)$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null)}")
        if [[ -n "${pids[1]}" ]]; then
            echo "[xats] stopping ${label} (port ${port}, pid ${pids[*]})"
            kill "${pids[@]}" 2>/dev/null
            found=1
        else
            echo "[xats] ${label} not running (port ${port})"
        fi
    done
    (( found )) || { echo "[xats] nothing to stop"; return; }
    sleep 1
    for port in 9100 8799; do
        pids=("${(@f)$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null)}")
        if [[ -n "${pids[1]}" ]]; then
            echo "[xats] force-killing survivors on port ${port} (pid ${pids[*]})"
            kill -KILL "${pids[@]}" 2>/dev/null
        fi
    done
}

_xats-codex() {
    local xats_agent_id ws_url
    xats_agent_id="$(uuidgen)"
    ws_url="ws://127.0.0.1:8799"

    if ! nc -z 127.0.0.1 8799 >/dev/null 2>&1; then
        echo "[xats] codex app-server not running, starting it" >&2
        codex app-server --listen "$ws_url" >/dev/null 2>&1 &!
        local _i
        for _i in {1..20}; do
            nc -z 127.0.0.1 8799 >/dev/null 2>&1 && break
            sleep 0.5
        done
        if ! nc -z 127.0.0.1 8799 >/dev/null 2>&1; then
            echo "[xats] failed to start codex app-server on $ws_url" >&2
            return 1
        fi
    fi

    if [[ -n "$TMUX_PANE" ]]; then
        npx -y cross-agent-teams-mcp pre-register-codex-pane \
            --pane "$TMUX_PANE" \
            --agent-id "$xats_agent_id" \
            >/dev/null 2>&1 \
            || echo "[xats] pre-register failed (continuing without pane claim)" >&2
    fi

    command codex "$@" \
        --remote "$ws_url" \
        -C "$PWD" \
        -c xats.agent_id="\"$xats_agent_id\""
}

free-xats-codex() { _xats-codex --dangerously-bypass-approvals-and-sandbox "$@"; }
xats-codex()      { _xats-codex "$@"; }

_xats-opencode() {
    local port
    port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    OPENCODE_XATS_BASE_URL="http://127.0.0.1:${port}" \
        exec opencode --port "${port}" --hostname 127.0.0.1 "$@"
}

free-xats-opencode() { _xats-opencode --auto "$@"; }
xats-opencode()      { _xats-opencode "$@"; }

alias free-xats-claude="claude --dangerously-skip-permissions --dangerously-load-development-channels server:cross-agent-teams-channel"
alias xats-claude="claude --dangerously-load-development-channels server:cross-agent-teams-channel"
# ===== end xats =====
```

要点 (改动前先理解):

- `_xats-codex` 里 `-C "$PWD"` 必须保留: `codex --remote` 默认用 app-server 的
  cwd, 不带它的话 session 会落到 app-server 启动时的目录.
- `-c xats.agent_id="\"$uuid\""` 让 uuid 出现在 codex argv 里, daemon 靠它反向
  校验 pre-register 的 pane, 不能省.
- `_xats-opencode` 用 `exec`: opencode 退出后该 shell/pane 一并结束, 这是预期
  行为 (launcher 即会话).
- pre-register 失败或不在 tmux 内都不阻塞启动, 只是退化为无 pane 自动绑定.
- `_xats-codex` 发现 app-server 未运行时会自动拉起并 disown (`&!`).  此时当前
  shell 已 export 过 token env, 不存在 env 固化问题; 拉起失败才报错退出.

### 2.2 全局 ~/.codex/config.toml

推荐用 mcpsmgr (>= 0.4.8, 见第 7 节) 完成本节, 注意三步顺序:

```bash
source ~/.zshrc && start-xats   # 首次运行: 生成 token 并放进当前 env (见 2.3)
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a codex --global -y
stop-xats && start-xats         # 重启, 让 app-server 读到新写入的 MCP 配置
```

它写入的内容等价于下面的手工配置.  无法用 mcpsmgr 或需要手工合并时自己追加
(若文件已有 `experimental_use_rmcp_client` 或同名 server 块, 合并而不是重复
追加):

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
bearer_token_env_var = "CROSS_AGENT_TEAMS_MCP_TOKEN"
```

- `experimental_use_rmcp_client = true` 必须在**顶级**, 缺了 codex 根本不加载
  streamable-http 类型的 MCP.
- 不要用旧写法 `[mcp_servers.X.headers]`: codex 0.130+ 不认 (静默忽略), 结果是
  daemon 401.  `bearer_token_env_var` 引用的环境变量名必须与 2.1 节 export 的
  一致.
- 版本要求: codex 0.124.0+ (调 MCP 工具时导出 `CODEX_THREAD_ID`, 注册必需).

### 2.3 启动常驻服务并验证

```bash
source ~/.zshrc
start-xats
# 稍等几秒后验证:
nc -z 127.0.0.1 9100 && echo daemon-ok
nc -z 127.0.0.1 8799 && echo appserver-ok
```

首次运行会打印自动生成的 token, **把它转告用户留存**.

注意: app-server 的环境变量在启动那一刻固化.  token 的生成与 export 在
`start-xats` 内部先于两个服务启动, 天然满足.  之后换 token (删 token 文件) 要
`stop-xats` 再 `start-xats`, 且**其他已打开的 shell** 需要重新 `source ~/.zshrc`
才能拿到新 env.

## 3. 项目级配置 (每项目一次)

### 3.1 opencode

在项目根目录:

```bash
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a opencode -y
```

- mcpsmgr >= 0.4.8 的 `-y` 非交互: token 从 env 的
  `CROSS_AGENT_TEAMS_MCP_TOKEN` 自动读取 (本文 token 策略下已存在, 需
  `start-xats` 至少运行过一次), 也可显式
  `--var CROSS_AGENT_TEAMS_MCP_TOKEN=<TOKEN>`.
- 不加 `-y` 时交互 prompt 会问 `CROSS_AGENT_TEAMS_MCP_TOKEN` (掩码输入), 必须
  输入 daemon 的 token, 直接回车 = 跳过 = 之后 401.  token 值查看:
  `echo $CROSS_AGENT_TEAMS_MCP_TOKEN` (或 `cat ~/.config/xats/token`).
- **旧版 (<= 0.4.7) 的 `-y` 会无条件跳过 token, 不要用旧版**.
- mcpsmgr 不读环境变量, token 只能交互输入.  如果你 (agent) 无法做交互输入,
  先跑命令再直接编辑生成的 `opencode.json`, 补上 header:

```json
{
  "mcp": {
    "cross-agent-teams": {
      "type": "remote",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" },
      "enabled": true
    }
  }
}
```

- `opencode.json` 含明文 token, 确认它在 `.gitignore` 里或用户接受入库.

### 3.2 codex — 无需项目级步骤

codex 的 xats MCP 配置是设备级的 (2.2 节), 项目里**不需要**跑 mcpsmgr.
注意: 旧版 (<= 0.4.7) `mcpsmgr add ... -a codex` 不带 `--global` 时只写项目级
`.codex/config.toml`, 它在 `--remote` 模式下对 MCP 不生效, 写了也没用; 新版请
用 2.2 节的 `--global` 形式 (设备级一次).

### 3.3 claude-code

在项目根目录:

```bash
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code
```

写入项目 `.mcp.json` 两个 server: `cross-agent-teams` (http 工具面) 和
`cross-agent-teams-channel` (stdio channel).  之后用 2.1 节的 `xats-claude` /
`free-xats-claude` 启动 (`server:` 后缀名必须与 channel server 的 key 一致).

## 4. 日常启动与 agent 侧注册

| 命令 | 效果 |
| --- | --- |
| `free-xats-codex` | yolo codex, 连 app-server, tmux pane 预注册 |
| `xats-codex` | 同上, 正常审批模式 |
| `free-xats-opencode` | yolo opencode, 随机端口 + push 唤醒 |
| `xats-opencode` | 同上, 正常审批模式 |
| `free-xats-claude` / `xats-claude` | claude-code, 挂 xats channel |

额外参数原样透传, 如 `xats-opencode --model glm-5.2`.

启动后, agent 会话内调 `register_agent` 注册, 关键参数按 agent 类型:

- **codex**: `agent_type="codex"`, `thread_id=$CODEX_THREAD_ID` (必填),
  **不要传 `ui_pid`** (会关掉 pre-register 的 pane 自动绑定路径).
- **opencode**: `agent_type="opencode"`, `base_url=$OPENCODE_XATS_BASE_URL`,
  省略 `session_id` (daemon 自动解析).
- **claude-code**: `agent_type="claude-code"`, `ui_pid=$PPID`.
- 通用: 不显式指定 `team` 时传 `project_dir=$PWD`, daemon 用目录名派生 team.

## 5. 验证清单

1. `nc -z 127.0.0.1 9100` 和 `nc -z 127.0.0.1 8799` 都通.
2. 在 tmux 里 `free-xats-codex` 启动, 会话内 `register_agent` 成功且响应**不带
   `hint`** (带 hint = pane 自动绑定没成功).
3. `free-xats-opencode` 启动, 会话内 `printenv OPENCODE_XATS_BASE_URL` 非空,
   `register_agent` 返回 `agent_id`.
4. 从另一个已注册 agent `send_message` 给新 agent, 返回 `poked: true`, 且新
   agent 被唤醒并能 `get_inbox` 读到.

## 6. 常见坑排查

| 症状 | 原因与处理 |
| --- | --- |
| `[xats] failed to start codex app-server` | codex CLI 未安装/不在 PATH, 或 8799 被其他进程占用.  手动跑 `codex app-server --listen ws://127.0.0.1:8799` 看原始报错 |
| `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` | 实为 daemon 401: app-server 启动时看不到 token env.  在 export 过 token 的 shell 里重启 (`stop-xats` + `start-xats`) |
| codex 里看不到 xats 的 MCP 工具 | MCP 配置没在 app-server 读的 CODEX_HOME (全局 `~/.codex/config.toml`), 或缺顶级 `experimental_use_rmcp_client = true` |
| 配置了 token 还是 401 | 用了旧写法 `[mcp_servers.X.headers]` (0.130+ 静默忽略); 或项目级 `.codex/config.toml` 残留盖掉了全局鉴权.  审计: `find ~ -path '*/.codex/config.toml' -print` |
| codex session 目录不对 | launcher 丢了 `-C "$PWD"` |
| `register_agent` 响应带 `hint` | 不在 tmux 内, 或 pre-register 失败/过期 (120s TTL).  功能可用, 只是无 pane 自动绑定; 需要时 `bind_runtime_identity` 手动绑 |
| opencode 收不到 push 唤醒 | 没用 launcher 启动 (缺 `OPENCODE_XATS_BASE_URL`), 或注册时没传 `base_url` |
| daemon 重启后工具全部 `unknown_session` / `unknown_agent` | 重连 MCP server 后 `reconnect(ui_pid)` 或 `register_agent` 恢复身份 |

## 7. mcpsmgr 版本要求

本文的 mcpsmgr 步骤需要 **mcpsmgr >= 0.4.8** (`npx -y mcpsmgr@latest` 即满足).
相对旧版 (<= 0.4.7) 的关键差异:

1. `add -a codex` 自动在目标 config.toml 顶级补
   `experimental_use_rmcp_client = true` (新版 codex 已默认 rmcp client, 此键为
   旧版兼容性写入, 已存在则不动).
2. codex token 落成 `bearer_token_env_var = "CROSS_AGENT_TEAMS_MCP_TOKEN"` (名字
   取自 xats manifest `envVars[].name`), 不再写明文 Authorization; token 缺失时
   空 `http_headers` / `headers` 整块省略 (opencode 有 token 时仍是明文 Bearer,
   其配置格式无 env 引用机制).
3. `--global` (仅 codex 支持): 写全局 `~/.codex/config.toml`, 即 2.2 节的一步式
   入口; 其他 agent 传 `--global` 会报错退出.
4. 非交互 token: 可重复 `--var NAME=VALUE`, 取值优先级 --var > process.env >
   交互 prompt; env 有值时 `-y` 不再静默跳过.

旧版没有以上行为 (codex 只写项目级配置且缺 rmcp 开关, token 明文/被 `-y` 静默
跳过), 不要用旧版跑本文流程.
