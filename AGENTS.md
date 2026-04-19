# 00-general
<!-- rulesmgr: profile=mine languages= deployed=2026-04-15T02:16:19.388Z -->

- 永远使用简体中文对话
- 禁止读取: .env, .env.local, .env.dev, .env.prod (敏感内容)
- .md 文档用中文, 标点用英文(逗号后加一个空格, 句号后加两个空格)
- 代码中字符串(print, debug 输出等)标点用英文
- 正式文档写到 docs/, 讨论文档写到 discuss/
- 代码中不写解释性注释和文档, 只在必要时写意图性注释, 注释和 docstring 用英文
- commit 时不添加编程工具为合作者
- 别推测用户的意图去行动, 精确的执行用户的命令
- NestJS vs Next.js 存在歧义时确认(Next.js 有"."分隔)
- 合并冲突自动解决, 优先保留自定义修改
- WebFetch 失败用 Jina MCP 重试
- openspec 复杂流程前确认用户已开启 bypass permissions
- 在 worktree 下工作时, openspec 相关命令也需要在 worktree 目录下执行
- 当工作目录有未提交的变更, 且接下来的操作需要 stash 才能进行时, 中断操作并提醒用户, 不要自动 stash

---

# 01-tech-stack

- 语言: Rust(主), Python, TypeScript(辅)
- 前端: React, Next.js, shadcn-ui, Radix UI, Tailwind CSS
- 后端: axum(Rust), NestJS(Fastify, Node.js), fastapi(Python)
- 数据库: Drizzle(Node.js)
- 包管理: pnpm, 打包: Vite
- 优先标准库, 用有类型的维护良好的库, 避免废弃 API

---

# 02-coding-principles

- **不可变性(关键)**: 永远创建新对象, 不要原地修改
- **文件组织**: 多个小文件优于少数大文件, 200-400 行为宜, 最多 800 行, 按功能/领域组织
- **错误处理**: 显式处理每一层错误, 不要静默吞掉
- **输入验证**: 在系统边界验证所有外部数据, 用 schema 验证
- **核心规则**: 先搜索已有代码 → 先复用已有模式 → 最小变更 → 不投机添加功能
- **DRY & YAGNI**: 三次重复再抽象, 只为当前需求编码
- **代码质量**: 行宽 ≤88, 函数 <50 行, 文件 <800 行, 嵌套 ≤3 层, 无硬编码, 无 mutation

---

# 03-architecture

# Architecture

## Directory Structure
- Keep related code together
- Separate concerns: UI, business logic, data access
- Use index files sparingly

## Module Design
- Clear public interfaces
- Hide implementation details
- Avoid circular dependencies

## Naming Conventions
- Files: kebab-case

---

# 04-testing

## Test rules

- TDD: 先写失败测试 → 最小实现 → 重构
- 结构: Arrange → Act → Assert
- 命名: test_[function]_[scenario]_[expected]
- 关注行为而非实现, 测试边界和错误路径
- 测试相关代码, 一定不要放在正常的代码文件中, 一定要放在测试相关的独立文件中

## E2E 功能测试工具

- **Web**: agent-browser 交互, 双层证据(accessibility snapshot + screenshot).  不可用时降级为 claude-in-chrome MCP
- **Mobile**: Appium WebDriver 连接模拟器, 用 accessibility id 定位, 每步截图
- **CLI**: 直接执行, 捕获 stdout/stderr 和 exit code
- **TUI**: tmux 隔离 session(-x 120 -y 40), send-keys 交互, capture-pane 轮询断言, 测试后清理
- **通用**: 无证据 = 未通过, 断言为主截图为辅, 矛盾则失败

---

# 05-git-commit

# Git Commit

## Commit Message Format
<type>: <description>

[optional body]

## Types
- feat: New feature
- fix: Bug fix
- docs: Documentation only
- style: Formatting, no code change
- refactor: Code change that neither fixes bug nor adds feature
- test: Adding or updating tests
- chore: Build process, dependencies, etc.

## Rules
- Use imperative mood: "add feature" not "added feature"
- Keep subject line under 50 characters
- Wrap body at 72 characters
- Commit early and often
- One logical change per commit
- 不要添加编程工具, 比如 claude 为合作作者

---

# 06-code-review

# Code Review

## Before Submitting
- Self-review your changes
- Ensure tests pass
- Check for debug code, console.logs
- Verify no secrets or credentials

## Review Checklist
- Does the code do what it claims?
- Are there any obvious bugs?
- Is error handling adequate?
- Is the code readable and maintainable?
- Are there any security concerns?

## Feedback Style
- Be constructive, not critical
- Explain the "why" behind suggestions
- Distinguish between blocking issues and suggestions

---

# 07-design-patterns

## Design Patterns

### Repository Pattern

Encapsulate data access behind a consistent interface:
- Define standard operations: findAll, findById, create, update, delete
- Concrete implementations handle storage details (database, API, file, etc.)
- Business logic depends on the abstract interface, not the storage mechanism
- Enables easy swapping of data sources and simplifies testing with mocks

### API Response Format

Use a consistent envelope for all API responses:
- Include a success/status indicator
- Include the data payload (nullable on error)
- Include an error message field (nullable on success)
- Include metadata for paginated responses (total, page, limit)

---

# 08-backend-rest-api-desgin

- URL: 名词复数, kebab-case, 无动词, 如 `/api/v1/team-members`
- 正确使用 HTTP 方法和状态码(200/201/204/400/401/403/404/409/422/429/500)
- 用 Zod/Pydantic 做 schema 验证
- 列表接口实现分页: 小数据集用 offset, 大数据集用 cursor
- 排序: `?sort=-created_at`, 过滤: `?status=active`, 搜索: `?q=keyword`
- 版本: URL 路径 `/api/v1/`, 最多维护两个活跃版本
- 认证: Bearer token 或 API key
- 配置 rate limiting, 响应不泄露内部细节

## 响应格式

```json
// 成功
{ "data": { ... } }

// 集合(分页)
{ "data": [...], "meta": { "total": 142, "page": 1, "per_page": 20, "total_pages": 8 } }

// 错误
{ "error": { "code": "validation_error", "message": "...", "details": [{ "field": "email", "message": "...", "code": "..." }] } }
```