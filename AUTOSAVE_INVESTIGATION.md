# YARC 文件自动保存与 Agent 并发修改问题调查报告

> 状态：仅调查与方案记录，尚未修改任何业务代码。
>
> 调查基线：当前分支 `master`，HEAD `a43fa1a`。
>
> 本报告重点记录：文件自动保存、WebSocket 实时编辑、IndexedDB 离线缓存、Agent 直接改盘、文件 watcher 和 Yjs session 之间的关系。

## 1. 用户现象

目前观察到的现象包括：

1. 编辑一行后似乎没有自动保存。
2. 刷新页面后，文件跳回较早的版本，尽管此前已经有很多修改，并且部分修改应该已经保存过。
3. Agent 修改文件后，用户继续编辑时问题更容易出现。
4. 文件偶尔出现重复内容。
5. 严重时文件内容变空或只剩部分内容。

这些现象不是同一个故障的简单重复，而是多个并发和恢复路径叠加后的结果。当前实现同时存在：

- 浏览器内的 Yjs 实时文档；
- 服务端内存中的 Yjs session；
- 磁盘上的普通文本文件；
- Agent 直接写磁盘的路径；
- 每秒一次的外部文件 watcher；
- IndexedDB 文本缓存；
- Service Worker 的 GET 缓存。

这些状态之间没有统一的 revision、写入队列或可靠的保存确认协议。

---

## 2. 当前数据流

### 2.1 浏览器编辑路径

当前可编辑文件通常通过以下路径打开：

```text
CodeMirror + y-codemirror
        ↓
浏览器 Y.Doc / Y.Text
        ↓ WebSocket update
服务端 LiveFileService 的 Y.Doc / Y.Text
        ↓ 800ms 自动保存计时器
磁盘文件
```

主要代码：

- `apps/web/src/components/files/CodeEditor.vue`
- `apps/web/src/composables/useLiveFiles.ts`
- `apps/api/src/index.ts`
- `apps/api/src/services/live-file.service.ts`

### 2.2 Agent 修改路径

Pi 内置的 `read`、`edit`、`write`、`bash` 工具默认直接在 `data` 工作区执行文件操作。Agent 的 `edit` 和 `write` 使用 `fs/promises.writeFile`，没有经过 `liveFileService`。

```text
Agent edit/write/bash
        ↓
磁盘文件
        ↓ 最多约 1 秒后
FileService watcher
        ↓
LiveFileService.handleDiskChange()
        ↓ diff-match-patch 合并
服务端 Y.Doc
```

主要证据：

- `apps/api/src/services/pi.service.ts` 创建 Pi session 时没有替换内置文件工具的文件操作实现。
- 已安装 Pi 包：
  - `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js`
  - `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js`
- `apps/api/src/services/file.service.ts:237-259` 通过定时扫描发现外部磁盘变化。

### 2.3 当前离线缓存路径

当前 `useLiveFiles.open()` 会先读取 IndexedDB 快照。如果快照存在，即使浏览器当前在线，也会先用缓存内容构造 Y.Doc，并立即返回客户端；WebSocket 在后台连接。

```text
IndexedDB snapshot
        ↓
先构造浏览器 Y.Doc
        ↓
后台连接 WebSocket
        ↓
收到服务端 init 后尝试合并或清理
```

主要代码：

- `apps/web/src/composables/useLiveFiles.ts:66-90`
- `apps/web/src/composables/useLiveFiles.ts:141-155`
- `apps/web/src/composables/useLiveFiles.ts:197-225`
- `apps/web/src/lib/offline-workspace-cache.ts`
- `apps/web/public/sw.js`

---

## 3. 已确认的高风险问题

## 3.1 后端 `flush()` 没有串行化，会发生旧版本覆盖新版本

主要代码：

- `apps/api/src/services/live-file.service.ts:275-284`
- `apps/api/src/services/live-file.service.ts:406-462`

`flush()` 可能被以下来源同时调用：

