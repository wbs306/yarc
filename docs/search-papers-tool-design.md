# `yarc_search_papers` 统一搜索与论文处理设计

> 状态：设计稿，供后续实现上下文直接执行。
>
> 本文只描述目标、契约、状态和实现边界，不要求本轮修改代码。

## 1. 背景与目标

当前 `yarc_search_papers` 已经可以搜索本地库、Semantic Scholar 和 IEEE Xplore，并将结果展示到前端搜索面板。搜索结果后续存在三种不同需求：

1. 只想获取或补全单篇论文的摘要/元数据；
2. 想临时阅读外部 PDF，但不想保存到正式文献库；
3. 确定要保存论文，下载 PDF 并正式进入本地文献库。

这些需求不应继续通过多个相近名字的工具表达。统一扩展现有 `yarc_search_papers`，使用 `action` 区分行为，同时保留当前搜索调用的兼容性。

核心原则：

- `search` 只发现候选论文，不自动下载或写入本地库；
- `abstract` 只读取外部元数据/完整摘要，不下载 PDF；
- `preview` 临时下载、解析和暴露工作区 Markdown 路径，不创建正式 `Paper`；
- `import` 正式下载、解析并入库，复用现有导入任务；
- `yarc_papers` 继续负责正式本地文献的管理和读取；
- 所有异步或未完成状态必须明确返回，不能让 Agent 把空文件或未完成结果当成成功。

## 2. 工具总览

工具名保持为：

```text
yarc_search_papers
```

新增参数：

```ts
action?: 'search' | 'abstract' | 'preview' | 'import'
```

`action` 默认值为 `search`，因此旧调用：

```json
{"query":"graph neural network"}
```

仍然有效，等价于：

```json
{"action":"search","query":"graph neural network"}
```

建议参数按 action 划分如下：

```ts
{
  action?: 'search' | 'abstract' | 'preview' | 'import'

  // search / 定位外部论文
  query?: string
  source?: 'local' | 'ieee' | 'semantic_scholar'
  field?: 'all' | 'title' | 'author' | 'year' | 'abstract' | 'journal' | 'venue'
  page?: number
  limit?: number
  yearFrom?: number
  yearTo?: number
  earlyAccess?: boolean
  publication?: string

  // 单篇外部论文定位，abstract / preview / import 使用
  paperId?: string                 // Semantic Scholar paperId；或结果中的稳定 id
  articleNumber?: string           // IEEE arnumber
  doi?: string
  arxivId?: string
  url?: string
  paper?: Record<string, unknown>  // 允许直接传 search 返回的单篇结果
  papers?: Array<Record<string, unknown>> // import 批量使用

  // preview
  temporaryId?: string
  async?: boolean
  mode?: 'metadata' | 'abstract' | 'pages' | 'full_text'
  pageNumber?: number
  startPage?: number
  endPage?: number
  maxChars?: number

  // import
  category?: string
  parentCategory?: string
  categoryId?: string
  requirePdf?: boolean
  extractMetadata?: boolean
  removeFromSearchCategory?: {
    categoryId: string
    paperIds: string[]
  }
}
```

实现时应根据 action 使用不同的 TypeBox 子 schema 或明确的 conditional validation，避免所有参数都看起来对所有 action 有效。

## 3. `action: search`

### 3.1 语义

搜索论文候选，不下载 PDF，不创建数据库记录，不创建临时解析文件。

现有 source：

- `local`：本地文献库/向量和关键词检索；
- `semantic_scholar`：Semantic Scholar 搜索；
- `ieee`：IEEE Xplore 文章搜索。

### 3.2 Agent 返回文本

返回结果应包含：

- 总数、当前页、分页信息；
- 标题、作者、年份、venue/journal；
- 稳定定位字段：Semantic Scholar `paperId`、IEEE `articleNumber`、DOI、arXiv ID；
- `url`、`pdfUrl`、`openAccessPdf.url`（如果存在）；
- 摘要。

