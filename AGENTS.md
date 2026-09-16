# YARC (Yet Another Research Claw) Agent 指南

本文件仅用于 **YARC 应用的开发与实现**，约束在本代码仓库中工作的开发 Agent。它不管理通用工作区或科研项目内部的研究活动、文件操作及 Agent 行为，也不作为这些工作区的运行时指导。下文涉及工作区的内容仅用于说明产品架构、开发约束及用户数据保护边界。

## 角色与优先级

- 你是 YARC 代码仓库的工程协作者，重点关注：PDF 阅读/解析、文献库管理、科研项目工作区、AI 对话、检索、前后端契约、数据库一致性与可维护性。
- 在系统与开发者指令约束下，优先遵循用户明确要求；文件操作遵循其作用域内更具体的 `AGENTS.md`，再参考本文件与通用经验。
- 如果进入子目录发现更近的 `AGENTS.md`，同时遵循更具体的规则；若冲突，遵循更安全、更具体、与用户意图更一致的规则。
- 默认使用中文回复；代码、命令、错误信息和 API 字段保持原文。

## 术语与作用域：两种“项目”

用户可能把以下两者都简称为“项目”，不要仅凭这个词判断操作目标：

| 明确称呼 | 含义与定位 |
|----------|------------|
| **YARC 仓库 / YARC 应用** | 本代码仓库；包含 `apps/`、`packages/`、根 `package.json` 和本文件，负责产品开发、构建与部署。 |
| **科研项目 / Project / 项目工作区** | 产品内的 `Project` 实体；由 `projectId` 标识，独立目录由 `directoryName` 定位，默认在 `data/projects/<directoryName>/`，拥有自己的 Git 仓库、文件、对话和历史。 |
| **通用工作区 / 全局文件区** | `/files` 对应的文件区，根目录为 `config.filesDir`（默认 `data/`）；不是 YARC 仓库，也不是某个科研项目。 |

- 除非另注所属目录，本文件中的源码路径和 `pnpm` 命令均相对于 **YARC 仓库根**；科研项目文件接口中的 `path` 则相对于该科研项目根。`projectId`、显示名 `name`、目录名 `directoryName` 不可互换。
- 在本仓库的开发对话中，“当前项目”默认指 **YARC 仓库**；产品功能中的“项目管理”“项目页面”“Project”指 **科研项目功能**。无法判断是在修改产品实现还是操作实际科研材料时，先澄清任务，不自行切换工作范围。
- 修改“项目管理功能”不等于操作实际科研项目。开发对话中的“提交/commit”针对本轮 YARC 代码改动，不包含科研项目的独立 Git 仓库。
- `data/AGENTS.md` 和科研项目根的 `AGENTS.md` 属于应用运行时的独立指导入口，不由本文件定义其操作规范；修改本文件不应传播到这些文件。

## 应用概览

YARC 是以 PDF 阅读为中心的 AI 学术研究工作台。

- **前端**：`apps/web`，Vue 3 + Vite + Tailwind CSS 4，状态管理使用 Pinia
- **后端**：`apps/api`，Hono + TypeScript，统一监听 `PORT`（默认 3000），同时提供前端静态文件和 `/api/*`
- **数据库**：`packages/db`，Prisma + PostgreSQL/pgvector
- **共享包**：`packages/shared`，跨端类型和工具
- **Pi 运行时与工具**：主要在 `apps/api/src/services/` 下的 `pi.service.ts`、`pi-runtime-registry.ts` 及 `apps/api/src/workers/pi-session.worker.ts`；当前没有 `packages/pi-tools`
- **用户数据**：默认在 `data/`（论文、通用文件、科研项目、历史及 Pi 运行数据）；实际根目录以 `config.ts` 和对应配置为准，不能假定总在仓库内。它们是开发时需要保护的数据，不属于本文件管理的研究工作内容。

## 关键路径

```text
apps/api/src/
├── routes/               # API 路由：HTTP 参数、状态码、响应形状
├── services/             # 业务逻辑，含 project-*、Pi runtime、实时文件服务
├── workers/              # Pi 会话 Worker
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

data/                     # 默认通用工作区根，不固定为 data/files/
├── AGENTS.md             # 应用内研究 Agent 的共享指导（不是本文件）
├── papers/               # 用户论文、PDF、解析结果、向量/笔记相关数据
├── projects/             # 科研项目目录，每项有独立 Git
├── .project-history/     # 科研项目历史对象存储，不是 Git 历史
└── .pi/agent/            # 共享 Pi 配置、扩展与会话数据（含敏感配置，禁止读取）

docs/
└── technical.md          # 技术与产品合并文档
```

## 工作区功能的实现边界

以下是修改 YARC 实现时需要维护的约束，不是对工作区使用者或研究 Agent 的操作指令。

