// Shared contract between the Electron main process, preload bridge, and renderer.
// Type-only imports from pi are erased at compile time, so the renderer bundle
// never pulls in node code.
import type {
  AgentEvent as CoreAgentEvent,
  SessionCompactEvent,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";

/** Clone-safe harness events consumed by the renderer. */
export type AgentEvent = CoreAgentEvent | SessionCompactEvent;
export type { ThinkingLevel };

/**
 * A harness event tagged with the chat that produced it.
 *
 * A chat keeps streaming after the user switches away, and its events can still
 * be in flight over IPC when the new chat's transcript arrives. The renderer
 * drops anything that is not tagged with the chat currently on screen.
 */
export interface AgentEventEnvelope {
  event: AgentEvent;
  sessionPath: string;
}

/** How shell commands are gated before they run. */
export type ApprovalMode = "ask" | "auto";

/**
 * Per-chat settings, stored in the chat's own transcript.
 *
 * `workspace` is fixed when the chat is created and never changes afterwards, so
 * a chat's transcript always matches the folder it ran in.
 */
export interface SessionSettings {
  workspace: string;
  approvalMode: ApprovalMode;
}

/** Ponytail (lazy senior dev) intensity, embedded in the system prompt. */
export type PonytailMode = "off" | "lite" | "full" | "ultra";

/** App-wide settings, including the starting point for each new chat. */
export interface BehaviorSettings {
  /** Parent folder for named projects. */
  projectsRoot: string;
  defaultApprovalMode: ApprovalMode;
  thinkingLevel: ThinkingLevel;
  sendOnEnter: boolean;
  autoExpandThinking: boolean;
  showTokenUsage: boolean;
  /** Summarize old history automatically before the model context fills up. */
  autoCompact: boolean;
  /** Lazy senior dev mode: pushes the agent toward the smallest working solution. */
  ponytailMode: PonytailMode;
}

/** How a new chat's workspace is chosen. */
export type NewChatInput =
  | { kind: "project"; name: string }
  | { kind: "folder"; path: string };

export interface ProjectNameCheck {
  valid: boolean;
  /** Where the project would be created, for preview. */
  path: string;
  error?: string;
}

/** A model the user has explicitly added. The picker only ever shows these. */
export interface ConfiguredModel {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  isCustom: boolean;
  reasoning: boolean;
  contextWindow: number;
  thinkingLevels: ThinkingLevel[];
  hasKey: boolean;
  /** Present only for custom Responses-format providers. */
  webSocket?: WebSocketStatusInfo;
  /** Editable endpoint details, present only for custom providers. */
  custom?: {
    baseUrl: string;
    api: CustomProviderInput["api"];
    maxTokens: number;
  };
}

/** Full edit of a custom model and the provider it belongs to. */
export interface CustomModelEdit {
  providerId: string;
  /** Model id before the edit — it may be renamed. */
  originalModelId: string;
  name: string;
  baseUrl: string;
  api: CustomProviderInput["api"];
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  useWebSocket?: boolean;
  /** Blank leaves the stored key untouched. */
  apiKey?: string;
}

/** A provider offered in the add-model flow. */
export interface ProviderOption {
  id: string;
  name: string;
  /** Environment variable checked automatically when no key is stored. */
  envHint?: string;
  hasKey: boolean;
  isCustom: boolean;
  /** Short description shown on the provider card. */
  blurb?: string;
}

/** One model from a provider's catalog, shown when picking a model to add. */
export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  inputCost: number;
  outputCost: number;
  alreadyAdded: boolean;
}

