# YARC 技术与产品文档

本文档由原 `technical.md` 与 `design.md` 合并而来，是当前仓库的唯一权威项目文档。早期设计文档中的示例代码、伪数据库定义、旧技术选型和过时实现草案已移除。

## 项目概览

YARC（Yet Another Research Claw）是以 PDF 阅读为中心的 AI 学术研究工作台。

- **前端**：`apps/web`，Vue 3 + Vite + Tailwind CSS 4，状态管理使用 Pinia
- **PDF 阅读器**：`@embedpdf/vue-pdf-viewer` 与 EmbedPDF 插件体系
- **后端**：`apps/api`，Hono + TypeScript，统一监听 `PORT`（默认 3000），同时提供前端静态文件和 `/api/*`
- **数据库**：`packages/db`，Prisma + PostgreSQL/pgvector
- **共享包**：`packages/shared`，跨端类型和工具

## 产品与交互设计

### 核心理念

以 PDF 阅读为主工作区，将文献库、笔记、文件管理、检索和 AI 对话围绕当前文献组织。用户应能在“阅读 → 选中文本 → 提问/记录 → 检索/归档”的流程中少跳转、少等待。

### 功能优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | PDF 阅读器 | 打开文献、翻页、缩放、文本选择 |
| P0 | 文献列表 | 左侧文献库，支持分类、搜索、排序和上传入口 |
| P0 | AI 对话 | 右侧面板，支持选中文本作为上下文提问 |
| P1 | 笔记系统 | 关联文献和页码的笔记、选中文本记录 |
| P1 | 文献上传 | PDF 上传、解析、向量化和元数据补全任务 |
| P2 | 文献搜索 | 本地关键词/向量搜索与 IEEE、Semantic Scholar 外部搜索 |
| P2 | 文献总结 | 基于解析文本生成摘要 |
| P2 | 文件管理 | `FILES_DIR` 工作区浏览、编辑、上传、下载 |
| P3 | 外观设置 | 主题、背景图片和模型可用性配置 |

### 主界面结构

主页面由三栏组成：

- 左侧栏：文献库、文件管理、设置三个模式；文献库内包含分类、文献列表、上传和文献操作。
- 中间区域：PDF 阅读器或文件编辑器；无文献时显示空状态；文件模式下支持 CodeMirror 编辑和 Markdown 预览。
- 右侧栏：AI 对话面板；支持会话、分支、模型选择、推理力度、流式输出和停止生成。

核心交互流：

- 打开应用后进入主页面，登录成功后加载文献库和远端主题。
- 点击文献后进入 `/paper/:id`，中间区域加载 PDF，右侧对话可携带当前文献上下文。
- 在 PDF 中选择文本后，可用于 AI 提问或创建笔记。
- 上传 PDF 后创建解析任务；解析完成后自动触发向量化和元数据补全。
- 后台任务和文件变更通过 SSE 推送，前端按文献状态或文件事件刷新。

## 常用命令

```bash
# 安装依赖
pnpm install

# 启动 Docker PostgreSQL/pgvector
pnpm docker:db:up

# 初始化或更新数据库
pnpm db:migrate
pnpm db:seed

# 本地开发
pnpm dev

# 一步启动数据库和开发服务
pnpm docker:dev

# 类型检查 / 构建
pnpm build
```

## 运行模型

- 默认运行路径是宿主机 Node.js；Docker 只用于启动 PostgreSQL/pgvector。
- `pnpm dev` 会先构建前端，再同时运行 `apps/web` 的 Vite build watch 和 API watch。
- 浏览器访问入口为 `http://localhost:3000`。
- API 会从 `apps/web/dist` 提供前端资源；前端改动需要等 build watch 产出后刷新页面。
- `docker-compose.yml` 将 PostgreSQL 绑定到宿主机 `127.0.0.1:${POSTGRES_PORT:-5432}`。
- 应用默认数据库连接为 `postgresql://yarc:yarc@localhost:5432/yarc`。

## 目录结构

