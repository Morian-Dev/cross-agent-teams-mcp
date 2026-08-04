# xats Team Workflow — 多 Agent 团队协作

## 架构

```
┌─────────────────────────────────────────────────┐
│                  xats daemon                     │
│              (port 9100, SQLite)                 │
│  消息路由 / 邮箱 / poke 唤醒 / agent 注册         │
└──────┬──────────────┬──────────────┬────────────┘
       │              │              │
   channel-proxy  channel-proxy  channel-proxy  ...
       │              │              │
  ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
  │architect│   │developer│   │ tester  │  ...
  │ 指挥官   │   │ 开发工人 │   │ 测试工人 │
  └─────────┘   └─────────┘   └─────────┘
       │              │              │
  ┌────┴──────────────┴──────────────┴────┐
  │            tmux dashboard             │
  │  ┌──────────┐  ┌──────────┐          │
  │  │architect │  │developer │          │
  │  ├──────────┼  ├──────────┤          │
  │  │  tester  │  │ reviewer │          │
  │  └──────────┘  └──────────┘          │
  └──────────────────────────────────────┘
```

## 角色体系

| 角色 | 职责 | 行为 |
|------|------|------|
| **architect** | 指挥官 | 分配任务、协调决策、检查 worker 报告 |
| **developer** | 开发工人 | 代码实现、重构、bug 修复 |
| **tester** | 测试工人 | 测试用例、验证、质量检查 |
| **reviewer** | 审查工人 | 代码审查、架构审查、安全检查 |

### Worker 自动回复规则

Worker 收到 daemon 的 `新邮件` 通知后：
1. **立即**调 `get_inbox`，不等待用户
2. 对每条 `need_reply: true` 的消息，**立即回复**确认
3. 完成任务后，主动 `send_message` 给 architect 报告
4. **禁止**进入 manual mode 等待用户

Architect 收到 worker 的报告后，检查并决定下一步。

## 安装（新电脑）

```bash
# 克隆
git clone https://github.com/Morian-Dev/cross-agent-teams-mcp.git ~/go/src/cross-agent-teams-mcp
cd ~/go/src/cross-agent-teams-mcp

# 一键安装（克隆 AoE、编译 daemon、安装依赖）
./scripts/setup.sh
```

## 日常使用

### 新建团队

```bash
sh team.sh new ~/go/src/myproject myteam

# 自定义 agent 列表
sh team.sh new ~/go/src/myproject myteam architect coder qa
```

### 恢复团队（关机后）

```bash
sh team.sh resume ~/go/src/myproject myteam
```

`resume` 自动检测之前的 agent 和 session ID，恢复对话。

### 查看状态

```bash
sh team.sh status
```

### 停止 daemon

```bash
sh team.sh stop
```

### 离开 / 回来

```bash
# 离开：Ctrl+b d（不要点 X 关窗口）
# 回来：
tmux -L auto-<team> attach -t dashboard
```

## tmux 面板操作

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+b d` | 离开（detach） |
| `Ctrl+b ←↑↓→` | 切换面板 |
| `Ctrl+b z` | 当前面板全屏/恢复 |
| `Ctrl+b [` | 滚动模式 |

## 通信模式

```
# Architect 分配任务
send_message("developer", "实现功能 X")

# Architect 广播
broadcast("架构评审开始")

# Worker 完成任务
send_message("architect", "功能 X 完成，PR #123")

# Worker 状态更新
send_message("architect", "功能 X 进度 50%")
```

## daemon 生命周期

- **启动**：`team.sh new` 或 `team.sh resume` 自动启动
- **停止**：`team.sh stop`
- **数据持久化**：`~/.cross-agent-teams-mcp/data.db`（SQLite）
- **日志**：`/tmp/xats-daemon.log`

## 源码修改记录

相对于上游 `jtianling/cross-agent-teams-mcp`，本 fork 做了以下改动：

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/daemon/runtime-identity.ts` | `listPanes()` 使用 `resolveTmuxSocket()` | 修复非默认 tmux socket 下 `bind_runtime_identity` 失败 |
| `src/mcp/auto-bind-channel.ts` | 新增 `updateDelivery()` 方法 | 跳过 fanout liveness 检查，支持反向自动绑定 |
| `src/mcp/tools.ts` | 反向自动绑定 + `findByRuntimeUiPid` 查找 | channel proxy 重连时自动更新 agent delivery |
| `src/mcp/transport.ts` | MCP 指令增加角色分工规则 | Worker 自动回复、Architect 指挥调度 |
| `src/daemon/cleanup.ts` | channel proxy TTL 从 30 天改为 24 小时 | 避免数据库堆积垃圾行 |
| `scripts/setup.sh` | 新增 | 一键安装脚本 |
| `scripts/team.sh` | 新增 | 团队启动/恢复/停止/状态 |

## 换电脑

```bash
# 1. 安装
git clone https://github.com/Morian-Dev/cross-agent-teams-mcp.git ~/go/src/cross-agent-teams-mcp
cd ~/go/src/cross-agent-teams-mcp && ./scripts/setup.sh

# 2. 恢复团队
./scripts/team.sh resume ~/go/src/新项目 新项目名
```