摘要策略：

- Semantic Scholar：返回完整 `abstract`，不做当前的 180 字符截断；
- IEEE：搜索接口返回的摘要可能不完整，搜索结果中可返回当前可得片段，并提示需要 `action=abstract` 获取完整摘要；
- 本地：继续返回本地摘要或匹配 chunk 的 snippet，不能声称是完整正文。

前端搜索面板仍可消费 `details.papers`，但不能依赖前端事件作为 Agent 的后续上下文。搜索结果应通过 tool result 返回给 Agent。

### 3.3 搜索结果处理

`search` 的成功结果中每一篇候选应带有足够的稳定标识，后续 action 优先使用这些字段，而不是要求 Agent 手工拼接 URL：

```json
{
  "id": "S2-paper-id-or-ieee-article-number",
  "source": "semantic_scholar",
  "title": "...",
  "abstract": "...",
  "paperId": "...",
  "articleNumber": "...",
  "doi": "...",
  "arxivId": "...",
  "url": "...",
  "pdfUrl": "...",
  "openAccessPdf": {"url":"..."}
}
```

字段不存在时不得猜测或编造。

## 4. `action: abstract`

### 4.1 语义

对一篇外部搜索结果获取权威的、尽可能完整的元数据和摘要。该 action 是只读的：

- 不下载 PDF；
- 不写入正式文献库；
- 不创建 embedding、chunk 或 note；
- 不把摘要不完整误报为完整摘要。

### 4.2 定位优先级

建议按以下顺序选择定位参数：

1. 直接传入 `paper`（搜索结果对象）；
2. `source=semantic_scholar` + `paperId`；
3. `source=ieee` + `articleNumber`；
4. DOI；
5. 能够安全解析的 `url`。

如果定位信息不足，返回明确的参数错误，不再次进行模糊搜索，除非后续明确设计了可控的 title + year resolve 流程。

### 4.3 Semantic Scholar

使用 Semantic Scholar 单篇论文详情接口获取完整 abstract 和元数据。请求字段至少覆盖当前搜索所需字段：

- paperId、title、abstract；
- year、venue、publicationVenue；
- authors、externalIds；
- url、openAccessPdf；
- citationCount、referenceCount、publicationDate、publicationTypes、fieldsOfStudy、tldr。

返回应明确：

```json
{
  "status": "ready",
  "source": "semantic_scholar",
  "abstractComplete": true,
  "paper": {"...":"..."}
}
```

`abstract` 为空时返回 `abstractComplete: false`，不能用搜索结果中的空值伪装成完整摘要。

### 4.4 IEEE

复用现有：

```ts
ieeeXploreService.fetchArticleAbstract(articleNumber)
```

该服务已经处理 IEEE 文章详情、完整摘要、文章编号、DOI、PDF URL 等信息。返回结果应标记：

```json
{
  "status": "ready",
  "source": "ieee",
  "articleNumber": "12345678",
  "abstractComplete": true,
  "paper": {"...":"..."}
}
```

如果 IEEE 详情接口没有摘要：

```json
{
  "status": "ready",
  "abstractComplete": false,
  "abstract": null,
  "message": "IEEE 文章详情未提供摘要"
}
```

不要把搜索结果片段标记为 `abstractComplete: true`。

### 4.5 错误与缓存

- 单篇详情可使用现有 IEEE 缓存；Semantic Scholar 可增加短 TTL 缓存，但不是实现的前置条件；
- 上游 404、限流、权限错误应保留 source 和稳定定位字段；
- 不应因为摘要失败而自动下载 PDF。

## 5. `action: preview`

### 5.1 目标

临时阅读外部 PDF，适合 Agent 只想查看正文而不想将论文保存进正式文献库。

preview 的成功产物是工作区内的 Markdown 解析文件路径，Agent 使用内置 `read` 工具分段读取，避免把长正文直接塞入 `yarc_search_papers` 的 tool result。