- 800ms 自动保存计时器；
- 用户点击保存或按 `Ctrl/Cmd+S`；
- 切换/关闭文件时保存；
- 页面卸载时保存；
- Agent/API 写入触发的保存；
- 冲突处理保存；
- 最后一个 WebSocket 客户端断开时的保存。

当前 `session.saving` 只是一个状态字段，不是锁。多个 `flush()` 可以同时执行。每个调用都会：

1. 读取当前内存内容；
2. 检查磁盘；
3. 写入磁盘；
4. 更新 `lastFlushedHash`；
5. 无条件把 `session.dirty` 设为 `false`。

如果第一次 flush 捕获了旧内容 `OLD`，第二次 flush 捕获了新内容 `NEW`，执行顺序可能是：

```text
第一次 flush 开始，准备写 OLD
用户继续编辑，第二次 flush 准备写 NEW
第二次 flush 完成，磁盘为 NEW
第一次 flush 之后完成，磁盘回到 OLD
```

更严重的是，第一次 flush 完成时还会把 `session.dirty` 设为 `false`，因此服务端可能同时出现：

```text
磁盘内容：OLD
Live Y.Doc 内容：NEW
dirty：false
```

这会让前端误以为最新内容已经保存，而下一次刷新从磁盘重新读取时回到旧版本。

### 临时复现结果

在 `/tmp` 临时目录中直接运行当前 `LiveFileService`，人为延迟第一次写入后，实际得到：

```text
第二次保存完成后：磁盘 NEW，Live 内容 NEW，dirty=false
第一次保存最终完成后：磁盘 OLD，Live 内容 NEW，dirty=false
```

这已经足以确认“保存过但刷新后回到早期版本”存在确定的代码路径。

---

## 3.2 Agent 与用户修改之间没有统一写入协议

Agent 内置 `edit`/`write` 直接调用 `fs/promises.writeFile`。Pi 自己的 `withFileMutationQueue()` 只能串行化同一个 Pi 工具进程内部的操作，不能串行化：

- Pi 与 YARC 浏览器；
- Pi 与 `LiveFileService`；
- Pi 与 FileService watcher；
- 多个 YARC WebSocket 客户端。

因此，当前系统实际上有两个独立 writer：

```text
浏览器 writer：Yjs → LiveFileService → 磁盘
Agent writer：直接 writeFile → 磁盘
```

它们之间只有轮询发现和事后合并，没有写入前的版本检查。

---

## 3.3 当前“冲突检测”不能识别同一行的语义冲突

主要代码：

- `apps/api/src/services/live-file.service.ts:479-532`

当前外部修改的处理逻辑是：

```ts
const patches = dmp.patch_make(baseDiskContent, disk.content)
const [merged, results] = dmp.patch_apply(patches, live)
const safe = results.length === 0 || results.every(Boolean)
```

这里的 `safe` 只表示 patch 找到了可以应用的位置，不表示用户和 Agent 没有修改同一段内容。

### 临时复现结果

以如下内容为例：

```text
磁盘基线：A / B
用户当前内容：A / USER
Agent 修改后的磁盘：A / AGENT
```

当前实现的结果是：

```text
Live 内容：A / AGENT
conflict：false
dirty：false
```

用户的 `USER` 修改被静默覆盖，界面不会显示冲突。

因此，“Agent 改完以后用户继续编辑更容易出问题”不是错觉，而是当前合并算法和写入时序共同导致的。

---

## 3.4 WebSocket 重连到新 Yjs session 时可能重复整个文件

主要代码：

- `apps/web/src/composables/useLiveFiles.ts:197-225`
- `apps/api/src/services/live-file.service.ts:287-299`

服务端在最后一个客户端断开后，干净 session 约 30 秒后会被销毁：

```ts
const RETIRE_CLEAN_DELAY_MS = 30_000
```

如果之后客户端重连，服务端会从磁盘创建一个新的 Y.Doc。客户端却继续使用旧的 Y.Doc，并直接执行：