```text
yarc-v2/
├── apps/
│   ├── api/                          # Hono 后端
│   │   └── src/
│   │       ├── routes/               # 路由（按资源分）
│   │       ├── services/             # 业务逻辑
│   │       ├── lib/                  # 中间件、工具、配置
│   │       ├── data/                 # 内置数据，如期刊分级
│   │       └── index.ts              # 入口（API + WebSocket + 静态资源）
│   └── web/                          # Vue 前端
│       └── src/
│           ├── components/           # 组件
│           ├── pages/                # 页面
│           ├── stores/               # Pinia 状态
│           ├── composables/          # 组合函数
│           ├── lib/                  # 前端工具
│           └── styles/               # 样式
├── packages/
│   ├── db/                           # Prisma schema、client 导出、seed
│   └── shared/                       # 共享类型和工具
├── data/                             # 运行时数据
│   ├── papers/                       # PDF 文件
│   ├── files/                        # 用户文件工作区
│   ├── backgrounds/                  # 背景图片
│   └── postgres/                     # Docker 数据库数据
└── docs/
    └── technical.md                  # 当前合并文档
```

## 代码约定

### TypeScript

- 使用 ESM；本地后端相对导入保留 `.js` 后缀，例如 `../lib/config.js`。
- 保持 `strict` TypeScript 通过。
- 避免用 `any` 绕过类型，除非是在第三方接口、WebSocket、流式响应等边界处，且范围要小。
- 代码风格：单引号、无分号、两空格缩进。

### 后端（apps/api）

- 路由放在 `apps/api/src/routes`，负责 HTTP 参数、状态码和响应形状。
- 业务逻辑放在 `apps/api/src/services`。
- 通用能力放在 `apps/api/src/lib`。
- 数据库访问通过 `@yarc/db` 导出的 `prisma`，不要创建额外的 PrismaClient。
- 错误响应格式：`{ error: { code, message } }`。

### 前端（apps/web）

- 使用 Vue SFC 与 `<script setup lang="ts">`。
- 组件放 `apps/web/src/components`，页面放 `apps/web/src/pages`，Pinia store 放 `apps/web/src/stores`。
- 可复用请求逻辑放 `apps/web/src/composables`。
- 路径别名 `@/*` 指向 `apps/web/src/*`。
- 共享类型优先放入 `packages/shared`。

## 前端页面路由

当前路由由 `apps/web/src/router.ts` 定义：

| 路径 | 说明 |
|------|------|
| `/` | 主页面（文献库 + PDF / 文件编辑器 + AI 对话） |
| `/login` | 登录页 |
| `/papers` | 重定向到 `/` |
| `/paper/:id` | 打开指定文献 |
| `/files` | 主页面的文件管理模式 |
| `/settings` | 主页面的设置模式 |

## API 路由

