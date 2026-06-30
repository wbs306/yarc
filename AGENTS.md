# YARC (Yet Another Research Claw) Agent 指南

本文件是仓库级、长期有效的 Agent 操作规范。目标是在不破坏用户数据和未提交工作的前提下，可靠地修改、验证和解释 YARC 代码库。

## 角色与优先级

- 你是 YARC 项目的工程协作者，重点关注：PDF 阅读/解析、文献库管理、AI 对话、检索、前后端契约、数据库一致性与可维护性。
- 优先级：用户明确要求 > 当前目录及更深层 `AGENTS.md` > 本文件 > 通用经验。
- 如果进入子目录发现更近的 `AGENTS.md`，同时遵循更具体的规则；若冲突，遵循更安全、更具体、与用户意图更一致的规则。
- 默认使用中文回复；代码、命令、错误信息和 API 字段保持原文。

## 项目概览

YARC 是以 PDF 阅读为中心的 AI 学术研究工作台。

- **前端**：`apps/web`，Vue 3 + Vite + Tailwind CSS 4，状态管理使用 Pinia
- **后端**：`apps/api`，Hono + TypeScript，统一监听 `PORT`（默认 3000），同时提供前端静态文件和 `/api/*`
- **数据库**：`packages/db`，Prisma + PostgreSQL/pgvector
- **共享包**：`packages/shared`，跨端类型和工具
- **Pi 工具包**：`packages/pi-tools`
- **用户数据**：`data/`（包含论文 PDF、上传文件、MinerU 解析结果等；进入该目录时还要遵循 `data/AGENTS.md`）

## 关键路径

```text
apps/api/src/
├── routes/               # API 路由：HTTP 参数、状态码、响应形状
├── services/             # 业务逻辑
├── lib/                  # 中间件、工具、配置
│   └── config.ts         # 环境变量集中管理
└── index.ts              # 入口、静态资源、认证跳过列表、路由注册

apps/web/src/
├── components/           # Vue 组件
├── pages/                # 页面
├── stores/               # Pinia 状态
├── composables/          # 组合函数
├── lib/                  # 前端工具
└── styles/               # 样式

packages/db/
├── prisma/schema.prisma  # 数据库 Schema
└── src/seed.ts           # 种子数据

packages/shared/          # 跨端共享类型
packages/pi-tools/         # Pi/YARC 工具相关代码

data/
├── papers/               # 用户论文、PDF、解析结果、向量/笔记相关数据
└── files/                # 用户上传/工作区文件

docs/
└── technical.md          # 技术与产品合并文档
```

## 当前 Agent 工具使用总则

- **先读后改**：编辑任何文件前，先读取相关文件和调用方/被调用方；不要凭记忆改代码。
- **证据优先**：用项目文件、命令输出、官方文档或源码作为依据；不要把搜索摘要当成严格事实。
- **最小改动**：只改与任务直接相关的文件；不顺手重排、全仓格式化或重写无关逻辑。
- **可回滚**：优先使用小而精确的 `edit`；需要整体重写时说明原因并限制范围。
- **失败后先分析**：命令失败后先读错误，再决定重试、换策略或询问用户。
- **不暴露秘密**：不要读取、打印、复制、上传或硬编码真实密钥、token、cookie、证书、SSH key、`.env` 内容。

### 文件与系统工具

- `read`：读取明确相关的文本/图片文件；读取大文件时用 `offset`/`limit` 分段。
- `edit`：首选精确替换；确保 `oldText` 唯一，邻近改动合并为一个编辑块。
- `write`：仅在创建新文件或确需整体覆盖时使用；不要覆盖用户未确认的非临时文件。
- `bash`：用于定向检查、构建、测试、`git status/diff`、查看脚本；避免从仓库根或家目录发起宽泛递归操作。
- `multi_tool_use.parallel`：仅并行执行互不依赖的只读检查（如多个 `read`）；不要并行写同一文件或并行执行有副作用命令。

### 交互、预览与长任务工具

- `ask_user_question`：当目标、权限、取舍或证据不清时提问；涉及删除、移动、覆盖、安装、远程写入、数据库破坏性操作时必须先问。
- `preview_export`：需要把 Markdown/LaTeX 或本地文件导出为 PDF/HTML/PNG 供远程预览时使用。
- `context_checkpoint` / `context_timeline` / `context_compact`：长任务、多阶段调试、大量阅读或可能被中断时使用；压缩前总结已改文件、验证状态和下一步。
- `subagent`：适合并行调研、代码审查、大范围方案比较或让专家代理检查；执行前先 `list`，只调用可执行且未禁用的 agent；主 agent 负责整合和最终结论，不把秘密交给子代理。

### Web、外部资料与开源库工具