preview 不执行：

- 创建正式 `Paper`；
- 创建 `PaperChunk`；
- 生成 embedding；
- 创建 Note；
- 加入正式文献库分类。

### 5.2 同步模式（默认）

默认 `async=false`。调用必须等待以下流程完成：

```text
校验来源
→ 下载 PDF
→ 写入临时 source.pdf
→ 调用 MinerU
→ 验证解析结果存在且非空
→ 原子写入 content.md
→ 返回可读路径
```

只有在所有条件满足时才能返回 `status=ready` 和 `path`：

1. MinerU 已完成；
2. 解析结果存在；
3. `content.md` 非空；
4. 文件写入完成；
5. 临时 entry 状态已经是 `ready`。

成功返回示例：

```json
{
  "status": "ready",
  "temporaryId": "abc123",
  "path": "temporary-pdfs/abc123/content.md",
  "title": "...",
  "source": "ieee",
  "expiresInMs": 7200000,
  "message": "PDF 已完成 MinerU 解析，可使用 read 工具读取 path。"
}
```

`path` 是相对 Agent 工作区的路径，必须可被 Pi 内置 `read` 读取。不要返回绝对路径，不要返回尚未完成的目录或空文件路径。

### 5.3 异步模式

`async=true` 时不阻塞当前 tool call。如果任务尚未完成，返回：

```json
{
  "status": "parsing",
  "temporaryId": "abc123",
  "retryable": true,
  "message": "PDF 正在进行 MinerU 解析；当前不返回 path，请稍后用同一 temporaryId 重试 preview。"
}
```

关键约束：

- `status=parsing` 时绝不返回 `path`；
- Agent 不得读取临时目录中的文件；
- 后续通过同一个 action 查询：

```json
{
  "action": "preview",
  "temporaryId": "abc123",
  "async": false,
  "mode": "pages",
  "startPage": 1,
  "endPage": 3
}
```

如果异步任务失败，返回：

```json
{
  "status": "failed",
  "temporaryId": "abc123",
  "retryable": true,
  "message": "PDF/MinerU 解析失败：..."
}
```

### 5.4 同步等待超时

同步模式允许有明确超时，例如 180 秒。超时不是成功：

```json
{
  "status": "parsing",
  "temporaryId": "abc123",
  "timedOut": true,
  "retryable": true,
  "message": "等待 MinerU 解析超时，任务仍在继续；当前不返回 path，请稍后重试。"
}
```

如果现有服务只能返回 `parsing`，必须确保 tool result 明确是可重试状态，不能让 Agent 将其当作正文可用。

### 5.5 临时服务状态机

建议将现有 `TemporaryPdfService` 扩展为可等待的状态机：

```text
不存在 → parsing → ready
                 ↘ failed
```

同一个 source URL 应复用现有 entry 和正在运行的解析 Promise：

- 已 `ready`：直接返回路径；
- 已 `parsing`：同步调用等待已有 Promise，异步调用立即返回状态；
- 已 `failed`：返回失败或显式重试时重新创建；
- 不允许并发创建同一 URL 的多个 MinerU 任务。

建议新增概念 API（命名可按实际代码调整）：

```ts
await temporaryPdfService.ensureReady(sourceUrl, {
  title,
  wait: !async,
  timeoutMs: 180_000,
  retryFailed: false,
})

await temporaryPdfService.getReadablePath(temporaryId)
```

### 5.6 文件写入原子性

解析结果写入 `content.md` 时，先写临时文件，例如：

```text
content.md.tmp
```

写入并关闭后，再使用同目录 rename 替换 `content.md`，最后将状态设为 `ready`。这样即使内置 `read` 意外并发，也不会读到半文件。

服务状态应以内存 entry 的 `status` 为准；磁盘存在 `content.md` 只能作为启动恢复的辅助证据，不能把任意存在的空文件视为 ready。

### 5.7 `mode` 处理

