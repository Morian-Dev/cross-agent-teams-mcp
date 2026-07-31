## Context

当前 device launcher 只启动一个 `ws://127.0.0.1:8799` Codex app-server.  CLI 通过 `--remote` 连接该 server, Codex App 通过 `CODEX_APP_SERVER_WS_URL` 连接同一 server.  因为 app-server 进程拥有 `CODEX_HOME`, 两个 UI 实际共享 config, auth, sessions 和 plugin runtime.

现场验证还发现, npm 安装的 Codex app-server 与 ChatGPT App bundle 版本不一致时, App 会拒绝 browser native pipe peer.  即使改用匹配的 App bundle binary 并启用 `features.code_mode_host=true`, 通过外部 app-server 启动的 App 当前仍不能使用 ChatGPT in Chrome 插件.  因此 App xats 必须是显式 opt-in, 并在 setup 前向用户说明该取舍.

## Goals / Non-Goals

**Goals:**

- Codex CLI 始终使用独立的 app-server, endpoint 和 `CODEX_HOME`.
- CLI runtime 可在 SSH 登录后继续访问; 用户可选择 App xats runtime, 或保留支持 Chrome plugin 的原生 App 启动方式.
- `register_agent` 只依赖稳定 `thread_id` 即可自动选择正确 endpoint, 不要求 agent 记忆端口.
- 显式 `ws_url`, 旧单 endpoint 配置和无 App 设备继续工作.

**Non-Goals:**

- 不隔离同一 checkout 中的文件修改.  代码文件级隔离仍由用户选择 worktree.
- 不改变 Codex app-server JSON-RPC poke 协议或 delivery 持久化结构.
- 不把 loopback WebSocket 暴露到公网, 也不替代 Codex 官方 remote connection 功能.
- 不自动复制或共享两个 `CODEX_HOME` 的 auth 文件.
- 不让外部 app-server 模式同时支持 ChatGPT in Chrome; 当前只能由用户在 App xats poke 和 Chrome 插件之间选择.

## Decisions

### 决策 1: CLI 保留 8799, App 使用 8800

CLI runtime 继续使用 `ws://127.0.0.1:8799`, 以保持现有 `xats-codex` 和 SSH 使用习惯.  用户启用 App xats 时, App runtime 使用 `ws://127.0.0.1:8800`, `xats-codex-app` 只连接该 endpoint.  用户不启用时, launcher 不管理 8800, App 继续原生启动.

替代方案是让 App 保留 8799 并迁移 CLI, 但这会改变已有 CLI launcher 和默认 delivery 的主路径, 迁移面更大.

### 决策 2: 只有 CLI 使用独立 `CODEX_HOME`

CLI app-server 使用 `~/.codex-cli`, 可选 App app-server 保持默认 `~/.codex`.  这样 App 继续复用现有登录和 session 状态, CLI 获得独立 config, auth 和 sessions.  复用 App 状态不代表外部 app-server 可使用 Chrome 插件.  `CODEX_HOME` 必须设置在 app-server 进程上, remote TUI 不单独覆盖.

CLI home 只创建目录和文档化初始化步骤, 不自动复制敏感 auth 数据.  用户在该 home 下单独执行 Codex 登录和 xats MCP 安装.

### 决策 3: App server 必须来自当前 App bundle

可选 App runtime 只接受 `/Applications/Codex.app/Contents/Resources/codex` 或 `/Applications/ChatGPT.app/Contents/Resources/codex`.  启动时启用 `features.code_mode_host=true` 和 `--analytics-default-enabled`.  不允许 App runtime 回退到 PATH 中可能版本不一致的 npm binary.  这些约束用于保证 App/app-server 协议与版本匹配, 不承诺 ChatGPT in Chrome 可用.

CLI runtime 优先使用 PATH 中的 Codex, 没有独立 CLI 时可回退到 bundle binary.

### 决策 4: daemon 通过候选 endpoint 自动匹配 thread

新增 `CROSS_AGENT_TEAMS_CODEX_WS_URLS`, 值为 JSON string array.  每个元素必须是合法 `ws://` 或 `wss://` URL, 解析后去重并保留顺序.  选择优先级为:

1. `register_agent.ws_url`
2. 旧 `CROSS_AGENT_TEAMS_CODEX_WS_URL`
3. 新 `CROSS_AGENT_TEAMS_CODEX_WS_URLS`
4. 内置 `ws://127.0.0.1:8799`

当候选多于一个且调用方提供 `thread_id` 时, daemon 对所有候选执行 `initialize -> thread/resume`.  恰好一个 endpoint 成功时才注册并持久化该 URL.  零个成功返回聚合的连接或 resume 错误, 多个成功返回 `codex_endpoint_ambiguous`, 两种情况都不修改 agent row.

与让模型从 shell env 读取端口并显式传参相比, server-side matching 不依赖 prompt 遵循度, 对 context clear 和重新注册也更可靠.

### 决策 5: 一个 xats daemon 管理已启用的 Codex runtime

`start-xats` 始终启动 CLI app-server, 只在 `XATS_CODEX_APP_ENABLED=1` 时启动 App app-server, 再把实际 listener 组装成候选 endpoint JSON 提供给 daemon.  `stop-xats` 始终管理 9100 和 8799, 只在 App xats 启用时管理 8800.  xats mailbox, agent registry 和 device identity 仍由单个 daemon 和单个数据库管理.

## Risks / Trade-offs

- [Codex WebSocket 和 `CODEX_APP_SERVER_WS_URL` 仍属于非稳定接口] -> 将端口和启动逻辑集中在 launcher 文档, 保留显式 URL 覆盖, 并用聚焦测试锁定 xats 自身行为.
- [App bundle 更新后旧 server 仍在运行] -> setup guide 要求 App 更新后重启 xats services, App runtime 每次从当前 bundle 解析 binary.
- [外部 App runtime 不支持 ChatGPT in Chrome] -> setup 前强制询问用户是否启用 App xats; 需要 Chrome 时只启用 CLI xats 并原生启动 App.
- [CLI home 首次迁移时没有登录或 MCP 配置] -> 文档提供显式初始化检查, 不回退到共享 `~/.codex`.
- [同一个 thread 在多个候选 endpoint 都可恢复] -> 返回 `codex_endpoint_ambiguous`, 不猜测也不写入 delivery.
- [候选探测增加注册延迟] -> 只在未显式提供 URL 且配置多个 endpoint 时并行探测, 正常运行只有两个 loopback endpoint.

## Migration Plan

1. 创建 `~/.codex-cli`, 在该 home 下完成 Codex 登录和 xats MCP 配置.
2. 询问用户是否在 App 中启用 xats.  CLI server 始终使用 8799 和 CLI home; opt-in 时 App server 使用 8800 和 App bundle binary.
3. 重启 xats daemon 与已启用的 app-server, 再分别启动对应 thread.
4. opt-in 时验证两个 thread 注册出的 `delivery.ws_url` 不同且双向 poke 均成功, 同时明确记录 ChatGPT in Chrome 不可用.  不 opt-in 时验证 8800 不受 launcher 管理, App 原生启动并保留 Chrome 插件.
5. 回滚时恢复单 8799 launcher, 删除候选 endpoint env.  保留 `~/.codex-cli` 不会影响原 `~/.codex`.

## Open Questions

- Codex App 后续是否提供稳定的原生 control socket 或公开 wake API.  如果提供, 可用官方入口替换 App 专用 WebSocket, 不影响双 `CODEX_HOME` 设计.
