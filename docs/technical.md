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
  - 顶部是一条 32px 的标签栏（`components/layout/WorkbenchTabs.vue`，纯逻辑在 `lib/workbench-tabs.ts`），取代原先顶栏里的下拉切换器：左半部分是「文献库」和已打开的论文，右半部分是工作区文件，两部分之间留一段空隙；某一部分没有标签时不渲染，只有文献库而没有其它标签时整条标签栏不显示。
  - 进入文献库（含期刊浏览）即出现「文献库」标签，可按 × 关闭，是否打开保存在浏览器本地；论文标签沿用 `readerTabs`（会话内状态），文件标签沿用带工作区身份的最近文件列表（`projectId + path`），标签顺序单独持久化，不随最近使用顺序跳动。
  - 文件标签以 `projectId + path` 区分：点击其它工作区的文件先切换路由再加载文件。科研项目的文件用一个与文件图标等宽的项目首字徽标代替图标，完整的「项目 / 路径」在悬停提示中；标签宽度不随当前工作区变化。同一工作区内的同名文件附带所在目录。未保存/冲突状态显示为标签上的圆点，悬停变为关闭按钮；中键点击关闭标签。关闭当前标签回到上一个使用过的标签，没有可用历史时只在同一工作区内取相邻标签。
  - 标签栏右端是当前文件的图标按钮：Markdown 的编辑/预览/双栏/即时模式与换位，LaTeX 的编译、引擎、重新编译、取消、定位和 PDF 显隐（图标加文字），只读文件的系统打开。不再有「立即保存」按钮：实时文件自动同步，`Ctrl/⌘+S` 仍会立即写盘；语言和文件大小显示在编辑器状态栏。
  - LaTeX 编译在服务端进行，前端按文件（`projectId + path`）记住编译入口、构建 ID、PDF 显隐和引擎。已挂载的编译面板可在后台继续轮询并保留 PDF；浏览器刷新后，若构建记录仍在服务端内存中，则读取已有结果，不自动编译。API 重启或构建被清理后，恢复可能失败。
  - LaTeX 自动清理在 API 启动时、之后每小时及构建结束后尝试执行。仅处理 `LATEX_OUTPUT_DIR`（默认 `DATA_DIR/.latex-builds`）下由新版标记的已结束构建。构建归属各自的科研项目或通用工作区，独立按完成时间判断：失败或取消超过 5 天、成功超过 20 天才清理，不限制构建数量。排队和运行中的构建不清理；当前进程最近 15 分钟内访问过的构建暂缓删除。清理同步释放内存记录，不删除科研项目源码或历史检查点；旧版未标记目录不会自动删除。`LATEX_CLEANUP_ENABLED=false` 可关闭自动删除；输出目录应由单个 API 实例独占管理。
  - 项目列表、项目设置和全局设置页不是标签，停留在这些页面时没有激活的标签，但标签栏仍可用于切回论文或文件。
- 右侧栏：AI 对话面板；支持会话、分支、模型选择、推理力度、流式输出和停止生成。对话作用域（通用对话或某个科研项目）与左侧/中间页面解耦，在标题栏左侧的作用域标签中切换，并保存在浏览器本地；打开文献、文件、设置等页面不会改变对话，只有从别处进入某个项目工作区时才自动切到该项目的对话。`@current` 按对话作用域换算路径：项目对话引用通用区公开文件或临时 PDF 时使用 `../../` 路径，跨项目或受保护目录的文件会提示切换作用域。

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
POST   /api/papers/import-from-search
GET    /api/papers/import-jobs/:id
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