`preview` 的 `mode` 主要用于告诉 Agent 后续阅读意图和校验范围：

- `metadata`：只返回临时文档元信息和 path；
- `pages`：返回 path，并可返回建议的页范围；
- `full_text`：返回 path，不直接把全文放入 tool result。

长正文统一使用内置 `read`：

```json
{"path":"temporary-pdfs/abc123/content.md","offset":1,"limit":200}
```

如果未来需要按页精确读取，可新增只读 helper，但不是本设计的必要条件。

## 6. `action: import`

### 6.1 目标

将外部搜索结果正式保存为本地文献，并按现有流程下载 PDF、解析、向量化和显示任务进度。

建议把现有：

```text
yarc_papers action=save type=library importPdf=true
```

的核心逻辑抽到共享导入服务，再由两个入口调用：

- `yarc_search_papers action=import`；
- 旧的 `yarc_papers action=save type=library importPdf=true`（兼容入口）。

不要维护两套 PDF 下载、IEEE 详情补全、Paper 创建和任务队列逻辑。

### 6.2 输入

支持单篇和批量：

```json
{
  "action": "import",
  "papers": [{
    "id": "...",
    "source": "ieee",
    "title": "...",
    "articleNumber": "12345678",
    "pdfUrl": "..."
  }],
  "category": "移动计算",
  "requirePdf": true,
  "extractMetadata": false
}
```

也可使用 `paper` 单篇字段，服务端统一规范化为 `papers[]`。

必要时允许 Agent 只传稳定定位字段：

- Semantic Scholar `paperId`；
- IEEE `articleNumber`；
- DOI；
- 或完整 search result。

如果只有稳定 ID，服务端应先补全详情，再提交导入任务；不能用缺少标题的对象直接创建脆弱记录。

### 6.3 返回

默认采用后台任务语义：

```json
{
  "status": "queued",
  "jobId": "...",
  "total": 1,
  "message": "PDF 导入、MinerU 解析和后续任务已排队。"
}
```

`requirePdf=true` 时 PDF 下载失败应标记该项失败，不应静默创建 metadata-only 记录。只有显式 `requirePdf=false` 时才允许元数据回退，并在结果中明确 warning。

可选未来参数：

```ts
wait?: boolean
waitFor?: 'downloaded' | 'parsed' | 'embedded'
waitTimeoutMs?: number
```

本设计建议第一版仍默认异步；如果实现 `wait=true`，超时返回 `status=processing` 和 jobId，不能返回“已解析”假状态。

### 6.4 来源和下载

优先复用 `ImportJobService` 的来源解析：

```text
pdfBase64/file
→ pdfUrl
→ openAccessPdf.url
→ pdfPath
→ url
```

IEEE 文章应继续通过 article number 和 `ieeeXploreService.fetchArticleAbstract()` 补全详情；PDF 下载继续复用 `searchService.downloadPdf()`，保留 IEEE Cookie、HTTP/1.1/native fallback、Range/安全校验和重试逻辑。

Semantic Scholar 只有在 `openAccessPdf.url` 可用时才自动下载；搜索结果只有 landing page `url` 时，不应假定它是 PDF。

## 7. 与现有工具的边界

### `yarc_search_papers`

外部/本地搜索以及外部结果的摘要、临时预览、正式导入：

```text
search / abstract / preview / import
```

### `yarc_papers`

正式本地文献库：

```text
list / read / save / classify / update / delete
```

后续可以逐步弱化 `yarc_papers save type=library importPdf=true` 的 Agent prompt 推荐，但短期必须保留兼容。

### 内置 `read`

读取 `preview` 返回的临时 Markdown 路径，或普通 `data` 工作区文件。Agent 只能在 `preview` 返回 `status=ready` 后读取该 path。

### `TemporaryPdfService`

临时 PDF 下载、MinerU 解析、状态和 TTL 清理。不能写入 `Paper`、`PaperChunk` 或 Note。