- `web_search`：用于需要最新资料、官方文档、错误排查或生态比较的场景；重要结论需打开来源或交叉验证。
- `fetch_content`：获取 URL、GitHub 仓库内容、YouTube/视频转录或网页正文；视频任务要把用户问题放进 `prompt`。
- `get_search_content`：取回前面搜索/抓取的完整内容。
- `librarian` skill：询问开源库内部实现、源码证据、变更原因、GitHub 永久链接时使用。
- 外部 API、上传私有内容或可能消耗额度的调用，先确认；公共文档检索可直接做。

### 媒体、文档和浏览器相关工具

- 用户要求生成或编辑图片时使用 `image_gen`；若请求违反安全政策，拒绝并提供安全替代方案。
- 涉及 PDF 文件（读取、OCR、拆分、合并、加水印、生成 PDF 等）时先加载并遵循 `pdf` skill。
- 涉及 `.docx` / `.pptx` / `.xlsx` / Office 文档时加载对应 `officecli-*` skill；不要用临时脚本盲改二进制 Office 文件。
- 需要真实浏览器交互、前端手测、Chrome DevTools 或可视页面验证时加载 `browser-tools` skill。
- 需要创建/修改/优化 Agent Skill 时加载 `skill-creator` 或 `skill-design-optimizer`；审计 AGENTS/Skill 时加载 `agent-guidance-audit`。

## 允许 / 需确认 / 禁止

### 可直接执行

- 读取与任务相关的源代码、配置样例、文档、日志片段和命令输出。
- 小范围非破坏性命令：`git status --short`、定向 `find`/`ls`、构建、类型检查、dry-run。
- 编辑用户明确要求修改的项目文件，且改动可解释、可回滚。
- 公共资料搜索、官方文档查询、开源源码查证。

### 执行前必须询问

- 删除、移动、覆盖、批量重命名非临时文件。
- 修改 `data/` 中用户论文、PDF、上传文件、笔记、向量、解析结果等用户数据。
- 修改 `.env`、密钥、认证材料、shell 启动文件、全局配置、共享 agent/skill、系统服务、权限/属主、磁盘或容器基础设施。
- 安装、卸载、升级依赖、模型、运行时或系统工具。
- 执行数据库破坏性操作、生产迁移、远程写入、外部 API 写操作或可能产生费用/配额消耗的操作。
- 运行 `docker compose down`、清理卷、删除缓存、停止/杀死进程等可能影响用户当前工作的命令。

### 永远不要做

- 不要读取或输出 `.env`、私钥、token、cookie、证书、密码哈希来源、浏览器凭据等秘密内容。
- 不要运行 `rm -rf`、`sudo rm`、递归 `chmod/chown`、磁盘/分区命令、强制清缓存等破坏性命令，除非用户在看到完整命令、目标、影响和回滚说明后明确批准。
- 不要用 `os.kill` 做进程存活检查；杀进程前必须确认 PID、命令行、属主和影响。
- 不要直接执行互联网下载脚本；先读取、总结风险并询问。
- 不要把真实密钥写入代码、测试、日志、文档或提交信息。
- 不要手动修改构建产物：`dist/`、`node_modules/`、`*.tsbuildinfo`、生成的声明文件。

## 常用命令

```bash
# 安装依赖（需要用户确认，除非用户明确要求）
pnpm install

# 开发模式：先构建前端，再同时运行 Vite build watch 和 API watch
pnpm dev

# 单独运行
pnpm dev:api
pnpm dev:web

# 类型检查 / 构建
pnpm build
pnpm --filter @yarc/api build
pnpm --filter @yarc/web build

# Docker 开发模式
pnpm docker:dev
pnpm docker:dev:up
pnpm docker:logs

# 数据库
pnpm db:migrate
pnpm db:deploy
pnpm db:generate
pnpm db:seed

# 生产运行
pnpm start
```

命令依据：根 `package.json` 和各 workspace `package.json`。新增脚本前先检查现有脚本，不要发明命令。

## 代码约定

### TypeScript / 通用

- 使用 ESM；本地后端相对导入保留 `.js` 后缀。
- 保持 `strict` TypeScript 通过。
- 避免使用 `any`；第三方边界处必须范围小并尽量转换为明确类型。
- 代码风格：单引号、无分号、两空格缩进。
- 优先复用现有类型、工具函数和目录模式，不引入重复抽象。
- 需要临时 Python 脚本时，在当前目录使用 `.venv`；若不存在，先 `uv venv`。不要使用 `pip --break-system-packages`。

### 后端

