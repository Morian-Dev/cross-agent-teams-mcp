# TODOS

实现期待办, 对应 `discuss/design-agent-teams-mcp-20260414.md` 的 Reviewer Concerns + Failure modes.

## P1 (必须实现前定死)

- [ ] **Phase 0 连通性**: `tests/e2e-connectivity.test.ts` - 三家 agent (opencode / Claude Code / Codex CLI) 分别连 HTTP MCP daemon 跑 echo tool 通. 任一失败走 stdio-proxy Plan B. 见 design#16.
- [ ] **SQLite 异常捕获**: daemon 外层 catch, disk full / WAL 锁死时返回 `{ error: 'storage_unavailable' }`, 不静默 500. 见 design Critical gaps.
- [ ] **events 表清理安全**: 清理前读最老在线 agent 的 `last_processed_event_id`, 仅清理所有 client 已确认消费的范围. 见 design Critical gaps.

## P2 (阶段 3 前定死)

- [ ] **breaking 判定规则**: type 字符串变更 + required false→true + 移除字段 = breaking. 其他情况 non-breaking. 见 design concerns#1.
- [ ] **task_claim already_claimed 带 owner**: `{ error: 'already_claimed', owner: agent_id }`. 见 concerns#3.
- [ ] **task_complete 非 claimer 拒绝**: `{ error: 'not_owner' }`. 见 concerns#4.
- [ ] **token 鉴权失败响应**: 401 + `{ error: 'invalid_token' }`; agent_id 与 session 不符 403. 见 concerns#7.
- [ ] **并发 register_contract 同 name**: SQLite 事务串行化, 版本号顺序递增. 见 concerns#8.
- [ ] **JSON Pointer 嵌套路径修正**: 写 `/properties/user/properties/id` 不是 `/properties/user/id`. 见 concerns#10.
- [ ] **stdio-proxy Plan B 实现**: 如 Phase 0 失败, 写 ~100 行的 stdio MCP proxy 子包. 见 concerns#11.

## P3 (性能/体验)

- [ ] **better-sqlite3 worker threads 阈值**: 阶段 1 实测后, 批量操作或 contract diff 计算迁到 `node:worker_threads`. 见 concerns#12.
- [ ] **阶段 3 工期 5 天上限**: 不是 3 天. 见 concerns#13.

## 未来扩展 (NOT in MVP)

- [ ] OpenAPI / proto schema 格式支持
- [ ] Contract 历史 UI 展示
- [ ] cross-machine 协作
- [ ] message 加密 / 审计签名
- [ ] CI/CD 自动发版
- [ ] 30+ 天 events 归档策略

---
参考文档: [discuss/design-agent-teams-mcp-20260414.md](./discuss/design-agent-teams-mcp-20260414.md)