后台 PDF 导入支持 `pdfBase64`（旧别名 `file`），以及 `pdfUrl` / `openAccessPdf.url` / `pdfPath` 中的 HTTP(S) URL、`file://` URL 或本地路径。本地绝对路径可位于项目和 `DATA_DIR` 之外，但必须是服务进程可读取的普通文件；相对路径以发起导入的 Agent 当前工作区为基准（项目对话为项目根，普通 HTTP 导入为 `DATA_DIR`）。本地路径指服务器文件，不是浏览器所在设备的路径。导入保留 50MB 限制和 `%PDF-` 文件头校验；其他 URL 协议明确报错。此导入能力不改变通用/项目文件接口的路径隔离规则，也不提供完整文件系统沙箱。

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

刷新恢复对话时，前端利用本地保存的会话/分支 ID，将分支列表和历史消息请求与会话列表请求并行发出；只有服务器列表确认会话仍属于当前作用域、目标分支仍有效后才展示预取内容。过期偏好、请求失败和工作区切换会安全回退或丢弃预取结果，不在浏览器持久化聊天正文。普通会话切换也并行读取分支和预计的历史；模型设置和运行时初始化不阻塞已有历史的首次显示。

重连时，`streaming-message` 的 `excludedMessageIds` 标记已提交但不在当前 Session 路径上的旧消息（例如 `context_compact` 切到摘要分支前的消息）。前端不再从回放中恢复这些消息，但仍推进事件游标，避免它们被追加到压缩后的内容下方。普通 Pi compaction 不改变原始会话路径，压缩前消息仍按路径顺序保留；尚未写入元数据的当前叶节点后继也不会被误排除。

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

Web 对话的 Pi Extension 由长生命周期 Runtime Worker 承载。每个活动的 `conversationId + branchId` 拥有独立 Worker、Extension module cache、Session runtime 和 Web TUI surface；不同 conversation 可并行，同一 conversation 仍只允许一个主生成 producer。最终消息在 Pi `message_end` 后同步写入 JSONL并执行提交屏障，Worker 回收不承担消息保存。生成中的 prompt/delta 临时记录到 `data/.pi/agent/runtime-streams`，正常提交后清理，API 重启时恢复为 aborted turn。

浏览器刷新或切换对话只 detach WebSocket subscriber，后台 Runtime 和 StreamBuffer 继续生成。Pi package 安装、更新、启用、禁用或卸载后会重建空闲 Worker；正在生成的 Worker 在 settled 后重建，以清除 Extension module cache。Web 对话的模型和思考级别按 conversation 保存，不会因 `AgentSession.setModel()` 或 `setThinkingLevel()` 改写全局 `settings.json` 默认值；默认值仅由设置页显式修改。`pi-context` 的 `/acm` 启用标记会在同一 API 进程内的 Runtime 重建后自动恢复；API 完全重启后需要重新执行 `/acm`。

### MinerU 与 llama.cpp 生命周期

MinerU 和 llama.cpp 默认由外部进程管理，YARC 只调用其 HTTP API。配置按需启动后，`ModelServiceManager` 会在请求进入 pending queue 时先检查健康地址；健康服务已存在时，若没有显式 `stopCommand` 则视为外部所有，不会由 YARC 停止；配置了 `stopCommand` 则表示明确允许管理器接管该 supervisor-managed 服务。健康检查失败时执行配置的启动命令，等待服务健康后继续请求。只有 pending queue 和活动 lease 都为空，且持续空闲达到 TTL 后，才执行停止命令；没有配置停止命令时，才回收由本进程直接启动的进程组。API 关闭时也会释放由本进程创建或启动命令声明接管的服务。

Docker、systemd 等 supervisor 应配置成对的 `*_START_COMMAND` 和 `*_STOP_COMMAND`，因为启动命令本身通常只是短暂的控制进程，不能通过杀掉它来停止容器或 unit。例如：

```text
MINERU_START_COMMAND=docker start my-mineru-container
MINERU_STOP_COMMAND=docker stop -t 30 my-mineru-container

LLAMA_CPP_ON_DEMAND=true
LLAMA_CPP_START_COMMAND=systemctl --user start llama-server.service
LLAMA_CPP_STOP_COMMAND=systemctl --user stop llama-server.service
```

