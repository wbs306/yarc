// ── Paper ────────────────────────────────────────────────────────────────────

export interface PaperRanking {
  ccf: string | null
  sci: string | null
}

export interface Paper {
  id: string
  title: string
  abstract: string | null
  authors: string[]
  year: number | null
  doi: string | null
  arxivId: string | null
  url: string | null
  filePath: string | null
  fileSize: number | null
  categoryId: string | null
  parseStatus: string
  parseResult: Record<string, unknown> | null
  parsedAt: string | null
  embeddingStatus: string
  embeddingProgress: number
  embeddedAt: string | null
  summaryStatus: string
  summary: string | null
  summarizedAt: string | null
  metadata: Record<string, unknown>
  tags: string[]
  rankings?: PaperRanking
  createdAt: string
  updatedAt: string
}

export interface PaperListItem {
  id: string
  title: string
  authors: string[]
  year: number | null
  filePath: string | null
  fileSize: number | null
  categoryId: string | null
  parseStatus: string
  embeddingStatus: string
  summaryStatus: string
  createdAt: string
  updatedAt: string
}

// ── Category ─────────────────────────────────────────────────────────────────

export interface Category {
  id: string
  name: string
  parentId: string | null
  color: string | null
  createdAt: string
  _count?: { papers: number }
}

// ── Note ─────────────────────────────────────────────────────────────────────

export interface Note {
  id: string
  paperId: string
  title: string
  content: string
  pageNumber: number | null
  highlightText: string | null
  highlightRect: { x: number; y: number; width: number; height: number; page: number } | null
  kind: string
  filePath: string | null
  createdAt: string
  updatedAt: string
}

export type NoteFileSyncStatus = 'synced' | 'unchanged' | 'missing' | 'failed'

export interface NoteFileSyncItem {
  noteId: string
  paperId: string
  status: NoteFileSyncStatus
  error?: string
}

export interface NoteFileSyncResult {
  requestedPaperIds: string[] | null
  matched: number
  synced: number
  unchanged: number
  missing: number
  failed: number
  updatedNoteIds: string[]
  changedPaperIds: string[]
  items: NoteFileSyncItem[]
}

// ── Conversation & Message ───────────────────────────────────────────────────

export interface Conversation {
  id: string
  paperId: string | null
  title: string
  model: string | null
  systemPrompt: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls: ToolCall[] | null
  metadata: MessageMetadata
  createdAt: string
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
}

export interface MessageMetadata {
  thinking?: string
  citations?: Citation[]
  [key: string]: unknown
}

export interface Citation {
  pageNumber: number
  text: string
}

// ── Task ─────────────────────────────────────────────────────────────────────

export type ReparseAction = 'mineru' | 'embedding' | 'metadata' | 'abstract'

export interface ReparsePaperInfo {
  id: string
  title: string
  authors: string[]
  year: number | null
  doi: string | null
  journal: string | null
  venue: string | null
  abstractLength: number
  parseStatus: string
  embeddingStatus: string
  parsedAt: string | null
  embeddedAt: string | null
  mineruAvailable: boolean
}

export interface Task {
  id: string
  paperId: string
  type: 'parse_pdf' | 'generate_embedding' | 'summarize' | 'enrich_metadata' | 'refresh_metadata' | 'extract_abstract'
  status: 'pending' | 'active' | 'completed' | 'failed'
  progress: number
  result: Record<string, unknown> | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

// ── LaTeX workspace builds ───────────────────────────────────────────────────

export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex'
export type LatexBuildStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface LatexDiagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
  file?: string
  line?: number
  column?: number
}

export interface LatexBuild {
  id: string
  path: string
  entry: string
  engine: LatexEngine
  status: LatexBuildStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  exitCode?: number | null
  error?: string
  pdfAvailable: boolean
  synctexAvailable: boolean
  diagnostics: LatexDiagnostic[]
}

export interface LatexBuildLog {
  id: string
  log: string
  diagnostics: LatexDiagnostic[]
}