```ts
Y.applyUpdate(ydoc, serverUpdate, 'server')
```

如果旧客户端已有内容 `A`，新服务端 session 也从磁盘插入内容 `A`，由于两次插入拥有不同的 Yjs item ID，Yjs 不会把它们识别为同一段文本。

### Yjs 临时验证

使用当前项目的 Yjs 版本验证：

```text
旧客户端文档：A
新服务端文档：A
应用服务端 init update 后：AA
```

长文件会变成“旧内容 + 新内容”。如果客户端同时存在未发送修改，重复内容还可能被重新写回磁盘。

当前代码中只对首次缓存加载做了特殊清理：

```ts
if (usingCachedSnapshot && !hadLocalDirty && ytext.length) {
  // 清空缓存内容
}
```

第一次 init 后 `usingCachedSnapshot` 会设为 `false`，之后的重连不会走这段清理逻辑。

这可以直接解释“有时文件会出现重复内容”。

---

## 3.5 IndexedDB 缓存混淆了“已保存快照”和“未保存草稿”

主要代码：

- `apps/web/src/composables/useLiveFiles.ts:66-90`
- `apps/web/src/composables/useLiveFiles.ts:141-155`
- `apps/web/src/composables/useLiveFiles.ts:201-225`
- `apps/web/src/lib/offline-workspace-cache.ts:6-11`

当前缓存只包含：

```text
path
content
language
modified
cachedAt
```

没有包含：

- dirty 状态；
- 服务端 revision；
- 磁盘 hash；
- Yjs state vector；
- 是否收到服务端保存确认；
- 内容的来源是磁盘、服务端还是本地草稿。

而且缓存会在文本变化后 300ms 写入，关闭文件时也会写入。因此缓存可能包含尚未真正写入磁盘的内容。

刷新页面时，新的客户端会把缓存内容当作普通初始内容，`dirty` 却从 `false` 开始。如果服务端 init 到达时 `hadLocalDirty` 仍然是 `false`，当前代码会清空缓存并使用服务端内容。

可能出现：

```text
浏览器缓存：较新的未保存内容
磁盘/服务端：较旧内容
刷新页面
缓存被当作普通缓存清理
界面回到较旧内容
```

这说明缓存确实是用户感受到“刷新回退”的重要因素，但它不是唯一根因。即使完全移除当前缓存初始化逻辑，后端 flush 竞态和 Agent 并发写入仍然会导致回退。

---

## 3.6 `flush()` 的前端等待句柄只有一组，多个保存请求会互相覆盖

主要代码：

- `apps/web/src/composables/useLiveFiles.ts:100-115`
- `apps/web/src/composables/useLiveFiles.ts:327-347`

当前客户端只有：

```ts
pendingFlushResolve
pendingFlushReject
```

如果保存 A 还在等待，保存 B 又开始，B 会覆盖 A 的 resolver。结果可能是：

- 磁盘已经写入，但保存 A 在前端 20 秒后超时；
- UI 显示保存失败，但实际状态不明确；
- 关闭文件、手动保存、自动保存之间出现等待句柄覆盖。

`resolveConflict()` 还和 `flush()` 共享同一组 pending promise。

---

## 3.7 直接 `writeFile` 不是原子写入，存在空文件/部分文件风险

主要代码：

- `apps/api/src/services/live-file.service.ts:210-225`
- `apps/api/src/services/file.service.ts:391-392`
- Pi 内置 `edit.js` 和 `write.js`

当前写入方式都是直接写目标文件：

```ts
await writeFile(target, content, 'utf-8')
```

没有临时文件、fsync、rename 或旧版本备份。如果进程在截断后、写入完成前退出，或者写入本身失败，文件可能变成空文件或部分内容。

此外，`live-file.service.ts:447-449` 会吞掉读取磁盘阶段的错误，然后继续尝试将内存内容写回磁盘；当磁盘文件暂时不存在或处于不稳定状态时，这会进一步放大误覆盖风险。