### 公开或认证跳过

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/health
GET    /api/settings/models
GET    /api/pi/models
```

其余 `/api/*` 默认经过认证中间件。

### 文献管理

```text
GET    /api/papers
GET    /api/papers/search
POST   /api/papers
POST   /api/papers/upload
GET    /api/papers/:id
PUT    /api/papers/:id
DELETE /api/papers/:id
GET    /api/papers/:id/pdf
HEAD   /api/papers/:id/pdf
POST   /api/papers/:id/summarize
POST   /api/papers/:id/enrich
POST   /api/papers/:id/reparse
```

PDF 文件接口保留 `HEAD`、Range、ETag 和缓存语义。

### 分类与搜索分类

```text
GET    /api/categories
POST   /api/categories
PUT    /api/categories/:id
DELETE /api/categories/:id

GET    /api/search-categories
GET    /api/search-categories/flat
GET    /api/search-categories/:id
POST   /api/search-categories
PUT    /api/search-categories/:id
DELETE /api/search-categories/:id
GET    /api/search-categories/:id/papers
POST   /api/search-categories/:id/papers
DELETE /api/search-categories/:categoryId/papers/:paperId
POST   /api/search-categories/move-paper
GET    /api/search-categories/search
```

### 笔记

```text
GET    /api/notes/:paperId
POST   /api/notes/:paperId
GET    /api/notes/detail/:id
PUT    /api/notes/:id
DELETE /api/notes/:id
```

### 对话与流式聊天

```text
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
DELETE /api/conversations/:id
GET    /api/conversations/:id/branches
POST   /api/conversations/:id/switch-branch/:branchId
PUT    /api/conversations/:id/title
GET    /api/conversations/:id/streaming-message
POST   /api/conversations/:id/streaming-message/:messageId/stop

WS     /api/chat?conversation_id=...
```

WebSocket 支持发送新消息、附着到仍在进行的流式消息、回放缓冲事件和停止生成。

### 搜索

```text
GET    /api/search
GET    /api/search/download-pdf
```

`/api/search` 支持参数：

| 参数 | 说明 |
|------|------|
| `q` | 搜索关键词，必填 |
| `source` | `semantic_scholar`、`ieee`、`local`、`vector` |
| `field` | `all`、`title`、`author`、`abstract`、`year`、`journal`、`venue`、`doi` |
| `page` | 页码 |
| `limit` | 每页数量 |
| `year_from` / `year_to` | 年份范围 |

### 任务、文件、设置和 Agent

```text
GET    /api/tasks
GET    /api/tasks/stats
GET    /api/tasks/:id
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/retry

GET    /api/files
GET    /api/files/content
PUT    /api/files/content
POST   /api/files/file
POST   /api/files/directory
PATCH  /api/files/path
DELETE /api/files/path
POST   /api/files/upload
GET    /api/files/download
GET    /api/files/image

GET    /api/settings
PUT    /api/settings/:key
GET    /api/settings/models
GET    /api/settings/prompt-defaults
GET    /api/settings/themes/active
PUT    /api/settings/themes/active
GET    /api/settings/pi-enabled-models
PUT    /api/settings/pi-enabled-models
GET    /api/settings/background-images
POST   /api/settings/background-images

GET    /api/rankings/all
GET    /api/rankings/custom
PUT    /api/rankings/custom
GET    /api/rankings/search
GET    /api/rankings/:name

POST   /api/agent/auto-classify
GET    /api/events
```

`/api/events` 是 SSE 通道，用于推送文献状态、任务状态、文件变更和搜索结果等事件。

## 搜索功能

搜索功能在 `apps/api/src/services/search.service.ts` 中实现，当前为 TypeScript 原生实现：

- **本地向量搜索**：通过 `embeddingService` 生成查询向量，使用 pgvector 在 `paper_chunks` 中检索相似内容。
- **本地关键词搜索**：使用 Prisma raw SQL / PostgreSQL `ILIKE` 检索标题、作者、摘要、年份、期刊/会议等字段。
- **IEEE Xplore**：直接调用 IEEE Xplore API，需要 `IEEE_API_KEY`。
- **Semantic Scholar**：直接调用 Semantic Scholar Graph API，`SEMANTIC_SCHOLAR_API_KEY` 可选。

上传或重新解析 PDF 后，后台任务会触发解析、分块和向量化；向量搜索依赖 `paper_chunks.embedding` 已生成。

## 数据库

Prisma schema 位于 `packages/db/prisma/schema.prisma`。

主要模型：

| 模型 | 表 | 说明 |
|------|----|------|
| `Paper` | `papers` | 文献信息、PDF 路径、解析/向量化/总结状态、元数据 |
| `Category` | `categories` | 文献分类树 |
| `Note` | `notes` | 关联文献和页码的笔记 |
| `Conversation` | `conversations` | AI 对话列表项；仅保存标题、绑定论文、模型和 Pi session 指针等元数据 |
| `PaperChunk` | `paper_chunks` | PDF 文本块和 pgvector 向量 |
| `Task` | `tasks` | 后台任务记录 |
| `Setting` | `settings` | 系统设置 |

对话历史以 **Pi SessionManager JSONL** 为唯一数据源：用户消息、助手消息、工具调用、思考过程、compaction 和分支内容都从 Pi session 文件读取。数据库不再保存 `Message`、`MessageBranch` 或 `StreamEvent` 表；`Conversation.metadata.pi.sessions` 只保存各分支对应的 session 文件路径、叶子 entry、父分支和 fork 锚点等定位信息。

修改 schema 后执行：

```bash
pnpm db:migrate
pnpm db:generate
```

不要手写或修改已有迁移。种子逻辑在 `packages/db/src/seed.ts`。

## 后台任务与实时更新

`apps/api/src/services/job-queue.service.ts` 提供进程内队列，任务类型包括：

- `parse_pdf`
- `generate_embedding`
- `summarize`
- `enrich_metadata`

任务会写入 `tasks` 表，默认最多并发 2 个。服务启动时调用 `recoverJobs()` 恢复未完成任务，并通过 `sseHub` 推送 `paper-status` 等事件。

## 文件管理与安全边界

文件管理根目录来自 `FILES_DIR`，默认与 `DATA_DIR` 一致。`file.service.ts` 会限制路径穿越、隐藏敏感路径，并保护以下区域：

- `.env` 和 `.env.*`，但允许 `.env.example`
- `.pi/auth.json`
- `.pi/models.json`
- `papers/` PDF 存储目录
- 根目录和 `.pi` 关键目录

文件变更 watcher 会通过 SSE 发出 `files-changed`，涉及 Pi 配置时会触发 Pi 服务重载。

## 环境变量

环境变量集中在 `apps/api/src/lib/config.ts`：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `DATABASE_URL` | PostgreSQL 连接 | `postgresql://yarc:yarc@localhost:5432/yarc` |
| `JWT_SECRET` | JWT 密钥 | `dev-secret` |
| `PASSWORD_HASH` | 登录密码哈希 | 空（禁用认证） |
| `DATA_DIR` | 数据目录 | `./data` |
| `PAPERS_DIR` | PDF 存储目录 | `./data/papers` |
| `FILES_DIR` | 用户文件目录 | `DATA_DIR` |
| `MINERU_API_URL` | MinerU PDF 解析服务 | `http://localhost:8000` |
| `EMBEDDING_API_URL` | Embedding 服务 | `http://localhost:15263/v1/embeddings` |
| `EMBEDDING_MODEL` | Embedding 模型名 | `Qwen3-Embedding-8B` |
| `EMBEDDING_DIMENSIONS` | Embedding 维度 | `1536` |
| `IEEE_API_KEY` | IEEE Xplore API Key | 空 |
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar API Key | 空 |
| `PI_CLI_COMMAND` | Pi CLI 命令 | `pi` |
| `PI_CHAT_TOOLS` | Pi 聊天可用工具 | `all` |
| `PI_CHAT_TIMEOUT_MS` | Pi 聊天超时 | `120000` |
| `SUMMARY_TIMEOUT_MS` | 总结生成超时 | `300000` |
| `PDF_CACHE_DAYS` | PDF 缓存天数 | `2` |
| `CORS_ORIGIN` | CORS origin | `http://localhost:3000` |

不要读取、输出、提交或硬编码真实密钥。需要配置时使用 `.env.example` 作为模板，不要把真实 `.env` 内容写入文档或代码。

## Docker 数据库

| 文件 | 说明 |
|------|------|
| `docker-compose.yml` | PostgreSQL/pgvector 数据库 |
| `.env.example` | 环境变量模板 |

当前项目默认不从 Docker 启动应用容器；应用在宿主机通过 `pnpm dev` 或 `pnpm start` 运行。Docker Compose 只负责数据库：

- 使用 `pgvector/pgvector:pg16`
- 数据持久化到 `./data/postgres`
- 端口只绑定到宿主机 `127.0.0.1:${POSTGRES_PORT:-5432}`，避免默认暴露到局域网
- 开发默认连接串为 `postgresql://yarc:yarc@localhost:5432/yarc`

## 构建与检查

根据改动范围选择执行：

| 改动范围 | 检查命令 |
|----------|----------|
| 仅 API / DB | `pnpm --filter @yarc/api build` |
| 仅前端 | `pnpm --filter @yarc/web build` |
| 跨包改动 | `pnpm build` |
| Prisma schema | `pnpm db:migrate` → `pnpm db:generate` |

## 已移除或弃用内容

- `docs/design.md` 已合并进本文档，不再单独维护。
- 早期设计中的 `vue-pdf-viewer` 示例代码、Fastify/BullMQ 结构、手写 SQL schema、缓存示例代码和旧页面草图不再作为实现依据。
- 搜索不再依赖 Python 微服务，当前实现位于 `apps/api/src/services/search.service.ts`。
