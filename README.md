# YARC

Yet Another Research Claw，一个以 PDF 阅读和文献管理为中心的 AI 学术研究工作台。

YARC 的目标不是做一个单纯的 PDF 查看器，而是把论文阅读、文献整理、知识检索和 AI 辅助分析放在同一个工作流里。它适合用于个人或小团队的论文库管理：上传 PDF 后，可以在阅读过程中记录笔记、管理分类、检索已有文献，并让 AI 基于当前论文内容进行问答、总结或辅助理解。

项目采用前后端分离但单端口访问的结构：前端负责文献库、PDF 阅读器、文件管理和对话界面；后端负责认证、文件/PDF 服务、数据库访问、搜索、向量化任务和 AI 对话调度。开发时应用直接在本机 Node.js 环境运行，Docker 只用于提供 PostgreSQL/pgvector 数据库，方便保留本地开发体验，也避免把应用运行环境绑定到容器里。

当前项目仍以自用和快速迭代为主，重点关注以下方向：

- 把 PDF 阅读、笔记、AI 对话整合到一个连续界面中
- 支持本地文献库的关键词检索和向量语义检索
- 支持 Semantic Scholar / IEEE Xplore 等外部来源检索
- 保持论文文件、运行数据和密钥配置留在本地，不提交到 Git
- 尽量让部署依赖简单：本地 Node.js + Docker 数据库即可启动

## 功能概览

- PDF 阅读、上传、管理与搜索
- 基于当前文献上下文的 AI 对话
- 文献笔记、分类、任务状态与文件管理
- 本地关键词搜索、向量语义搜索
- Semantic Scholar / IEEE Xplore 外部检索

## 技术栈

- 前端：Vue 3 + Vite + Tailwind CSS
- 后端：Hono + TypeScript
- 数据库：PostgreSQL + pgvector + Prisma
- 运行方式：本地 Node.js 运行应用，Docker 只启动数据库

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
| `DATABASE_URL` | PostgreSQL 连接串 |
| `JWT_SECRET` | JWT 密钥 |
| `PASSWORD_HASH` | 登录密码哈希，留空时禁用认证 |
| `MINERU_API_URL` | MinerU PDF 解析服务 |
| `EMBEDDING_API_URL` | Embedding 服务 |
| `IEEE_API_KEY` | IEEE Xplore API Key |
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar API Key |