目前没有日志能确认用户那次“内容直接没有了”具体由哪一次写入造成，但当前实现确实存在产生空/部分文件的机制。

---

## 3.8 watcher 只处理第一个变化路径，且异步处理没有纳入扫描锁

主要代码：

- `apps/api/src/services/file.service.ts:195-235`
- `apps/api/src/services/file.service.ts:237-259`
- `apps/api/src/services/file.service.ts:168-180`

当前 watcher：

- 每秒扫描一次；
- 只比较 mtime 和 size；
- 每次只返回第一个变化路径；
- 变化处理启动后，扫描函数就会结束，不等待 `handleDiskChange()` 完成。

因此连续快速写入、多个文件同时修改、watcher 与 autosave 交叠时，容易形成延迟和重入。

---

# 4. 关于缓存的建议

## 4.1 不建议继续把缓存内容提前装入 Y.Doc

用户提出的方向是正确的：

> 只有连不上后端时才使用缓存；在线且后端可连接时，使用服务端权威内容。

建议将 `open()` 改成明确的两阶段流程：

```text
阶段 1：尝试连接 WebSocket，并等待服务端 init
        ↓ 成功
使用服务端 Y.Doc / 内容，更新缓存

        ↓ 超时或连接失败
阶段 2：读取 IndexedDB 缓存，显示离线只读副本
```

关键原则：

1. **在线时不先把普通文本缓存插入 Y.Doc。**
2. **服务端 init 成功后，缓存只作为被覆盖的旧副本，不参与 CRDT 合并。**
3. **缓存内容不能在没有 revision/hash 的情况下作为“本地修改”发送回服务端。**
4. **离线副本默认只读，当前 UI 已经有这个方向，应继续保持。**
5. **重连时不能把离线文本直接作为 Yjs update 合并到新 session。**

这会直接消除当前最明显的缓存重复来源：

```text
缓存普通文本 → 插入一个新 Y.Doc
服务端普通文本 → 插入另一个 Y.Doc
Y.applyUpdate → 两份内容拼接/重复
```

## 4.2 缓存应该分成“已确认快照”和“本地草稿”

如果系统仍然需要保留用户断线前的编辑内容，不能只保留一个 `content` 字段。建议至少分成：

```text
lastKnownGood：最近一次服务端确认保存的内容
localDraft：尚未得到服务端确认的本地内容
```

每份内容应包含：

```text
path
content
baseContent 或 baseHash
diskHash
serverRevision
cachedAt
savedAt
dirty
source: server | local-draft | offline
```

推荐行为：

### 在线且连接成功

- 使用服务端 init 内容；
- `lastKnownGood` 更新为服务端内容；
- 如果存在旧 `localDraft`，不要自动覆盖服务端内容；显示“发现未同步草稿”；
- 让用户选择恢复草稿、丢弃草稿或进入三方合并。

### 后端不可连接

- 使用 `lastKnownGood` 作为可靠只读副本；
- 如果存在 `localDraft`，可以额外显示“本地未同步草稿”；
- 默认不要让离线编辑直接覆盖 `lastKnownGood`；
- 如果以后支持离线编辑，必须把草稿与基线分开保存。

### 重新连接成功

- 先获得服务端权威内容；
- 再使用 `baseContent + localDraft + serverContent` 做三方合并；
- 有重叠修改时进入明确冲突流程；
- 不允许直接把普通文本缓存作为 Yjs update 发送。

## 4.3 缓存写入必须串行并防止旧写覆盖新写

当前 `putOfflineWorkspaceFile()` 是 fire-and-forget，每次写入都可能开启新的 IndexedDB 连接。建议：

- 每个文件维护一个 IndexedDB 写入队列；
- 给快照加单调递增的 `cacheRevision`；
- 写入前后检查 revision；
- 旧 revision 不能覆盖新 revision；
- 在成功保存后立即写入 `lastKnownGood`；
- 缓存写入失败不能影响正常在线编辑，也不能把缓存状态误报为保存成功。

