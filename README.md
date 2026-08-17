# YARC

Yet Another Research Claw，一个以 PDF 阅读、文献管理、论文检索和 AI Agent 协作为核心的学术研究工作台。

YARC 不只是 PDF 查看器：它把论文导入、解析、阅读、检索、笔记、分类、AI 问答、工作区文件编辑和数据同步放在同一个连续界面中，适合个人或小团队维护本地论文库和研究资料。

项目采用前后端分离但单端口访问的结构：前端负责文献库、PDF 阅读器、搜索、文件工作区和对话界面；后端负责认证、文件/PDF 服务、数据库访问、外部检索、MinerU 解析、向量化任务、Agent 调度和实时事件推送。开发时应用直接在本机 Node.js 环境运行，Docker 只用于提供 PostgreSQL/pgvector 数据库。

当前项目重点覆盖以下工作流：

- 从 PDF 上传、解析、向量化和总结，到阅读、提问、记笔记和分类归档
- 通过内置 Pi Agent 读取论文和工作区文件，调用研究工具并执行可恢复的多步任务
- 在本地文献库、Semantic Scholar 和 IEEE Xplore 之间检索、筛选、收藏和导入论文
- 在 `data/` 工作区中浏览、编辑、预览和同步研究资料
- 将论文、笔记、Agent 会话和运行数据保留在本地，并按需使用 WebDAV 同步

## 功能概览

### PDF 阅读与文献管理

- 上传、管理和删除 PDF；使用 MinerU 解析正文、页面、图片、表格和公式等内容
- 后台执行 PDF 解析、元数据补全、摘要提取、向量化和论文总结，并实时显示任务状态
- 在 PDF 中进行翻页、缩放、搜索和文本选择；把当前论文、页码和选中文本直接带入 AI 对话
- 使用分类树、标签、期刊分级信息和搜索收藏整理文献
- 创建与论文、页码和高亮文本关联的笔记；支持将已关联的 Markdown 笔记同步回数据库

### AI Agent 与研究协作

YARC 集成 Pi coding agent，提供流式对话、思考过程、工具调用、上下文用量、会话持久化和分支会话能力。Agent 可以围绕当前论文、当前文件、分类或搜索结果工作，并支持：

- 使用 `@current`、`@paper`、`@file`、`@category`、`@search-category` 等引用方式注入研究上下文
- 使用 `/model`、`/thinking`、`/compact`、`/new`、`/btw`、`/search`、`/list`、`/read`、`/write`、`/edit` 等命令
- 搜索论文，读取本地论文的元数据、总结、页文本、向量 chunks 或全文
- 批量保存、导入、分类、更新和删除论文；管理文献分类和搜索收藏分类
- 创建、更新、删除和同步论文笔记；查询后端状态、任务队列、MinerU 结果和向量化状态
- 通过 Web 原生问卷向用户提出确认、单选/多选和输入问题，并显示通知、超时和取消状态
- 调用 subagent 执行单个任务、并行任务或链式步骤，并在界面中查看状态、暂停、恢复或追加步骤

Agent 的普通文件读写以 `data/` 工作区为根；论文内部数据和认证配置由应用边界保护，论文笔记写入使用 YARC 笔记工具。

### 论文搜索与导入

- **本地文献库**：结合标题、作者、摘要、期刊和解析文本的关键词匹配，以及 pgvector 语义检索的混合搜索
- **Semantic Scholar**：搜索外部论文并展示作者、年份、摘要、期刊/会议、引用数、参考文献数、开放获取 PDF 和 TLDR 等可用元数据
- **IEEE Xplore**：支持文章搜索、相关性/最新排序、年份筛选、Early Access，以及按配置期刊浏览当前期次和 Early Access 目录
- 支持按标题、作者、年份、摘要、期刊/venue 等字段筛选，分页浏览搜索结果
- 可将搜索结果保存到搜索收藏分类，或批量导入本地文献库并选择文献分类
- 对有可用 PDF 地址的结果支持后台批量下载、入库、解析和向量化，并在顶部显示导入进度
- 支持打开远程 PDF 临时阅读；临时文档解析完成后也可以交给 Agent 作为当前上下文

### 文件工作区与编辑

文件工作区默认使用 `data/`，也可以通过 `FILES_DIR` 指向独立目录。文件页提供：

- 文件树、最近文件和多标签页；创建文件/文件夹、上传、下载、重命名、移动和删除
- 拖放上传与拖放移动，图片预览，以及使用系统应用打开不适合网页编辑的文件
- 基于 CodeMirror 的常见文本和代码编辑：TypeScript/JavaScript/Vue、JSON/YAML、Markdown、Python、CSS/HTML/XML、SQL、Shell、LaTeX 等
- 语法高亮、行号、代码折叠、自动缩进、换行、查找/替换、选中文本包裹和编辑器显示设置
- Markdown 预览、数学公式渲染，以及 DOCX/XLSX/PPTX 的 Office 预览（需要 `officecli`）
- 基于 WebSocket + Yjs 的实时文件会话、自动保存、磁盘变更监听、冲突提示与解决、离线草稿和本地缓存