/** PDF points relative to the page's top-left corner; page is 1-based. */
export interface LatexSyncTexRect {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface LatexSyncTexForwardResult {
  direction: 'forward'
  file: string
  line: number
  column: number
  page?: number
  x?: number
  y?: number
  /** Top-left origin of the first enclosing box (v - H, not raw v). */
  boxX?: number
  boxY?: number
  width?: number
  height?: number
  /** All distinct enclosing boxes, including wrapped lines and page breaks. */
  rectangles: LatexSyncTexRect[]
  raw: string
}

export interface LatexSyncTexBackwardResult {
  direction: 'backward'
  page: number
  x: number
  y: number
  file?: string
  line?: number
  column?: number
  raw: string
}

// ── WebSocket Chat Protocol ──────────────────────────────────────────────────

export type AgentInteractionKind =
  | 'confirm'
  | 'select'
  | 'input'
  | 'editor'
  | 'questionnaire'
  | 'notification'

export interface PiRuntimeKey {
  conversationId: string
  branchId: string
}

export interface PiExtensionCommandInfo {
  name: string
  description?: string
  source: 'extension' | 'skill' | 'prompt' | 'builtin'
}

export interface PiComposerMirror {
  conversationId: string
  branchId: string
  text: string
  selectionStart: number
  selectionEnd: number
  revision: number
  clientId: string
}

export type PiTuiSurfaceKind = 'custom' | 'widget' | 'header' | 'footer' | 'editor'

export interface PiTuiSurfaceState {
  surfaceId: string
  conversationId: string
  branchId: string
  kind: PiTuiSurfaceKind
  overlay: boolean
  cols: number
  rows: number
  revision: number
  ansi: string
  plainText: string
  hidden?: boolean
  hostKey?: string
  placement?: 'aboveEditor' | 'belowEditor'
  overlayOptions?: {
    width?: number | string
    minWidth?: number
    maxHeight?: number | string
    anchor?: string
    offsetX?: number
    offsetY?: number
    row?: number | string
    col?: number | string
    margin?: number | { top?: number; right?: number; bottom?: number; left?: number }
    nonCapturing?: boolean
  }
}

export interface AgentInteractionRequest {
  type: 'agent_interaction_request'
  requestId: string
  conversationId: string
  branchId: string
  streamMessageId: string
  kind: AgentInteractionKind
  title?: string
  message?: string
  payload: unknown
  createdAt: string
  timeoutMs?: number
}

export interface AgentInteractionResponse {
  requestId: string
  action: 'submit' | 'cancel' | 'chat'
  value?: unknown
  conversationId?: string
  branchId?: string
  clientId?: string
}

export interface AgentInteractionResolved {
  type: 'agent_interaction_resolved'
  requestId: string
  action: 'submit' | 'cancel' | 'chat'
  reason?: string
}

export type CurrentChatResource =
  | { type: 'paper'; paperId: string; title: string }
  | { type: 'file'; path: string; name?: string }

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ChatThinkingLevel = 'off' | ThinkingLevel

export interface ChatRequest {
  type: 'chat'
  content: string
  model?: string
  /** A Pi thinking level; `off` is represented by thinking_enabled instead. */
  reasoning_effort?: ThinkingLevel
  /** Whether the selected reasoning-capable model should emit thinking. */
  thinking_enabled?: boolean
  branchId?: string
  editMessageId?: string
  context?: {
    paperId?: string
    pageNumber: number
    selectedText: string
    temporaryPdf?: boolean
    documentTitle?: string
    currentResource?: CurrentChatResource
  }
}

export type ChatEvent =
  | { type: 'assistant_message_start'; messageId: string; runGroupId: string; source: 'user' | 'extension' | 'continuation'; conversationId: string; branchId: string }
  | { type: 'text'; content: string; conversationId?: string; branchId?: string; assistantMessageId?: string; runGroupId?: string }
  | { type: 'thinking'; content: string; conversationId?: string; branchId?: string; assistantMessageId?: string; runGroupId?: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: string; conversationId?: string; branchId?: string; assistantMessageId?: string; runGroupId?: string }
  | { type: 'tool_call_delta'; toolCallId: string; toolName?: string; inputDelta: string; conversationId?: string; branchId?: string; assistantMessageId?: string; runGroupId?: string }
  | { type: 'tool_result'; toolCallId: string; result: string; conversationId?: string; branchId?: string; assistantMessageId?: string; runGroupId?: string }
  | {
      type: 'search_results'
      conversationId?: string
      branchId?: string
      toolCallId?: string
      query: string
      source: 'local' | 'ieee' | 'semantic_scholar'
      field?: string
      page?: number
      limit?: number
      total: number
      totalPages?: number
      hasNextPage?: boolean
      nextPage?: number | null
      papers: Array<Record<string, unknown>>
      earlyAccess?: boolean
      publication?: string
    }
  | { type: 'citation'; pageNumber: number; text: string; conversationId?: string; branchId?: string }
  | { type: 'session_state'; model: string; thinkingLevel: string; models: Array<{ id: string; name?: string; reasoning?: boolean }>; conversationId?: string; branchId?: string }
  | { type: 'context_usage'; tokens: number | null; contextWindow: number; percent: number | null; model?: string; conversationId?: string; branchId?: string }
  | { type: 'compaction_start'; conversationId?: string; branchId?: string }
  | { type: 'compaction_complete'; summary: string; tokensBefore: number; estimatedTokensAfter?: number; conversationId?: string; branchId?: string }
  | { type: 'branch_summary'; summary: string; entryId?: string; targetId?: string; sourceLeafId?: string; label?: string; conversationId?: string; branchId?: string }
  | { type: 'runtime_state'; conversationId: string; branchId: string; state: 'starting' | 'idle' | 'running' | 'reloading' | 'failed'; commands?: PiExtensionCommandInfo[]; generation?: number; error?: string }
  | { type: 'runtime_branch_changed'; conversationId: string; previousConversationId?: string; previousBranchId: string; branchId: string; sessionFile?: string; leafEntryId?: string | null }
  | AgentInteractionRequest
  | AgentInteractionResolved
  | { type: 'pi_user_entry'; conversationId: string; messageId: string; entryId: string; sessionFile: string }
  | { type: 'pi_assistant_entry'; conversationId: string; messageId: string; entryId: string; sessionFile: string }
  | { type: 'done' }
  | { type: 'error'; message: string; conversationId?: string; branchId?: string; assistantMessageId?: string; runGroupId?: string }
  // UI Context bridge events (from Pi extensions via ctx.ui.*)
  | { type: 'agent_ui_status'; key: string; text?: string; conversationId: string; branchId: string; streamMessageId?: string }
  | { type: 'agent_ui_widget'; key: string; lines?: string[]; surfaceId?: string; placement: 'aboveEditor' | 'belowEditor'; conversationId: string; branchId: string }
  | { type: 'agent_ui_footer'; text?: string; surfaceId?: string; conversationId: string; branchId: string }
  | { type: 'agent_ui_header'; lines?: string[]; surfaceId?: string; conversationId: string; branchId: string }
  | { type: 'agent_ui_title'; title: string; conversationId: string; branchId: string }
  | { type: 'agent_ui_editor_set_text'; text: string; revision: number; selectionStart?: number; selectionEnd?: number; conversationId: string; branchId: string }
  | { type: 'agent_ui_editor_paste'; text: string; revision: number; selectionStart: number; selectionEnd: number; conversationId: string; branchId: string }
  | { type: 'agent_ui_editor_submit'; text: string; conversationId: string; branchId: string }
  | { type: 'agent_ui_tools_expanded'; expanded: boolean; conversationId: string; branchId: string }
  | { type: 'agent_ui_theme_request'; theme: string; conversationId: string; branchId: string }
  | { type: 'agent_ui_working'; message?: string; visible?: boolean; indicator?: { frames?: string[]; intervalMs?: number }; hiddenThinkingLabel?: string; reset?: boolean; conversationId: string; branchId: string }
  | { type: 'agent_ui_tui_open'; surface: PiTuiSurfaceState }
  | { type: 'agent_ui_tui_output'; surfaceId: string; conversationId: string; branchId: string; revision: number; ansi: string; plainText: string; hidden?: boolean }
  | { type: 'agent_ui_tui_close'; surfaceId: string; conversationId: string; branchId: string; reason: 'done' | 'cancelled' | 'timeout' | 'reload' | 'disposed' | 'error' }

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string
  paperId: string
  title: string
  snippet: string
  similarity: number
  pageNumber: number | null
}

