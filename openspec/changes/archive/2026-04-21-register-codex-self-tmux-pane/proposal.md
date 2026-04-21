## Why

当前 `register_codex_self` 已经是 Codex 的推荐注册入口, 但它只会登记 `codex-appserver` delivery, 不会顺手保存 `tmux_pane_id`.  这让很多 Codex agent 在成功注册后仍然缺少 tmux 可达性, 既削弱了 `list_agents` 的可观察性, 也让后续需要 tmux 备用触达的场景变得脆弱.

仓库已经提供了 `detect_tmux_pane` 工具和 `register_agent` 的强提示, 但 agent 往往把 `register_codex_self` 视为一步到位的高层入口, 不会额外主动调用 pane 探测.  现在需要把这条最佳实践收束到 `register_codex_self` 自身, 让 Codex 推荐路径默认拥有完整注册信息.

## What Changes

- 扩展 `register_codex_self`, 使其在探测并登记 `codex-appserver` delivery 的同时, 也以 best-effort 方式登记 `tmux_pane_id`.
- 为 `register_codex_self` 增加可选的 pane 定位输入, 允许调用方直接提供 `tmux_pane_id`, 或提供 `cwd` / `tty` / `title_contains` 等 hint 来帮助复用现有 `detect_tmux_pane` 逻辑.
- 明确 `register_codex_self` 的 tmux pane 探测失败或结果歧义时, 工具仍然成功返回 Codex delivery 注册结果, 不因 pane 侧信息缺失而阻塞主流程.
- 更新工具描述与使用文档, 把 `register_codex_self` 表述为 “Codex app-server delivery + tmux pane best-effort registration” 的推荐路径, 降低 agent 漏掉 pane 登记的概率.
- 保持现有 `codex-appserver` 运行时分派语义不变: 显式 Codex delivery 失败时, 不自动 fallback 到 tmux.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-registry`: `register_codex_self` 从 “只登记 codex-appserver delivery” 升级为 “登记 codex-appserver delivery, 并 best-effort 保存 tmux pane 信息”.

## Impact

- 注册工具与服务: `src/mcp/register-codex-self.ts`, `src/mcp/tools.ts`
- tmux pane 探测复用: `src/daemon/tmux-pane-detect.ts` 的调用方式与相关接线
- 测试: `tests/register-codex-self.test.ts`, 以及必要的 tool-level 测试
- 文档: `README.md`, `README.zh-CN.md`, `docs/configs/codex-cli.md`