论文存储目录 `papers/`、认证文件和部分内部运行目录在文件工作区中是受保护的，避免被普通文件操作覆盖。

### 任务、设置与同步

- 通过 SSE 和 WebSocket 推送论文状态、后台任务、文件变化、搜索结果、Agent 交互和 subagent 状态
- 在设置中管理模型、推理级别、系统 Prompt、论文总结 Prompt、Agent `AGENTS.md`、skills 和 Pi extensions
- 可选 WebDAV 同步 `data/`：支持仅上传、仅下载或双向同步，支持手动、定时和本地变化触发、选择同步范围、排除规则和冲突报告；默认不传播删除，可选将安全确认过的本地删除同步到远端
- 支持主题、背景图片、编辑器偏好和 Markdown 笔记同步设置

## 技术栈

- 前端：Vue 3 + Vite + Tailwind CSS + Pinia
- PDF 阅读：EmbedPDF / PDF.js
- 编辑器：CodeMirror 6 + Yjs
- 后端：Hono + TypeScript
- AI Agent：Pi coding agent SDK，支持 SSE/WebSocket 流式交互
- 数据库：PostgreSQL + pgvector + Prisma
- PDF 解析与向量化：MinerU + Embedding API
- Office 预览：`officecli`（可选）
- 运行方式：本地 Node.js 运行应用，Docker 只启动 PostgreSQL/pgvector

## 快速开始

### 1. 准备环境变量

```bash
cp .env.example .env
```

开发环境可以直接使用默认值。正式使用前请修改 `JWT_SECRET`、数据库密码以及需要的外部 API Key。

### 2. 安装依赖

```bash
pnpm install
```

### 3. 启动数据库

```bash
pnpm docker:db:up
```

数据库默认监听 `127.0.0.1:5432`，连接串为：

```text
postgresql://yarc:yarc@localhost:5432/yarc
```

### 4. 初始化数据库

```bash
pnpm db:migrate
pnpm db:seed
```

### 5. 启动开发服务

```bash
pnpm dev
```

访问：<http://localhost:3000>

也可以用一个命令启动数据库和开发服务：

```bash
pnpm docker:dev
```

## 常用命令

```bash
pnpm dev              # 本地开发
pnpm build            # 构建 / 类型检查
pnpm start            # 启动应用
pnpm docker:db:up     # 启动 PostgreSQL/pgvector
pnpm docker:db:stop   # 停止数据库
pnpm docker:logs      # 查看数据库日志
pnpm db:migrate       # 开发迁移
pnpm db:deploy        # 部署迁移
pnpm db:seed          # 初始化种子数据
pnpm db:generate      # 生成 Prisma Client
```

## 项目结构

```text
apps/
  api/       Hono 后端
  web/       Vue 前端
packages/
  db/        Prisma schema、迁移和客户端导出
  shared/    前后端共享类型
docs/        技术文档
data/        本地运行数据，默认不纳入 Git
```

## 环境变量

主要配置见 `.env.example`。常用变量：

| 变量 | 说明 |
|---|---|
| `DATA_DIR` | 运行数据根目录，默认是项目根目录下的 `data/` |
| `FILES_DIR` | 文件工作区根目录，默认使用 `DATA_DIR` |
| `PAPERS_DIR` | 论文 PDF 与解析结果目录，默认是 `DATA_DIR/papers` |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `JWT_SECRET` | JWT 密钥 |
| `PASSWORD_HASH` | 可预置的登录密码哈希；留空时首次登录会设置密码 |
| `MINERU_API_URL` | MinerU PDF 解析服务 |
| `EMBEDDING_API_URL` | Embedding 服务 |
| `EMBEDDING_MODEL` | Embedding 模型名称 |
| `EMBEDDING_DIMENSIONS` | 向量维度，需与数据库向量列和模型输出一致 |
| `PI_CLI_COMMAND` | Pi CLI 命令，默认是 `pi` |
| `PI_CHAT_TOOLS` | Agent 对话可用工具，默认是 `all` |
| `IEEE_API_KEY` | IEEE Xplore API Key；启用 IEEE 搜索时需要 |
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar API Key，可选，用于提高限流额度 |
| `CORS_ORIGIN` | 允许的前端来源，默认是 `http://localhost:3000` |

## License

This project is licensed under the [MIT License](LICENSE).