## 4.4 只有“文件内容变化”时更新缓存，但要区分来源

可以保留“文件发生变化就更新缓存”的策略，但建议明确区分：

```text
服务端 init / 远端 update：更新 lastKnownGood
本地用户编辑：更新 localDraft
服务端 flush ack：把 localDraft 提升为 lastKnownGood
离线读取：不修改 lastKnownGood
```

不能让所有 `ytext.observe()` 事件都无条件写入同一个普通快照，否则会继续把未保存内容伪装成已保存内容。

---

# 5. 必须同时修复的非缓存问题

仅调整缓存会减少“刷新后读取到旧缓存”和“缓存与服务端 Y.Doc 拼接”的问题，但不能解决全部数据丢失。建议把以下修复作为同一组保存协议升级。

## 5.1 为每个文件增加服务端串行写入队列

所有以下操作都必须进入同一个 per-file queue：

- `applyClientUpdate`
- `replaceContent`
- `flush`
- `handleDiskChange`
- `resolveConflict`
- 最后一个客户端断开时的 flush
- Agent/API 外部修改进入 live session 的处理

至少要保证：

```text
同一文件任何时刻只有一个磁盘合并/写入操作
```

## 5.2 使用 revision 检查，禁止旧 flush 把新内容标记为干净

每次 Y.Doc 内容变化时递增 `contentRevision`。flush 开始时记录：

```text
flushRevision = session.contentRevision
flushContent = 当前内容
```

写入完成后只有在：

```text
session.contentRevision === flushRevision
```

时，才允许设置：

```text
session.dirty = false
```

如果写入期间发生了新修改：

- 旧写入仍然可以完成或被队列化；
- 但不能清除 dirty 状态；
- 必须继续保存最新 revision。

## 5.3 用原子替换替代直接覆盖

推荐的磁盘写入流程：

```text
写入同目录临时文件
        ↓
校验大小/hash
        ↓
必要时 fsync
        ↓
rename 临时文件替换正式文件
```

必要时保留最近一个 `.bak` 或受控版本快照，以便从应用层恢复误覆盖内容。

## 5.4 Agent 写入必须接入版本检查或统一 writer

可选方案按可靠性排序：

### 方案 A：统一 writer（推荐）

让 Agent 的 `read/edit/write` 通过 YARC 的文件服务或一个统一的文件写入层执行，不再直接写磁盘。这样 Agent 和浏览器共享同一个 per-file queue、revision 和冲突处理。

### 方案 B：Agent 写入带 base hash 的条件写入

Agent 读取文件时记录 `baseHash`。写入时服务端检查磁盘 hash 是否仍等于 `baseHash`：

- 相同：允许写入；
- 不同：进入三方合并或明确冲突；
- 不允许只依赖 watcher 事后补救。

### 方案 C：保留直接写盘，但增强 watcher

这是最不推荐的方案。至少需要：

- 监听完成后读取内容 hash；
- 记录外部写入 revision；
- 与浏览器保存队列串行化；
- 对同一段重叠修改做真正的三方冲突检测；
- 不能把 `patch_apply` 返回 true 当作没有冲突。

## 5.5 Yjs session 重建时必须使用新客户端文档

服务端 init 应包含明确的 `sessionEpoch` 或 `documentId`。

客户端发现服务端文档 epoch 与当前不同，必须：

```text
没有未同步本地修改：销毁旧 Y.Doc，使用服务端新文档
有未同步本地修改：保存为 localDraft，进行三方合并或提示用户
```

不能继续对旧 Y.Doc 直接执行 `Y.applyUpdate`。

## 5.6 保存确认必须按 request/revision 管理

客户端不能只维护一个 `pendingFlushResolve`。建议每次保存包含：

```text
requestId
contentRevision
baseHash
```

服务端返回：