export interface SessionSummary {
  path: string;
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** Loose view of a pi AgentMessage — enough for rendering, no pi runtime types. */
export interface ChatBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content: string | ChatBlock[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: { input: number; output: number; cost?: { total: number } };
  /** Session-tree entry backing this rendered message. Present after persistence. */
  entryId?: string;
  /** Alternate user-message branches that share the same parent entry. */
  branch?: {
    index: number;
    count: number;
    targets: string[];
  };
  [key: string]: unknown;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  addedLines?: number;
  removedLines?: number;
}

export interface TurnChangesNotice {
  /** User message entry that started this turn. */
  turnId: string;
  /** Final assistant entry after which the card is rendered. */
  afterEntryId: string;
  files: FileChange[];
  canUndo: boolean;
  undone: boolean;
}

export interface CompactionNotice {
  id: string;
  /** Number of persisted messages preceding this marker in the transcript. */
  afterMessageCount: number;
  timestamp: string;
  summary: string;
  tokensBefore: number;
}

/** A turn that failed for a transient reason and is being sent again. */
export interface RetryStatus {
  /** Which retry this is, counting from 1. */
  attempt: number;
  maxAttempts: number;
  /** Wait before this attempt starts. */
  delayMs: number;
  /** The failure that triggered the retry. */
  errorMessage: string;
}

export interface ContextUsage {
  /** Estimated tokens that will be sent on the next model request. */
  tokens: number;
  contextWindow: number;
  /** Threshold at which pi's default compaction policy activates. */
  compactAt: number;
  /** Whether there is enough old history for a useful manual compaction. */
  canCompact: boolean;
}

/** Everything the renderer needs to draw the app, refreshed after any mutation. */
export interface AppState {
  behavior: BehaviorSettings;
  /** Settings for the chat currently open, or null when no chat exists yet. */
  session: SessionSettings | null;
  models: ConfiguredModel[];
  activeModelKey: string | null;
  sessions: SessionSummary[];
  activeSessionPath: string | null;
  messages: ChatMessage[];
  compactions: CompactionNotice[];
  turnChanges: TurnChangesNotice[];
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: QuestionRequest[];
  isStreaming: boolean;
  isCompacting: boolean;
  /** Set while the open chat's turn is being retried after a transient failure. */
  retry: RetryStatus | null;
  contextUsage: ContextUsage;
  stats: { tokens: number; cost: number };
  appVersion: string;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  command: string;
  /** Chat the approval belongs to, so a stale banner never blocks another chat. */
  sessionPath: string;
}

/** One choice offered by the ask_question tool. */
export interface QuestionOption {
  label: string;
  /** What picking this means — shown under the label. */
  description: string;
}

export interface QuestionItem {
  question: string;
  /** Short label for the question, shown as a chip. */
  header: string;
  /** Whether more than one option can be picked. */
  multiSelect: boolean;
  options: QuestionOption[];
}

/** A blocked ask_question call waiting for the user to answer. */
export interface QuestionRequest {
  questionId: string;
  toolCallId: string;
  questions: QuestionItem[];
  /** Chat the question belongs to, so it never surfaces in another one. */
  sessionPath: string;
}

/** What the user picked for one question. Free text arrives here too. */
export interface QuestionAnswer {
  header: string;
  question: string;
  /** Chosen option labels, or the typed text when the user answered "Other". */
  selected: string[];
}

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages";
  apiKey: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Responses format only: stream over a websocket, falling back to SSE. */
  useWebSocket?: boolean;
}

/** Live websocket state for a custom provider, reset every app launch. */
export interface WebSocketStatusInfo {
  providerId: string;
  enabled: boolean;
  supported: boolean;
  consecutiveFailures: number;
  failureLimit: number;
  lastError?: string;
}

export const CH_AGENT_EVENT = "pi:agent-event";
export const CH_APPROVAL_REQUEST = "pi:approval-request";
export const CH_QUESTION_REQUEST = "pi:question-request";
export const CH_STATE = "pi:state";

/** API exposed by the preload bridge as `window.pi`. */
export interface PiBridge {
  platform: string;
  getState(): Promise<AppState>;

  // chat
  prompt(text: string): Promise<{ steered: boolean }>;
  editMessage(entryId: string, text: string): Promise<AppState>;
  switchBranch(targetId: string): Promise<AppState>;
  undoLatestChanges(turnId: string): Promise<AppState>;
  abort(): Promise<AppState>;
  compact(): Promise<AppState>;

  // sessions
  newSession(input: NewChatInput): Promise<AppState>;
  checkProjectName(name: string): Promise<ProjectNameCheck>;
  /** Native folder picker. Returns null if the user cancelled. */
  chooseDirectory(): Promise<string | null>;
  openSession(path: string): Promise<AppState>;
  renameSession(path: string, title: string): Promise<AppState>;
  deleteSession(path: string): Promise<AppState>;

  // models
  setActiveModel(key: string): Promise<AppState>;
  removeModel(key: string): Promise<AppState>;
  setProviderWebSocket(providerId: string, enabled: boolean): Promise<AppState>;
  updateCustomModel(edit: CustomModelEdit): Promise<AppState>;
  clearProviderKey(providerId: string): Promise<AppState>;
  listProviders(): Promise<ProviderOption[]>;
  saveProviderKey(providerId: string, apiKey: string): Promise<ProviderOption[]>;
  listCatalog(providerId: string): Promise<CatalogModel[]>;
  addModel(providerId: string, modelId: string): Promise<AppState>;
  addCustomModel(input: CustomProviderInput): Promise<AppState>;

  // settings
  updateBehavior(patch: Partial<BehaviorSettings>): Promise<AppState>;
  /** The open chat's approval policy. Its workspace is fixed at creation. */
  setApprovalMode(mode: ApprovalMode): Promise<AppState>;
  chooseProjectsRoot(): Promise<AppState>;

  // approvals
  respondApproval(approvalId: string, allow: boolean, always: boolean): Promise<void>;
  /** Answer an ask_question call. Empty answers cancel it. */
  respondQuestion(questionId: string, answers: QuestionAnswer[]): Promise<void>;

  // subscriptions
  onAgentEvent(listener: (event: AgentEvent, sessionPath: string) => void): () => void;
  onApprovalRequest(listener: (request: ApprovalRequest) => void): () => void;
  onQuestionRequest(listener: (request: QuestionRequest) => void): () => void;
  onState(listener: (state: AppState) => void): () => void;
}
