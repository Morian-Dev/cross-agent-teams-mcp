## Why

当前 `xats-codex` 和 `xats-codex-app` 连接同一个 Codex app-server, 因而共享 config, auth 和 sessions.  Codex App 打开与 CLI 相同的项目时会看到并接管 CLI thread.  外部 app-server 与 App bundle 版本不匹配时会导致 browser native peer 校验失败; 即使版本匹配, 外部 app-server 模式当前仍不能使用 ChatGPT in Chrome 插件.

## What Changes

- Codex CLI 始终使用独立的常驻 app-server 和 `CODEX_HOME`; 用户明确 opt-in 时, 再为 Codex App 启动独立 app-server.
- setup agent 在修改 launcher 前询问用户是否在 Codex App 中启用 xats, 并说明 App xats poke 与 ChatGPT in Chrome 当前不能同时使用.
- 可选 App runtime 固定使用当前 Codex 或 ChatGPT App bundle 内的 Codex binary, 并启用 desktop host 配置.
- CLI runtime 保持适合 SSH 的常驻 loopback endpoint, App runtime 使用独立 loopback endpoint.
- xats daemon 支持配置多个 Codex app-server 候选 endpoint, 并通过调用方提供的 `thread_id` 自动确定唯一所属 runtime.
- 保留显式 `ws_url` 和旧单 endpoint 环境变量的兼容行为.
- 更新设备 setup guide 和 Codex 配置文档, 说明双 runtime 的首次登录, MCP 配置和迁移步骤.

## Capabilities

### New Capabilities

- `codex-runtime-isolation`: 定义 Codex App 和 Codex CLI 的独立状态目录, app-server endpoint, 可选 launcher 行为和 Chrome 插件限制.

### Modified Capabilities

- `agent-registry`: Codex 注册在未显式提供 `ws_url` 时, 可从多个已配置 app-server endpoint 中自动匹配承载目标 `thread_id` 的唯一 runtime.

## Impact

- Codex 注册与探测: `src/mcp/register-codex-self.ts`, `src/mcp/tools.ts` 和相关测试.
- 设备 launcher 与文档: `README.agent.md`, `README.md`, `README.zh-CN.md`, `docs/configs/codex-cli.md`, `docs/launchers/free-xats-codex.md`.
- 本地运行形态从一个共享 Codex app-server 变为独立 CLI app-server, 加上用户可选的 App loopback app-server; xats daemon 仍保持单实例.
- 不改变已持久化的 `codex-appserver` delivery 结构, poke 继续使用注册时选定并保存的 `ws_url`.