```text
requestId
savedRevision
savedHash
savedAt
```

只有对应 revision 得到确认时，前端才能把该 revision 标记为已保存。

## 5.7 watcher 必须等待处理完成并处理所有变化

至少需要：

- 一轮扫描收集全部变化路径；
- 等待这些路径的 `handleDiskChange()` 完成；
- 同一文件进入统一队列；
- 优先使用文件系统事件或内容 hash，而不是只比较 mtime/size；
- 为外部修改记录 source、hash、revision 和处理结果。

---

# 6. 推荐的缓存改造方案

综合当前需求，推荐采用以下策略：

## 在线打开文件

```text
1. 创建 LiveFileClient，但不把 IndexedDB 文本插入 Y.Doc
2. 连接 WebSocket
3. 等待服务端 init
4. 成功后使用服务端内容
5. 将服务端确认内容写入 lastKnownGood cache
6. 如果存在 localDraft，显示“存在未同步草稿”，不自动覆盖
```

## 后端连接失败

```text
1. 尝试连接到明确的超时
2. 连接失败后读取 lastKnownGood cache
3. 显示离线只读副本
4. 不把缓存文本作为 Yjs update 发送
5. 记录 offline 状态和缓存时间
```

## 后端恢复

```text
1. 重新获取服务端权威内容
2. 比较 serverRevision / diskHash
3. 没有 localDraft：直接替换离线显示内容
4. 有 localDraft：进入恢复或三方合并流程
5. 合并完成并收到保存 ack 后更新 lastKnownGood
```

## 重要约束

```text
IndexedDB 普通文本缓存 ≠ Yjs 状态
lastKnownGood ≠ localDraft
缓存显示 ≠ 保存成功
收到 WebSocket update ≠ 磁盘已经持久化
收到 flush 请求 ≠ 对应 revision 已保存
```

---

# 7. 建议的验证用例

修复后至少需要自动化覆盖以下场景：

1. 普通编辑，停止输入 1 秒后刷新。
2. 连续快速编辑后立即按 `Ctrl/Cmd+S`。
3. 自动保存和手动保存同时发生。
4. 新修改发生在旧 flush 正在写入期间。
5. Agent 修改不同位置，用户同时编辑其他位置。
6. Agent 和用户修改同一行，必须出现冲突或明确三方合并，不能静默丢失。
7. Agent 使用 `edit` 修改文件后，用户继续输入。
8. Agent 使用 `write` 完整覆盖文件时，用户有未保存修改。
9. WebSocket 断开数秒后重连。
10. WebSocket 断开超过 30 秒，服务端 session 被回收后重连。
11. API 进程重启后浏览器重连。
12. 在线状态下存在旧 IndexedDB 缓存，打开文件必须使用服务端内容，不得先显示并合并缓存。
13. 后端不可连接时使用缓存，只读显示并标注缓存时间。
14. 离线期间存在 localDraft，恢复连接后不得静默丢弃。
15. IndexedDB 连续快速写入时，旧快照不能覆盖新快照。
16. 写入过程中模拟进程异常或 I/O 错误，正式文件不能变为空文件。
17. 两个浏览器标签页同时编辑同一个文件。
18. 文件删除、重命名、外部替换和恢复连接交错发生。

每个用例都应同时断言：

- 编辑器显示内容；
- 浏览器本地状态；
- 服务端 Y.Doc 内容；
- 磁盘内容；
- dirty/saving/conflict 状态；
- revision/hash；
- 刷新或重连后的最终内容。

---

# 8. 建议增加的诊断日志

当前日志无法定位具体哪一次保存覆盖了哪一次保存。建议增加不包含文件正文的结构化日志：

```text
file path
operationId
source: client | agent | api | disk
clientId
contentRevision
baseHash
contentHash
sessionEpoch
flush start/end
write start/end
conflict result
error code
```

尤其要记录：