### `ImportJobService`

正式文献入库后台任务。可被新的 `action=import` 复用。

## 8. Agent 工作流示例

### 8.1 Semantic Scholar：只看摘要

```text
1. yarc_search_papers(action=search, source=semantic_scholar, query=...)
2. 直接使用返回的完整 abstract
3. 不下载 PDF、不入库
```

如果搜索结果没有摘要：

```text
1. yarc_search_papers(action=abstract, source=semantic_scholar, paperId=...)
```

### 8.2 IEEE：搜索摘要不完整，补全文摘

```text
1. yarc_search_papers(action=search, source=ieee, query=...)
2. 选定文章后调用 action=abstract + articleNumber
3. 使用完整摘要判断是否继续
```

### 8.3 外部论文临时读正文

```text
1. yarc_search_papers(action=search)
2. yarc_search_papers(action=preview, source=..., paper=..., async=false)
3. 只有 status=ready 才拿 path
4. 内置 read(path, offset, limit) 分段读取
5. 不创建正式 Paper，临时目录到期清理
```

异步版本：

```text
1. action=preview, async=true
2. 收到 status=parsing、temporaryId；不读取 path
3. 稍后 action=preview, temporaryId=..., async=false
4. 收到 status=ready 后再 read(path)
```

### 8.4 外部论文正式入库

```text
1. yarc_search_papers(action=search)
2. 必要时 action=abstract
3. 用户明确要求保存/入库后 action=import
4. 获取 jobId，等待或查询任务状态
5. 入库完成后使用 yarc_papers action=read
```

### 8.5 临时阅读后决定入库

临时 preview 和正式 import 应尽量复用同一份规范化论文元数据，但不能直接把临时目录升级成正式 Paper。用户确认后仍应走 `import`，以保证正式文件路径、数据库、chunks、embedding 和任务状态完整一致。

## 9. 错误、权限和安全边界

### 9.1 不可读 PDF

如果 source 没有可用 PDF：

```json
{
  "status": "unavailable",
  "retryable": false,
  "message": "没有可用的开放 PDF；可以使用 abstract，或在用户提供 PDF 后 import。"
}
```

不要把文章网页 URL 当作 PDF 下载源。

### 9.2 IEEE 权限

IEEE 搜索和摘要可能可用，但 PDF 可能因订阅、机构权限或上游响应而失败。必须区分：

- 摘要可读；
- PDF URL 存在；
- PDF 实际可下载；
- MinerU 解析成功。

不能因为有 `pdfUrl` 就声称 PDF 可读。

### 9.3 SSRF 和路径

继续复用 `SearchService` 的安全 URL 校验和 IEEE 特殊处理。返回给 Agent 的 preview path：

- 只返回相对 Agent workspace 的路径；
- 不返回绝对路径、密钥路径或内部临时目录之外的路径；
- 只能在 ready 后暴露；
- 过期后 read 应得到明确的 not found/expired 错误。

### 9.4 用户确认

以下操作需要用户明确意图或已经授权：

- `preview`：下载外部 PDF 可能消耗网络和 MinerU 资源，但不写正式文献；Agent 应在用户要求阅读正文或明确允许时调用；
- `import`：创建本地文献、下载 PDF、启动解析和后续任务；只有用户明确要求保存/入库/下载到文献库时调用；
- 删除、覆盖、分类移动继续遵循现有规则。

## 10. 实现分阶段计划

### Phase 0：确认契约

- 在 `packages/shared` 或后端内部定义 action/result 类型；
- 明确 `source`、稳定 ID、preview status、import status；
- 不改变旧 `action` 缺省行为。

### Phase 1：抽取和复用服务

- 抽取外部论文定位/规范化函数；
- 为 Semantic Scholar 增加单篇详情方法；
- 让 `TemporaryPdfService` 支持 `ensureReady`、Promise 去重、同步等待、超时和原子 content 写入；
- 抽取共享 import service，复用 `ImportJobService`。