- **入口与身份**：项目功能入口为 `apps/api/src/routes/projects.ts`，路径解析统一使用 `apps/api/src/lib/project-path.ts`。创建时生成新目录，不能直接接管已有目录；修改项目显示名不会改目录，更新接口禁止变更 `directoryName` 或绝对路径。
- **文件隔离**：`/api/files/*` 处理通用文件；`/api/projects/:id/files/*` 处理项目文件。通用文件访问检查会阻止访问项目存储和历史存储；项目文件路径拒绝绝对路径、越界、符号链接和 `.git`。修改代码时保留这些校验，不引入通过通用接口或手拼路径绕过隔离的实现。依据：`apps/api/src/lib/` 下的 `global-files-path.ts`、`project-path.ts`。
- **前端身份**：项目内文件路径是相对路径。同名文件可能属于不同工作区，列表、最近记录、缓存、选中态必须携带工作区身份（如 `projectId + path`）；点击跨项目文件时先切换路由，再加载目标文件。会话列表也按 `projectId` 区分。
- **Git 与历史分开**：新建科研项目自动 `git init` 并写入默认 `.gitignore`，不自动首次提交或绑定远程。默认忽略含 Python 虚拟环境/缓存，仅影响新建项目。项目 Git、YARC 仓库 Git、应用的写作历史检查点是三种不同对象，不能在实现中混用；自动保存和历史检查点不等于 Git commit。
- **生命周期实现**：归档保留数据；永久删除会影响项目目录、所属对话、会话文件和历史记录。修改删除、历史恢复、Git 切分支功能时，检查已有服务对实时编辑缓冲、历史和运行时的协调，保留必要的界面确认与错误处理，不以直接删目录或改 Git 内部文件替代服务流程。
- **Agent 作用域**：`Conversation.projectId` 决定运行工作目录：全局对话用 `config.dataDir`，项目对话用项目根（见 `apps/api/src/lib/conversation-workspace.ts`）。Pi 的全局 `agentDir` 和会话存储仍共用 `DATA_DIR/.pi/agent/`（默认 `data/.pi/agent/`）；实现项目级设置时，不得误写共享配置。
- **运行时指导**：当前 Worker 加载 `DATA_DIR/AGENTS.md`（默认 `data/AGENTS.md`），并在存在时追加当前工作区根的 `AGENTS.md`，不继承 YARC 仓库祖先指导。科研项目的 `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` 是项目级资源。调整资源加载逻辑时保持来源与作用域清晰，不把本文件注入研究会话。
- **不是完整沙箱**：上述路径限制是应用文件接口的边界，不能推断所有扩展、工具、`bash` 或操作系统访问都被同等隔离。开发时不要宣称已有完整沙箱保障；测试用临时目录/模拟数据，不拿真实科研项目做破坏性验证。

## 当前 Agent 工具使用总则

以下工具/skill 仅在当前运行环境实际提供时使用；缺失时说明限制或采用已授权的替代方式，不为满足文档而擅自安装。

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
- 编辑用户明确要求修改的 YARC 源码/文档，且改动可解释、可回滚；不将科研项目文件纳入默认修改范围。
- 公共资料搜索、官方文档查询、开源源码查证。

### 执行前必须询问

- 删除、移动、覆盖、批量重命名非临时文件。
- 修改用户论文、上传文件、笔记、解析结果、科研项目文件或历史数据（含通过配置迁出 `data/` 的目录）；用户未明确授权具体对象和操作时先询问。开发功能的授权不包含批量修补已有项目数据。
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

# API 测试（不包含全部前端测试）
pnpm test

# Docker 数据库 + 本地开发（容器操作先确认）
pnpm docker:dev        # 启动数据库，再本地运行 pnpm dev
pnpm docker:dev:up     # 仅启动数据库
pnpm docker:logs

# 数据库（migrate/deploy/seed 前确认目标数据库和写入授权）
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
- 修改 schema 后，先确认目标为已授权的开发数据库，再运行 `pnpm db:migrate` → `pnpm db:generate`；不要手写或修改已有迁移。构建不需要顺手执行迁移或 seed。
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
| `DATA_DIR` | 应用数据根目录 | YARC 仓库下 `data/` |
| `FILES_DIR` | 通用文件区根目录 | `DATA_DIR` |
| `PAPERS_DIR` | 文献存储目录 | `DATA_DIR/papers` |
| `PROJECTS_DIR` | 科研项目目录的父目录 | `DATA_DIR/projects` |
| `PROJECT_HISTORY_DIR` | 科研项目历史对象存储 | `DATA_DIR/.project-history` |
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
| `/files` | 通用文件工作区 |
| `/settings` | YARC 全局设置 |
| `/projects` | 科研项目列表 |
| `/projects/:id` | 科研项目工作区（文件 / Git / 历史） |
| `/projects/:id/settings` | 单个科研项目的设置 |

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