export type PaperSource = 'local' | 'ieee' | 'semantic_scholar'

export type IeeeSearchMode = 'search' | 'current_issue' | 'early_access' | 'article_abstract'
export type IeeeBrowseMode = 'current_issue' | 'early_access'
export type IeeeSearchSort = 'relevance' | 'newest'

export interface IeeeJournalConfig {
  id: string
  displayName: string
  publicationTitle: string
  publicationNumber: string
}

export interface IeeeJournalBrowserPreferences {
  journals: IeeeJournalConfig[]
  defaultRankingKeywords: string
}

export interface IeeeSearchRequest {
  mode: IeeeSearchMode
  q?: string
  journal?: IeeeJournalConfig
  sort?: IeeeSearchSort
  page?: number
  limit?: number
  refresh?: boolean
  articleNumber?: string
}

export interface IeeeSearchContext {
  mode: IeeeSearchMode
  journal?: IeeeJournalConfig
  sourceUrl?: string
  fetchedAt?: string
  cached?: boolean
}

export interface IeeeSearchResponse {
  papers: SearchPaper[]
  total: number
  page: number
  limit: number
  error?: string
  ieee?: IeeeSearchContext
}

export interface SearchPaper {
  id: string
  /** Semantic Scholar paperId when the source provides one. */
  paperId?: string | null
  title: string
  abstract?: string | null
  authors: string[]
  year?: number | null
  url?: string | null
  pdfUrl?: string | null
  doi?: string | null
  arxivId?: string | null
  journal?: string | null
  venue?: string | null
  source: PaperSource
  rankings?: PaperRanking
  citationCount?: number | null
  referenceCount?: number | null
  publicationDate?: string | null
  publicationTypes?: string[]
  fieldsOfStudy?: string[]
  openAccessPdf?: { url?: string; status?: string } | null
  tldr?: string | null
  articleNumber?: string | null
  publicationNumber?: string | null
  contentType?: string | null
  provider?: string | null
  isEarlyAccess?: boolean
  similarity?: number
  pageNumber?: number | null
  [key: string]: unknown
}