使用 Compose 时只操作目标服务，例如 `docker compose ... up -d mineru` / `docker compose ... stop mineru`，不要使用会影响其他服务的 `docker compose down`。MinerU 设置 `MINERU_START_COMMAND` 后启用托管；如果使用 supervisor，还应设置 `MINERU_STOP_COMMAND`。llama.cpp 还必须同时设置 `LLAMA_CPP_ON_DEMAND=true` 和 `LLAMA_CPP_START_COMMAND`，并在 systemd/Docker 场景设置 `LLAMA_CPP_STOP_COMMAND`。按需管理器不负责修改 llama.cpp 的模型路由策略；如需限制多模型常驻，应另外使用 llama.cpp router 的 `--models-max`，并优先使用其自身的 `--sleep-idle-seconds`。

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

文件变更 watcher 会通过 SSE 发出 `files-changed`，只有 `AGENTS.md`、Pi settings/keybindings、prompt/skill/theme/extension 等实际被 Runtime 读取的资源变更时才触发 Pi 服务重载；普通工作区文件同步不会重建 Runtime。

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
| `MINERU_START_COMMAND` / `MINERU_STOP_COMMAND` | MinerU 启动 / 停止命令；Docker 等 supervisor 应成对配置 | 空 |
| `MINERU_START_CWD` | MinerU 启停命令工作目录 | 空 |
| `MINERU_HEALTH_URL` | MinerU 健康地址；为空时从 API origin 推导 `/health` | 空 |
| `MINERU_START_TIMEOUT_MS` / `MINERU_IDLE_TTL_MS` | MinerU 启动超时 / 空闲停止 TTL | `120000` / `300000` |
| `EMBEDDING_API_URL` | Embedding 服务 | `http://localhost:15263/v1/embeddings` |
| `EMBEDDING_MODEL` | Embedding 模型名 | `Qwen3-Embedding-8B` |
| `EMBEDDING_DIMENSIONS` | Embedding 维度 | `1536` |
| `LLAMA_CPP_ON_DEMAND` | 是否启用 llama.cpp 按需托管；还需配置启动命令 | `false` |
| `LLAMA_CPP_START_COMMAND` / `LLAMA_CPP_STOP_COMMAND` | llama.cpp/router 启动 / 停止命令；systemd 等 supervisor 应成对配置 | 空 |
| `LLAMA_CPP_START_CWD` | llama.cpp 启停命令工作目录 | 空 |
| `LLAMA_CPP_HEALTH_URL` | llama.cpp 健康地址；为空时从 Embedding API origin 推导 `/health` | 空 |
| `LLAMA_CPP_START_TIMEOUT_MS` / `LLAMA_CPP_IDLE_TTL_MS` | llama.cpp 启动超时 / 空闲停止 TTL | `120000` / `300000` |
| `IEEE_API_KEY` | IEEE Xplore API Key | 空 |
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar API Key | 空 |
| `PI_CLI_COMMAND` | Pi CLI 命令 | `pi` |
| `PI_CHAT_TOOLS` | Pi 聊天可用工具 | `all` |
| `PI_CHAT_TIMEOUT_MS` | Pi 聊天超时 | `120000` |
| `PI_RUNTIME_IDLE_TTL_MS` | 空闲 Runtime Worker 回收时间 | `900000` |
| `PI_RUNTIME_MAX_ACTIVE` | 最大活动 Runtime Worker 数 | `12` |
| `PI_RUNTIME_START_TIMEOUT_MS` | Runtime Worker 启动超时 | `30000` |
| `PI_RUNTIME_JOURNAL_RETENTION_MS` | 已失活 Runtime journal 的保留时间；后台每小时清理 | `86400000` |
| `PI_EXTENSION_UI_TIMEOUT_MS` | Extension UI 默认超时 | `300000` |
| `PI_SESSION_DURABILITY` | Session 最终消息耐久级别：`strict`/`normal` | `strict` |
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