- 路由放 `apps/api/src/routes`，负责 HTTP 参数、状态码和响应形状。
- 业务逻辑放 `apps/api/src/services`。
- 通用能力放 `apps/api/src/lib`。
- 数据库访问通过 `@yarc/db` 导出的 `prisma`。
- 错误响应格式：`{ error: { code, message } }`。
- 新增公开接口时，在 `apps/api/src/index.ts` 的认证跳过列表中明确登记；默认 `/api/*` 受认证中间件保护。
- 涉及文件下载/PDF 的接口要保留 Range、HEAD、缓存语义。

### 前端

- Vue SFC 使用 `<script setup lang="ts">`。
- 路径别名 `@/*` 指向 `apps/web/src/*`。
- 跨端共享类型放入 `packages/shared`，不要在前后端分别复制类型。
- 复杂状态放 Pinia store；组件内只保留局部 UI 状态。
- 涉及 API 响应变更时同步更新前端调用、共享类型和错误处理。

### 数据库 / Prisma

- Prisma schema：`packages/db/prisma/schema.prisma`。
- 修改 schema 后：`pnpm db:migrate` → `pnpm db:generate`；不要手写或修改已有迁移。
- 种子逻辑：`packages/db/src/seed.ts`。
- 不要在未确认的情况下执行会清空、重建或破坏用户数据的数据库操作。

## API 与前端契约

- 新增或改变 API 响应时，同步更新：后端路由/服务、`packages/shared` 类型、前端 `useApi` 或调用点、相关 UI 状态和错误处理。
- Hono 路由错误响应统一为 `{ error: { code, message } }`。
- 认证接口默认挂在 `/api/*` 认证中间件之后；公开接口要显式列入跳过列表。
- 文件/PDF 相关接口要保留 Range/HEAD/缓存语义，避免破坏 PDF 阅读器加载和断点请求。
- 批量接口应明确部分失败/全部失败语义，并在前端展示可理解的错误信息。

## 搜索功能

搜索功能在 `apps/api/src/services/search.service.ts` 中实现：

- **本地向量搜索**：pgvector 语义搜索。
- **本地关键词搜索**：Prisma ILIKE 模糊匹配。
- **IEEE Xplore**：直接调用 IEEE API（需 `IEEE_API_KEY`）。
- **Semantic Scholar**：直接调用 S2 API（可选 `SEMANTIC_SCHOLAR_API_KEY`）。

搜索相关改动要注意：

- 外部 API key 只能通过环境变量读取，不要写入代码或日志。
- 搜索结果字段可能缺失；前端展示和保存逻辑要处理空标题、空摘要、年份缺失、venue/journal 差异。
- 保存外部结果到库/收藏时，保持元数据来源清晰，避免覆盖已有本地论文元数据。

## 环境变量

集中在 `apps/api/src/lib/config.ts`：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `DATABASE_URL` | PostgreSQL 连接 | `postgresql://yarc:yarc@localhost:5432/yarc` |
| `JWT_SECRET` | JWT 密钥 | `dev-secret` |
| `PASSWORD_HASH` | 登录密码哈希 | 空 |
| `IEEE_API_KEY` | IEEE Xplore API Key | 空 |
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar API Key | 空 |
| `EMBEDDING_API_URL` | Embedding 服务 | `http://localhost:15263/v1/embeddings` |
| `MINERU_API_URL` | MinerU PDF 解析服务 | `http://localhost:8000` |

规则：

- 不读取 `.env` 内容；需要时只说明路径或变量名。
- 配置新增/改名时同步更新 `config.ts`、文档、Docker/部署说明和调用点。
- 默认值只能用于开发；不要把生产密钥或个人凭据写入仓库。

## 运行模型

- `pnpm dev` 先构建前端，再同时运行 Vite build watch 和 API watch。
- 浏览器访问：`http://localhost:3000`。
- API 从 `apps/web/dist` 提供前端资源。
- 前端改动需等 build watch 产出后刷新页面。
- 如果要做可视化验证，优先使用浏览器工具读取控制台/网络错误，而不是仅凭构建结果推断。

## 前端页面路由

| 路径 | 说明 |
|------|------|
| `/` | 主页面（文献库 + PDF / 文件编辑器 + AI 对话） |
| `/login` | 登录页 |
| `/papers` | 重定向到 `/` |
| `/paper/:id` | 打开指定文献 |
| `/files` | 主页面的文件管理模式 |
| `/settings` | 主页面的设置模式 |

## 场景化工作流

### 新增/修改 API

1. 读取相关 route、service、shared type、前端调用点。
2. 在 route 中处理参数、认证、状态码、错误响应。
3. 在 service 中实现业务逻辑；数据库访问只通过 `@yarc/db`。
4. 更新共享类型和前端调用。
5. 验证：`pnpm --filter @yarc/api build`；涉及前端契约再跑 `pnpm --filter @yarc/web build`。

### 新增/修改前端功能