### Phase 2：扩展 `yarc_search_papers`

- 增加 `action` schema 和 conditional validation；
- 实现 `abstract`；
- 实现同步 `preview`；
- 实现 `async=true` 的 preview 状态返回；
- 实现 `import` 单篇/批量；
- 保持 `search` 和旧调用兼容。

### Phase 3：Prompt 与前端契约

- 更新 `apps/api/src/lib/prompts.ts`：明确四种 action 的使用时机；
- 强调 preview 的 `status=parsing` 不可读、无 path；
- 强调 import 只在用户明确要求保存时调用；
- 前端工具调用结果按钮继续只处理 `search` 的结果展示，不因 abstract/preview/import 自动弹出搜索框。

### Phase 4：验证

最小验证：

```bash
pnpm --filter @yarc/api build
pnpm --filter @yarc/web build
pnpm test
```

建议新增测试：

1. `action` 缺省仍按 search；
2. Semantic Scholar search/abstract 不截断完整摘要；
3. IEEE abstract 使用文章详情接口；
4. preview 同步模式只在 ready 且 content 非空时返回 path；
5. preview async 模式 parsing 不返回 path；
6. 同 URL 并发 preview 只产生一个下载/MinerU 任务；
7. preview 失败和超时返回明确 retryable 状态；
8. 临时 Markdown 使用原子写入；
9. import 复用现有 `ImportJobService`；
10. 旧 `yarc_papers save type=library importPdf=true` 行为不回归；
11. 无 `openAccessPdf.url` 时 Semantic Scholar 不把普通 `url` 当 PDF；
12. IEEE PDF 权限失败时摘要仍可用。

## 11. 不在本阶段实现的内容

- 不新增相近命名的 `yarc_search_paper`；
- 不让 `yarc_papers action=read` 直接读取外部搜索结果；
- 不把 preview 临时文件自动升级为正式 Paper；
- 不默认下载所有搜索结果的 PDF；
- 不把长正文直接塞进 `yarc_search_papers` 返回文本；
- 不将普通论文 landing page 当成 PDF；
- 不设计独立的前端“搜索结果会话”持久化机制；
- 不因为 `async=true` 就把未完成的 path 暴露给 Agent。

## 12. 当前已知实现锚点

实现新上下文时优先检查这些文件：

- `apps/api/src/services/pi.service.ts`
  - 当前 `yarc_search_papers` tool schema 和执行逻辑；
  - 当前 Semantic Scholar/IEEE 搜索结果格式化；
  - 当前 `yarc_papers action=read/save`。
- `apps/api/src/services/search.service.ts`
  - `searchSemanticScholar`、`searchIEEE`；
  - `fetchPdfStream`、`downloadPdf`；
  - PDF URL 安全校验。
- `apps/api/src/services/ieee-xplore.service.ts`
  - IEEE 文章详情和完整摘要；
  - IEEE PDF URL/文章编号规范化。
- `apps/api/src/services/temporary-pdf.service.ts`
  - 临时 PDF 生命周期、MinerU 解析、TTL 清理；
  - 当前更偏前端轮询，需要扩展同步等待接口。
- `apps/api/src/services/import-job.service.ts`
  - 正式 PDF 下载、IEEE 元数据补全、`paperService.importFromSearchResult`；
  - 应作为 import 的主要复用入口。
- `apps/api/src/services/paper.service.ts`
  - 正式搜索结果入库。
- `apps/api/src/lib/prompts.ts`
  - Agent 工具说明、读取工作流和用户确认边界。
- `apps/api/src/routes/search.ts`
  - 前端临时 PDF 创建/状态/流式读取接口；
  - 不要把前端异步 API 直接当作 Agent tool result。
- `packages/shared/src/types/index.ts`
  - `ChatEvent`、`SearchPaper` 等跨端类型。

实现前先确认当前工作区和 Git 状态，避免覆盖其他未提交改动。