export interface PaperReferenceInput {
  key?: string
  title?: string
  authors?: string[]
  year?: number | null
  localPaperId?: string
  doi?: string
  arxivId?: string
  semanticScholarId?: string
  ieeeArticleNumber?: string
  url?: string
  rawText?: string
}

export type PaperReferenceMatchType = 'local' | 'doi' | 'arxiv' | 'semantic_scholar' | 'ieee' | 'title'
export type PaperReferenceConfidence = 'exact' | 'high' | 'medium'

export interface PaperReferenceResolution {
  key?: string
  status: 'resolved' | 'ambiguous' | 'not_found' | 'error'
  matchedBy?: PaperReferenceMatchType
  confidence?: PaperReferenceConfidence
  localPaper?: SearchPaper | null
  paper?: SearchPaper | null
  candidates?: SearchPaper[]
  original: PaperReferenceInput
  error?: string
}

// ── File ─────────────────────────────────────────────────────────────────────

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  size?: number
  modified?: string
  extension?: string
  mime?: string
  editable?: boolean
  office?: boolean
  legacyOffice?: boolean
  readonly?: boolean
}

// ── WebDAV Sync ──────────────────────────────────────────────────────────────

export type WebDavSyncDirection = 'upload' | 'download' | 'bidirectional'
export type WebDavSyncTrigger = 'manual' | 'schedule' | 'local-change'
export type WebDavSyncPhase = 'disabled' | 'paused' | 'idle' | 'pending' | 'testing' | 'syncing' | 'success' | 'error'

export interface WebDavSyncConfig {
  enabled: boolean
  paused: boolean
  url: string
  username: string
  remotePath: string
  direction: WebDavSyncDirection
  syncAll: boolean
  selectedPaths: string[]
  excludePatterns: string[]
  scheduleEnabled: boolean
  intervalMinutes: number
  syncOnLocalChange: boolean
  propagateLocalDeletions: boolean
  localChangeDebounceSeconds: number
  timeoutSeconds: number
}

export interface WebDavSyncTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: string
  children?: WebDavSyncTreeNode[]
}

export interface WebDavSyncErrorItem {
  path: string
  action: 'upload' | 'download' | 'delete' | 'conflict' | 'scan'
  message: string
}

export interface WebDavSyncResult {
  trigger: WebDavSyncTrigger
  startedAt: string
  finishedAt: string
  uploaded: number
  downloaded: number
  deleted: number
  skipped: number
  conflicts: number
  failed: number
  errors: WebDavSyncErrorItem[]
}

export interface WebDavSyncStatus {
  enabled: boolean
  scheduled: boolean
  watchingLocalChanges: boolean
  phase: WebDavSyncPhase
  running: boolean
  message: string
  currentPath: string | null
  processed: number
  total: number
  lastSyncAt: string | null
  lastSuccessAt: string | null
  nextSyncAt: string | null
  pendingLocalChanges: number
  pendingSyncAt: string | null
  lastError: string | null
  lastResult: WebDavSyncResult | null
}