- flush 开始时的 revision/hash；
- flush 完成时的 revision/hash；
- 如果完成时 revision 已变化，必须记录为 stale flush；
- Agent 外部写入被发现时的磁盘 hash；
- Yjs session 是否发生重建；
- 缓存使用原因是 online success 还是 backend unavailable。

日志中不要记录文件正文、密钥、token 或用户隐私内容。

---

# 9. 最终判断

用户认为“缓存造成了一部分问题”是正确的，尤其是以下两点：

1. 当前缓存会在在线状态下提前参与 Yjs 文档构造；
2. 缓存没有区分已保存快照和未保存草稿。

因此，缓存应改为 **online-first、backend-authoritative、offline-fallback**：

```text
能连接后端：只使用后端内容
连不上后端：才使用缓存
缓存内容发生变化：按来源更新 lastKnownGood 或 localDraft
重连后：不要把普通缓存直接合并进 Yjs
```

但是，仅修改缓存还不够。真正导致旧版本回滚和 Agent 并发丢失修改的核心问题仍然是：

- 服务端 flush 没有串行化；
- 没有 revision/ack；
- Agent 与浏览器没有统一 writer；
- 外部修改合并不是可靠的三方冲突检测；
- 磁盘写入不是原子的；
- Yjs session 重建时没有重置客户端文档。

后续修复应优先按照以下顺序进行：

1. 每文件单一写入队列 + revision 检查；
2. 原子写入；
3. Yjs session epoch 和重连重建；
4. Agent 与浏览器统一 writer 或条件写入；
5. 缓存拆分为 `lastKnownGood` / `localDraft`，并改为后端优先；
6. 增加 request/revision 保存 ack；
7. 增加上述并发和重连测试。

---

# 10. 本轮实施状态

本报告提出的修复已经落地，当前状态如下：

- 后端按文件串行化 live update、flush、外部磁盘变更和冲突处理；
- flush 使用 `contentRevision`，旧保存不能把更新内容标记为干净；
- 文本文件使用同目录临时文件 + fsync + rename 原子替换；
- Agent 的 `read`、`edit`、`write`、`bash` 工具通过 YARC 的 workspace mutation lock 和 live session bridge；
- Agent edit 会携带读取基线，重叠修改会明确返回冲突；
- watcher 一轮扫描处理全部变化路径，并等待每个 live bridge 完成；
- WebSocket init/status/flush ack 增加 revision、hash 和 `sessionEpoch`；
- 服务端 session 重建后客户端会先清理旧文本，再应用权威 init update，避免整文件重复；
- IndexedDB 文件缓存改为后端优先：在线成功时不先加载缓存，只有连接超时/失败或浏览器明确离线时才使用 `last-known-good`；
- `last-known-good` 与 `local-draft` 分离，缓存写入按 key 串行化；
- 前端保存等待改为 request/revision 级别，不再共用单个 pending resolver；
- session 重建或发现未同步草稿时，界面进入冲突恢复流程，不自动覆盖任意一方；
- 打开 live 文件后，前端不再用可缓存的 HTTP 内容刷新 live Y.Doc，避免 Service Worker 旧响应覆盖实时内容；
- 关键保存/冲突事件记录 revision、hash、session epoch 和操作来源，不记录文件正文；
- 增加 `apps/api/src/services/live-file.service.test.ts`，覆盖 flush 顺序、重叠冲突、非重叠合并和 Agent 基线合并。

已完成验证：

```text
pnpm --filter @yarc/api typecheck
pnpm --filter @yarc/api test
pnpm --filter @yarc/web build
pnpm build
```

当前仍需注意：

- Service Worker 的 API 策略仍然是 network-first；网络失败时可能展示旧的 HTTP 快照，但不会在在线状态下参与 Yjs 初始化。
- Agent 通过 bash 执行的外部写盘会在命令完成后由 watcher 发现；bash 本身通过 workspace lock 避免与 YARC 内部磁盘写入重叠，但无法约束不经过 YARC 的其他进程。
