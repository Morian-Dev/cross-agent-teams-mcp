## ADDED Requirements

### Requirement: Codex CLI and Codex App use isolated runtime state

设备 setup guide SHALL 先询问用户是否希望 Codex App 也使用 xats.  CLI runtime MUST 始终使用独立于 App 默认状态的 `CODEX_HOME`.  用户启用 App xats 时, launcher SHALL 为 CLI 和 App 启动不同的 app-server 进程, App runtime MUST 保持 App 的默认 `CODEX_HOME`, 两个 runtime MUST 监听不同的 loopback endpoint.  用户不启用 App xats 时, launcher MUST 只管理 CLI runtime, 并保留 App 的原生启动方式.

#### Scenario: Same project has separate CLI and App sessions

- **WHEN** 用户通过 `xats-codex` 和 `xats-codex-app` 打开同一个 project directory
- **THEN** CLI thread 只存储在 CLI runtime 的 `CODEX_HOME`
- **AND** App thread 只存储在 App runtime 的 `CODEX_HOME`
- **AND** App 不得从自己的 app-server thread list 接管 CLI thread

#### Scenario: SSH CLI reconnects to the resident CLI runtime

- **GIVEN** CLI app-server 监听 loopback CLI endpoint 并使用独立 `CODEX_HOME`
- **WHEN** 用户通过 SSH 登录同一设备并运行 `xats-codex`
- **THEN** CLI TUI 连接到 CLI endpoint
- **AND** App runtime 的 session 不出现在该 CLI TUI 中

#### Scenario: User keeps the native App without xats

- **GIVEN** 用户明确选择不在 Codex App 中使用 xats
- **WHEN** setup 配置设备 launcher
- **THEN** launcher 只管理 CLI app-server 和 xats daemon
- **AND** launcher 不启动或停止端口 8800
- **AND** 用户继续从 macOS 图标原生启动 App
- **AND** guide 明确说明该 App 不接收 xats poke

### Requirement: Optional App runtime uses the matching App bundle

用户启用 App xats 时, App runtime SHALL 使用当前安装的 Codex 或 ChatGPT App bundle 内的 Codex binary.  App runtime MUST 启用 `features.code_mode_host=true`, MUST NOT 回退到 PATH 中版本可能不同的 Codex binary.  setup guide MUST 明确说明外部 app-server 模式当前不支持 ChatGPT in Chrome 插件.

#### Scenario: App bundle is available

- **GIVEN** `/Applications/Codex.app` 或 `/Applications/ChatGPT.app` 包含可执行的 `Contents/Resources/codex`
- **WHEN** `start-xats` 启动 App runtime
- **THEN** App app-server 使用该 bundle binary
- **AND** `xats-codex-app` 连接到 App 专用 endpoint
- **AND** guide 提醒用户此模式不能使用 ChatGPT in Chrome 插件

#### Scenario: App bundle is unavailable

- **GIVEN** 设备没有可用的 Codex 或 ChatGPT App bundle binary
- **WHEN** `start-xats` 运行
- **THEN** daemon 和可用的 CLI runtime 仍可启动
- **AND** launcher 输出 App runtime 被跳过的明确提示

#### Scenario: User prioritizes ChatGPT in Chrome

- **GIVEN** 用户需要在 Codex App 中使用 ChatGPT in Chrome 插件
- **WHEN** 用户选择不启用 App xats
- **THEN** guide 指示用户从 macOS 图标原生启动 App
- **AND** CLI xats runtime 继续使用 8799 和独立 `CODEX_HOME`
- **AND** guide 不承诺原生 App 可被 xats poke 唤醒

### Requirement: Device service lifecycle manages selected Codex runtimes

设备 setup guide SHALL 提供一个 `start-xats` 流程, 启动单个 xats daemon 和独立的 CLI app-server.  只有用户启用 App xats 时, launcher 才 SHALL 启动 App app-server.  launcher MUST 为所有已启用 Codex runtime 使用独立日志, 并把实际启动的 endpoint 作为候选列表提供给 daemon.

#### Scenario: Both runtimes start successfully

- **GIVEN** 用户启用 App xats, 且 CLI binary 和 App bundle binary 都可用
- **WHEN** 用户运行 `start-xats`
- **THEN** CLI app-server 监听 `ws://127.0.0.1:8799`
- **AND** App app-server 监听 `ws://127.0.0.1:8800`
- **AND** daemon 收到包含两个 URL 的候选 endpoint 配置

#### Scenario: Stop cleans up both runtime listeners

- **GIVEN** 用户启用 App xats, 且 daemon, CLI app-server 和 App app-server 都由 launcher 启动
- **WHEN** 用户运行 `stop-xats`
- **THEN** launcher 停止 9100, 8799 和 8800 的对应服务
- **AND** 不保留指向已停止 Codex runtime 的健康状态提示

#### Scenario: CLI-only stop leaves port 8800 untouched

- **GIVEN** 用户未启用 App xats
- **WHEN** 用户运行 `stop-xats`
- **THEN** launcher 只停止 9100 和 8799 的对应服务
- **AND** launcher 不查杀端口 8800 的 listener

### Requirement: CLI state initialization is explicit

设备 setup guide SHALL 要求 CLI `CODEX_HOME` 目录存在, 并在该目录下独立完成 Codex 登录和 xats MCP 配置.  setup MUST NOT 自动复制 App home 中的 auth 文件或完整状态目录.

#### Scenario: First-time CLI isolation setup

- **WHEN** 用户首次启用独立 CLI runtime
- **THEN** guide 指示创建 CLI home
- **AND** guide 指示在该 home 下执行登录和 MCP 安装
- **AND** App 默认 home 保持不变
