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

export interface Task {
  id: string
  paperId: string
  type: 'parse_pdf' | 'generate_embedding' | 'summarize' | 'enrich_metadata'
  status: 'pending' | 'active' | 'completed' | 'failed'
  progress: number
  result: Record<string, unknown> | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

// ── WebSocket Chat Protocol ──────────────────────────────────────────────────

export type AgentInteractionKind =
  | 'confirm'
  | 'select'
  | 'input'
  | 'questionnaire'
  | 'notification'

export interface AgentInteractionRequest {
  type: 'agent_interaction_request'
  requestId: string
  conversationId: string
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
}

export interface AgentInteractionResolved {
  type: 'agent_interaction_resolved'
  requestId: string
  action: 'submit' | 'cancel' | 'chat'
  reason?: string
}

export interface ChatRequest {
  type: 'chat'
  content: string
  model?: string
  reasoning_effort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  branchId?: string
  editMessageId?: string
  context?: {
    paperId: string
    pageNumber: number
    selectedText: string
  }
}

export type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: string }
  | { type: 'tool_result'; toolCallId: string; result: string }
  | {
      type: 'search_results'
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
  | { type: 'citation'; pageNumber: number; text: string }
  | { type: 'session_state'; model: string; thinkingLevel: string; models: Array<{ id: string; name?: string; reasoning?: boolean }> }
  | { type: 'context_usage'; tokens: number | null; contextWindow: number; percent: number | null; model?: string }
  | AgentInteractionRequest
  | AgentInteractionResolved
  | { type: 'pi_user_entry'; conversationId: string; messageId: string; entryId: string; sessionFile: string }
  | { type: 'pi_assistant_entry'; conversationId: string; messageId: string; entryId: string; sessionFile: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  // UI Context bridge events (from Pi extensions via ctx.ui.*)
  | { type: 'agent_ui_status'; key: string; text: string; conversationId?: string; streamMessageId?: string }
  | { type: 'agent_ui_widget'; key: string; lines: string[]; placement: 'above' | 'below'; conversationId?: string }
  | { type: 'agent_ui_footer'; text: string; conversationId?: string }
  | { type: 'agent_ui_header'; lines: string[]; conversationId?: string }
  | { type: 'agent_ui_title'; title: string; conversationId?: string }
  | { type: 'agent_ui_editor_set_text'; text: string; conversationId?: string }
  | { type: 'agent_ui_editor_paste'; text: string; conversationId?: string }
  | { type: 'agent_ui_tools_expanded'; expanded: boolean; conversationId?: string }
  | { type: 'agent_ui_theme_request'; theme: string; conversationId?: string }

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

export interface SearchPaper {
  id: string
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