### 修改科研项目功能

1. 后端在 `apps/api/src/` 下读取 `routes/projects.ts`、相关 `services/project-*.ts`、`lib/project-path.ts`；前端在 `apps/web/src/` 下检查 `pages/PapersPage.vue`、`components/projects/`、`stores/projects.ts` 和对应 API 调用。
2. 确认工作区身份贯穿文件、对话、实时编辑、缓存与 Git/历史流程；项目根失效时返回错误，不回退到全局工作区操作同名文件。
3. 修改创建模板或默认值时，明确“仅新建生效”与“迁移已有数据”的区别；后者单独确认范围。
4. 按改动跑 API/前端构建和相关测试；至少覆盖两个项目中的同名文件、项目与全局切换、越界拒绝、未保存编辑的处理。不要未经授权创建或删除真实项目来测试。

### 修改数据库 Schema

1. 读取 `schema.prisma`、相关服务和共享类型。
2. 设计向后兼容的数据变更；涉及数据丢失风险先询问。
3. 确认目标数据库与写入授权后运行 `pnpm db:migrate`，再 `pnpm db:generate`。
4. 更新 seed、API、前端类型和验证命令。

### 修改 PDF / 文件 / 笔记功能

- PDF 阅读、上传、Range 请求、MinerU 解析结果和笔记逻辑都可能影响用户数据；修改时检查相关服务及读写链路。
- 调试中读取用户数据须限定到任务需要的具体文件；开发授权不包含改写、删除或移动真实材料，不因文件处在 YARC 仓库内就视为源码。
- 验证优先使用测试数据或临时副本，不直接改论文目录、笔记记录或科研项目材料来验证功能。

### AI / Pi 工具集成

- 修改 agent 交互、subagent、Pi metadata、工具注册或前端交互弹窗时，同时检查：后端路由、服务、共享类型、前端 host/dialog/store。
- 交互协议应可序列化、可恢复、可取消/超时，并给出用户可理解的状态。
- 不要把内部工具错误、密钥路径或敏感上下文直接暴露给前端用户。

### Docker / 部署

- 当前仓库只有 `docker-compose.yml`，以数据库服务为主；先读取实际存在的 compose 和 `package.json` 脚本，不假定存在 `docker-compose.prod.yml`。
- 启停容器、`docker compose down`、卷清理、生产部署操作都需确认。`pnpm docker:down` 当前是停止数据库，不是删除卷。
- 只看日志时可用 `pnpm docker:logs` 或定向 `docker compose logs`；不要打印含密钥的环境。

### 文档 / AGENTS / Skills

- 修改规则文档时保持可执行、具体、不过度臃肿；删除旧规则前确认是否仍被使用。
- 审计 AGENTS/Skill 使用 `agent-guidance-audit`，创建/优化 Skill 使用 `skill-creator` 或 `skill-design-optimizer`。
- 文档中的命令、路径、环境变量要与实际文件交叉验证；架构或工作区边界变化时同步维护本文件。发现 `data/AGENTS.md` 或项目内指导过时，单独说明，不顺手覆盖用户维护的规则。

## 完成前检查

根据改动范围选择最小但充分的检查：

| 改动范围 | 检查命令 |
|----------|----------|
| 仅 API / DB 类型 | `pnpm --filter @yarc/api build` |
| 仅前端 | `pnpm --filter @yarc/web build` |
| 跨包改动 | `pnpm build` |
| Prisma schema | 确认目标库与写入授权后 `pnpm db:migrate` → `pnpm db:generate` |
| Docker 配置 | 读取 compose 语法和相关脚本；需要实际启动前询问 |
| 文档/AGENTS | 检查路径、命令和 Markdown 结构；通常无需构建 |

完成前还应：

- 运行 `git status --short`，确认只改了预期文件。
- 如有代码改动，查看相关 `git diff` 并总结关键变化。
- 若未能验证，说明原因、风险和用户可继续执行的命令。

## 用户改动与 Git

- 默认不要提交、创建分支、rebase、reset、stash 或改写历史，除非用户明确要求。
- 执行 Git 前确认仓库根（`git rev-parse --show-toplevel` 或明确的 `git -C <目标根>`）及 `status/diff`。YARC 源码提交与科研项目提交互不包含；提交授权也不包含 push。
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

## 用户数据与构建产物

**用户数据不是可清理的构建缓存**：`data/` 中的论文、科研项目（含其 Git）、历史对象、会话和上传文件，以及配置到其他位置的同类数据，不纳入 YARC 源码修改，也不因构建或测试而清理。写操作须有明确授权。

以下才是本地日志或构建产物，不要手动修改或纳入源码提交：

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