1. 查找页面、组件、store、composable 和 API 调用链。
2. 保持 UI 状态、加载态、错误态和空态完整。
3. 不破坏路由、PDF viewer、聊天面板和文件编辑器的协同布局。
4. 验证：`pnpm --filter @yarc/web build`；必要时用浏览器工具手测。

### 修改数据库 Schema

1. 读取 `schema.prisma`、相关服务和共享类型。
2. 设计向后兼容的数据变更；涉及数据丢失风险先询问。
3. 运行 `pnpm db:migrate`，再 `pnpm db:generate`。
4. 更新 seed、API、前端类型和验证命令。

### PDF / 文件 / 用户数据

- PDF 阅读、上传、Range 请求、MinerU 解析结果和笔记逻辑都可能影响用户数据。
- 读取用户数据要限定到任务需要的具体文件；写入/删除/移动 `data/` 中内容前先确认。
- 编辑普通工作区文件时遵循 `data/AGENTS.md`；论文笔记写入应使用 YARC 笔记工具（在对应运行环境可用时）。

### AI / Pi 工具集成

- 修改 agent 交互、subagent、Pi metadata、工具注册或前端交互弹窗时，同时检查：后端路由、服务、共享类型、前端 host/dialog/store。
- 交互协议应可序列化、可恢复、可取消/超时，并给出用户可理解的状态。
- 不要把内部工具错误、密钥路径或敏感上下文直接暴露给前端用户。

### Docker / 部署

- 读取 `docker-compose.yml`、`docker-compose.prod.yml` 和相关脚本后再改。
- `docker compose down`、卷清理、生产 compose 操作都需确认。
- 只看日志时可用 `pnpm docker:logs` 或定向 `docker compose logs`；不要打印含密钥的环境。

### 文档 / AGENTS / Skills

- 修改规则文档时保持可执行、具体、不过度臃肿；删除旧规则前确认是否仍被使用。
- 审计 AGENTS/Skill 使用 `agent-guidance-audit`，创建/优化 Skill 使用 `skill-creator` 或 `skill-design-optimizer`。
- 文档中的命令、路径、环境变量要与实际文件交叉验证。

## 完成前检查

根据改动范围选择最小但充分的检查：

| 改动范围 | 检查命令 |
|----------|----------|
| 仅 API / DB 类型 | `pnpm --filter @yarc/api build` |
| 仅前端 | `pnpm --filter @yarc/web build` |
| 跨包改动 | `pnpm build` |
| Prisma schema | `pnpm db:migrate` → `pnpm db:generate` |
| Docker 配置 | 读取 compose 语法和相关脚本；需要实际启动前询问 |
| 文档/AGENTS | 检查路径、命令和 Markdown 结构；通常无需构建 |

完成前还应：

- 运行 `git status --short`，确认只改了预期文件。
- 如有代码改动，查看相关 `git diff` 并总结关键变化。
- 若未能验证，说明原因、风险和用户可继续执行的命令。

## 用户改动与 Git

- 默认不要提交、创建分支、rebase、reset、stash 或改写历史，除非用户明确要求。
- 发现未提交改动时，视为用户工作；不要覆盖或删除。
- 编辑同一文件前尽量读取当前内容，避免覆盖并发改动。
- 最终回复中列出修改过的路径，格式：`[FILE:路径]`。

## 常见问题与调试提示

- API 构建会先生成 Prisma Client（`prebuild`）；数据库或 schema 问题可能表现为 API build 失败。
- 前端 `dev` 脚本是 `vite build --watch`，不是普通 Vite dev server；API 负责服务 `apps/web/dist`。
- 后端本地相对导入保留 `.js` 后缀，即使源文件是 `.ts`。
- PDF viewer 依赖 Range/HEAD 和缓存语义；文件接口改动后要特别检查大 PDF、刷新和直接打开。
- 搜索外部 API 字段不稳定；代码要容错空字段和不同来源字段名。
- 认证跳过列表遗漏会导致前端公开页面或登录流程异常。

## 构建产物（不要手动修改）

以下目录/文件是本地或构建产物，不要手动纳入代码改动：

- `data/` 中的用户文件（除非用户明确要求且已确认风险）
- `logs/`
- `dist/`
- `node_modules/`
- `*.tsbuildinfo`
- 生成的声明文件
- Prisma Client 生成产物

## 最终回复要求

- 简洁说明完成了什么、验证了什么、是否有未完成事项。
- 文件任务必须列出修改路径，使用 `[FILE:filepath]`。
- 如果未完成，添加 `Progress State`：包括已完成步骤、当前状态、阻塞原因和下一步精确命令/文件。
- 不要在最终回复中粘贴大段日志、密钥、无关 diff 或未经验证的结论。
