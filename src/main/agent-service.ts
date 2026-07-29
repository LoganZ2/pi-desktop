import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type AgentHarnessEvent,
  type AgentHarnessTool,
  type ExecutionToolContext,
  type JsonlSessionMetadata,
  type Session,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  clampThinkingLevel,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  AppState,
  ApprovalMode,
  ApprovalRequest,
  BehaviorSettings,
  ChatMessage,
  CompactionNotice,
  ContextUsage,
  CustomModelEdit,
  CustomProviderInput,
  FileChange,
  NewChatInput,
  ProjectNameCheck,
  ProviderOption,
  QuestionAnswer,
  QuestionItem,
  QuestionRequest,
  RetryStatus,
  SessionSettings,
  ThinkingLevel,
  TurnChangesNotice,
} from "../shared/ipc.js";
import type { EncryptedCredentialStore } from "./credentials.js";
import { maybeRegisterFauxDemo } from "./faux-demo.js";
import { ModelRegistry, modelKey } from "./model-registry.js";
import { checkProjectName, createProject } from "./projects.js";
import { loadAgentsInstructions } from "./agents-md.js";
import type { ConfigStore } from "./config-store.js";
import type { ModelStore } from "./model-store.js";
import {
  getPonytailInstructions,
  isPonytailDeactivationCommand,
  normalizePonytailMode,
} from "./ponytail.js";
import { createAskQuestionTool } from "./ask-question.js";
import { createWebFetchTool } from "./web-fetch.js";
import { SessionManager, titleFromPrompt } from "./session-manager.js";
import { TurnCheckpoint, type FinishedTurnCheckpoint } from "./turn-checkpoint.js";

type Tools = AgentHarnessTool<ExecutionToolContext>[];

/** One-line, human-readable description of a fetch call for the approval prompt. */
function describeFetch(input: unknown): string {
  const args = (input ?? {}) as { method?: string; url?: string };
  if (typeof args.url !== "string") return JSON.stringify(input ?? {});
  const method = (args.method ?? "GET").toUpperCase();
  return method === "GET" ? args.url : `${method} ${args.url}`;
}

const TURN_CHANGES_ENTRY = "pi-desktop:turn-changes";
const FILE_UNDO_MESSAGE = "pi-desktop:file-undo";

/** Transient model failures are re-sent this many times before giving up. */
const MAX_TURN_RETRIES = 5;
/** First backoff step. Every further retry doubles it, up to the cap. */
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;

interface StoredTurnChanges {
  turnId: string;
  afterEntryId: string;
  files: FileChange[];
}

interface LatestTurnCheckpoint {
  turnId: string;
  checkpoint: FinishedTurnCheckpoint;
}

interface BackgroundSession {
  session: Session<JsonlSessionMetadata>;
  harness: AgentHarness<ExecutionToolContext>;
  settings: SessionSettings;
  env: NodeExecutionEnv;
  streaming: boolean;
}

export class AgentService {
  private readonly registry: ModelRegistry;
  private readonly sessions: SessionManager;
  private env: NodeExecutionEnv;
  private harness: AgentHarness<ExecutionToolContext> | null = null;
  private session: Session<JsonlSessionMetadata> | null = null;
  private messages: ChatMessage[] = [];
  private compactions: CompactionNotice[] = [];
  private turnChanges: TurnChangesNotice[] = [];
  private pendingApprovals = new Map<
    string,
    { resolve: (allow: boolean) => void; request: ApprovalRequest; sessionPath: string }
  >();
  private pendingQuestions = new Map<
    string,
    { resolve: (answers: QuestionAnswer[]) => void; request: QuestionRequest; sessionPath: string }
  >();
  private streaming = false;
  private compacting = false;
  private compactionPromise: Promise<void> | null = null;
  private readonly afterRunPromises = new Map<string, Promise<void>>();
  private readonly turnCheckpoints = new Map<string, TurnCheckpoint>();
  private readonly backgroundSessions = new Map<string, BackgroundSession>();
  private readonly latestCheckpoints = new Map<string, LatestTurnCheckpoint>();
  /** Retry in progress per chat, from the failure until the turn settles. */
  private readonly retries = new Map<string, RetryStatus>();
  /** Cancels the backoff wait when the user stops or sends something new. */
  private readonly retryWaits = new Map<string, AbortController>();
  /**
   * Chats whose current turn can no longer be re-sent as-is: a tool has already
   * run, or the user steered mid-turn. Retrying those would repeat side effects
   * or drop the steer, so a failure there is final.
   */
  private readonly unrepeatableTurns = new Set<string>();
  private stats = { tokens: 0, cost: 0 };
  private contextUsage: ContextUsage = {
    tokens: 0,
    contextWindow: 0,
    compactAt: 0,
    canCompact: false,
  };
  private activeKey: string | null;
  /** Faux demo selections stay in memory so they never pollute saved settings. */
  private persistActiveKey = true;
  /** Workspace and approval policy for the chat that is currently open. */
  private sessionSettings: SessionSettings | null = null;
  /** Per-chat override set by "stop ponytail" / "normal mode"; null = follow behavior setting. */
  private ponytailSessionOff = new Set<string>();
  /** AGENTS.md chain for the current workspace, loaded once when the chat opens. */
  private agentsInstructions: string | null = null;

  onEvent?: (event: AgentHarnessEvent, sessionPath: string) => void;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onQuestionRequest?: (request: QuestionRequest) => void;
  onStateChange?: () => void;

  constructor(
    private readonly config: ConfigStore,
    private readonly modelStore: ModelStore,
    credentials: EncryptedCredentialStore,
    private readonly appVersion: string,
  ) {
    this.env = new NodeExecutionEnv({ cwd: config.behavior.projectsRoot });
    this.registry = new ModelRegistry(modelStore, credentials);
    this.sessions = new SessionManager();
    this.activeKey = modelStore.activeModelKey;

    const faux = maybeRegisterFauxDemo(this.registry.models);
    if (faux) {
      this.registry.addEphemeralModel(faux.provider, faux.id);
      this.activeKey = modelKey(faux.provider, faux.id);
      this.persistActiveKey = false;
    }
  }

  /** Point the tools at this chat's folder. */
  private useWorkspace(workspace: string, preserveCurrent = false): void {
    if (this.env.cwd === workspace && !preserveCurrent) return;
    if (!preserveCurrent) void this.env.cleanup();
    this.env = new NodeExecutionEnv({ cwd: workspace });
    this.agentsInstructions = loadAgentsInstructions(workspace);
  }

  private setActiveKey(key: string | null): void {
    this.activeKey = key;
    if (this.persistActiveKey) this.modelStore.activeModelKey = key;
  }

  // ---------- lifecycle ----------

  async init(): Promise<void> {
    // A saved model can disappear (removed provider, cleared settings). Fall
    // back rather than leaving the app wedged with no usable harness.
    if (!this.registry.resolve(this.activeKey)) {
      const available = await this.registry.listConfiguredModels();
      this.setActiveKey(available[0]?.key ?? null);
    }
    await this.sessions.refreshIndex();
    const previous = this.config.activeSessionPath;
    const known = this.sessions.list();
    if (previous && known.some((s) => s.path === previous)) {
      await this.openSession(previous);
    } else if (known[0]) {
      await this.openSession(known[0].path);
    }
    // With no chats yet the app opens empty and prompts to create one, since a
    // chat cannot exist without a workspace the user picked.
  }

  private ponytailEnabled(): boolean {
    if (normalizePonytailMode(this.config.behavior.ponytailMode) === "off") return false;
    const sessionPath = this.config.activeSessionPath;
    return !sessionPath || !this.ponytailSessionOff.has(sessionPath);
  }

  private systemPrompt(): string {
    const workspace = this.sessionSettings?.workspace ?? this.config.behavior.projectsRoot;
    const parts = [
      "You are pi desktop, a coding agent running inside a desktop app, built on the pi agent framework.",
      "You help with software engineering tasks: reading and writing code, running shell commands, and explaining what you find.",
      "",
      `Working directory: ${workspace}`,
      `Platform: ${process.platform} (${os.release()}), Node ${process.versions.node}`,
      `Today's date: ${new Date().toDateString()}`,
      "",
      "Rules:",
      "- Prefer the read/edit/write tools for file operations; use bash for everything else.",
      "- To fetch a URL, use the web_fetch tool rather than curl or wget in bash.",
      "- Relative paths resolve against the working directory.",
      "- Keep answers concise. Use markdown code blocks for code.",
      "- When a decision is genuinely the user's — one you cannot settle from the request, the code, or a sensible default — put it to them with the ask_question tool instead of guessing. Make routine calls yourself.",
      "- Never run destructive commands unless the user explicitly asks.",
    ];
    if (this.agentsInstructions) {
      parts.push("", this.agentsInstructions);
    }
    if (this.ponytailEnabled()) {
      parts.push(
        "",
        getPonytailInstructions(normalizePonytailMode(this.config.behavior.ponytailMode)),
      );
    }
    return parts.join("\n");
  }

  private buildTools(sessionPath: string): Tools {
    return [
      createReadTool(),
      createBashTool(),
      createEditTool(),
      createWriteTool(),
      createWebFetchTool(),
      createAskQuestionTool((toolCallId, questions, signal) =>
        this.requestQuestion(toolCallId, questions, sessionPath, signal),
      ),
    ] as unknown as Tools;
  }

  private createHarness(
    session: Session<JsonlSessionMetadata>,
    sessionPath: string,
  ): AgentHarness<ExecutionToolContext> | null {
    const model = this.registry.resolve(this.activeKey);
    if (!model) return null;

    const harnessEnv = this.env;
    const harness = new AgentHarness<ExecutionToolContext>({
      session,
      models: this.registry.models,
      model,
      thinkingLevel: clampThinkingLevel(model, this.config.behavior.thinkingLevel),
      tools: this.buildTools(sessionPath),
      toolContext: () => ({ env: harnessEnv }),
      systemPrompt: () => this.systemPrompt(),
      // pi applies this to the model calls it makes on its own — compaction and
      // branch summaries. Turns are retried by runTurn instead, since only the
      // app knows whether re-sending one would repeat work the tools already did.
      retry: {
        enabled: true,
        maxRetries: MAX_TURN_RETRIES,
        baseDelayMs: RETRY_BASE_DELAY_MS,
      },
    });

    harness.subscribe((event) => {
      this.handleEvent(event, sessionPath, session, harness);
    });
    harness.on("tool_call", async (event) => {
      if (
        (event.toolName === "edit" || event.toolName === "write") &&
        typeof event.input?.path === "string"
      ) {
        await this.turnCheckpoints.get(sessionPath)?.captureToolPath(event.input.path);
      }

      const settings =
        this.config.activeSessionPath === sessionPath
          ? this.sessionSettings
          : this.backgroundSessions.get(sessionPath)?.settings;
      const needsApproval = event.toolName === "bash" || event.toolName === "web_fetch";
      if (!needsApproval || settings?.approvalMode === "auto") return;
      const command =
        event.toolName === "web_fetch"
          ? describeFetch(event.input)
          : typeof event.input?.command === "string"
            ? event.input.command
            : JSON.stringify(event.input ?? {});
      const allowed = await this.requestApproval(
        event.toolCallId,
        event.toolName,
        command,
        sessionPath,
      );
      return allowed
        ? undefined
        : { block: true, reason: "The user denied this command in the approval prompt." };
    });
    return harness;
  }

  private handleEvent(
    event: AgentHarnessEvent,
    sessionPath: string,
    session: Session<JsonlSessionMetadata>,
    harness: AgentHarness<ExecutionToolContext>,
  ): void {
    const isActive = this.config.activeSessionPath === sessionPath && this.harness === harness;
    const background = this.backgroundSessions.get(sessionPath);

    switch (event.type) {
      case "agent_start":
        if (isActive) this.streaming = true;
        else if (background) background.streaming = true;
        break;
      case "agent_end": {
        if (isActive) this.streaming = false;
        else if (background) background.streaming = false;
        const checkpoint = this.turnCheckpoints.get(sessionPath) ?? null;
        this.turnCheckpoints.delete(sessionPath);
        const promise = this.afterRun(sessionPath, session, harness, checkpoint);
        this.afterRunPromises.set(sessionPath, promise);
        void promise
          .catch((error) => console.warn("Could not finalize agent run:", error))
          .finally(() => {
            if (this.afterRunPromises.get(sessionPath) === promise) {
              this.afterRunPromises.delete(sessionPath);
            }
          });
        break;
      }
      case "message_end": {
        if (isActive) {
          const message = event.message as ChatMessage;
          this.messages = [...this.messages, message];
        }
        break;
      }
      case "tool_execution_start":
        // Tracked for every chat, background ones included: a turn that reached
        // a tool has changed something outside the transcript.
        this.unrepeatableTurns.add(sessionPath);
        break;
      case "session_compact":
        if (isActive) {
          this.compactions = [
            ...this.compactions.filter((notice) => notice.id !== event.compactionEntry.id),
            {
              id: event.compactionEntry.id,
              afterMessageCount: this.messages.length,
              timestamp: event.compactionEntry.timestamp,
              summary: event.compactionEntry.summary,
              tokensBefore: event.compactionEntry.tokensBefore,
            },
          ];
        }
        break;
      default:
        break;
    }
    if (isActive) this.onEvent?.(event, sessionPath);
  }

  private async afterRun(
    sessionPath: string,
    session: Session<JsonlSessionMetadata>,
    harness: AgentHarness<ExecutionToolContext>,
    checkpoint: TurnCheckpoint | null,
  ): Promise<void> {
    if (checkpoint) {
      try {
        const finished = await checkpoint.finish();
        const entries = await session.getEntries();
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const branch: SessionTreeEntry[] = [];
        let cursor = byId.get((await session.getLeafId()) ?? "");
        while (cursor) {
          branch.unshift(cursor);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        const latestUser = [...branch]
          .reverse()
          .find(
            (entry) =>
              entry.type === "message" &&
              (entry.message as ChatMessage).role === "user",
          );
        const latestAssistant = [...branch]
          .reverse()
          .find(
            (entry) =>
              entry.type === "message" &&
              (entry.message as ChatMessage).role === "assistant",
          );
        if (
          finished &&
          latestUser?.type === "message" &&
          latestAssistant?.type === "message"
        ) {
          const stored: StoredTurnChanges = {
            turnId: latestUser.id,
            afterEntryId: latestAssistant.id,
            files: finished.files,
          };
          await session.appendCustomEntry(TURN_CHANGES_ENTRY, stored);
          this.latestCheckpoints.set(sessionPath, {
            turnId: latestUser.id,
            checkpoint: finished,
          });
        }
      } catch (error) {
        console.warn("Could not finalize the turn checkpoint:", error);
      }
    }

    const isActive = this.config.activeSessionPath === sessionPath && this.harness === harness;
    if (isActive) {
      await this.loadTranscript(session);
      await this.refreshStats();
      await this.refreshContextUsage();
    }

    const messageCount = (await session.getSessionStats()).messageCount;
    this.sessions.touch(sessionPath, messageCount);

    if (
      isActive &&
      this.config.behavior.autoCompact &&
      this.harness &&
      this.contextUsage.canCompact &&
      shouldCompact(
        this.contextUsage.tokens,
        this.contextUsage.contextWindow,
        DEFAULT_COMPACTION_SETTINGS,
      )
    ) {
      try {
        await this.runCompaction();
      } catch (error) {
        console.warn("Automatic compaction failed:", error);
      }
    }
    this.onStateChange?.();
  }

  private async refreshContextUsage(): Promise<void> {
    if (!this.session || !this.harness) {
      this.contextUsage = { tokens: 0, contextWindow: 0, compactAt: 0, canCompact: false };
      return;
    }
    try {
      const branch = await this.session.getBranch();
      const context = await this.session.buildContext();
      // estimateContextTokens prefers the last assistant message's provider-
      // reported usage, but right after a compaction that usage was measured
      // against the pre-compaction context (the retained tail keeps its old
      // messages). Only trust it once a model call happened on the new branch.
      let usageIsFresh = false;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "compaction") break;
        if (entry.type === "message" && (entry.message as ChatMessage).role === "assistant") {
          usageIsFresh = true;
          break;
        }
      }
      const tokens = usageIsFresh
        ? estimateContextTokens(context.messages).tokens
        : context.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      const contextWindow = this.harness.getModel().contextWindow;
      const preparation = prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS);
      const prepared = preparation.ok ? preparation.value : undefined;
      this.contextUsage = {
        tokens,
        contextWindow,
        compactAt: Math.max(0, contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens),
        canCompact: Boolean(
          prepared &&
            (prepared.messagesToSummarize.length > 0 || prepared.turnPrefixMessages.length > 0),
        ),
      };
    } catch (error) {
      console.warn("Could not calculate context usage:", error);
    }
  }

  private async runCompaction(): Promise<void> {
    if (this.compactionPromise) return this.compactionPromise;
    if (!this.harness || !this.session) throw new Error("No chat is open");
    if (this.streaming) throw new Error("Wait for the agent to finish before compacting");

    const harness = this.harness;
    const session = this.session;
    this.compacting = true;
    this.onStateChange?.();

    const promise = (async () => {
      await harness.compact();
      if (this.session !== session) return;
      await this.loadTranscript(session);
      await this.refreshStats();
      await this.refreshContextUsage();
      const sessionPath = this.config.activeSessionPath;
      if (sessionPath) this.sessions.touch(sessionPath, this.messages.length);
    })();
    this.compactionPromise = promise;
    try {
      await promise;
    } finally {
      if (this.compactionPromise === promise) this.compactionPromise = null;
      this.compacting = false;
      this.onStateChange?.();
    }
  }

  private async refreshStats(): Promise<void> {
    if (!this.session) return;
    try {
      const stats = await this.session.getSessionStats();
      this.stats = { tokens: stats.totalTokens, cost: stats.costTotal };
    } catch {
      // Stats are cosmetic; a read failure should never break the chat.
    }
  }

  // ---------- approvals ----------

  private requestApproval(
    toolCallId: string,
    toolName: string,
    command: string,
    sessionPath: string,
  ): Promise<boolean> {
    const approvalId = randomUUID();
    const request = { approvalId, toolCallId, toolName, command, sessionPath };
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approvalId, { resolve, request, sessionPath });
      if (this.config.activeSessionPath === sessionPath) this.onApprovalRequest?.(request);
    }).finally(() => {
      this.pendingApprovals.delete(approvalId);
    });
  }

  respondApproval(approvalId: string, allow: boolean, always: boolean): void {
    // "Always" applies to this chat only, matching where the setting lives.
    if (always) void this.setApprovalMode("auto");
    this.pendingApprovals.get(approvalId)?.resolve(allow);
  }

  // ---------- questions ----------

  /**
   * Put an ask_question call to the user and wait. Aborting the turn resolves it
   * as unanswered, so a stopped turn never leaves the tool hanging.
   */
  private requestQuestion(
    toolCallId: string,
    questions: QuestionItem[],
    sessionPath: string,
    signal: AbortSignal | undefined,
  ): Promise<QuestionAnswer[]> {
    const questionId = randomUUID();
    const request: QuestionRequest = { questionId, toolCallId, questions, sessionPath };
    return new Promise<QuestionAnswer[]>((resolve) => {
      if (signal?.aborted) {
        resolve([]);
        return;
      }
      const onAbort = () => this.pendingQuestions.get(questionId)?.resolve([]);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingQuestions.set(questionId, {
        resolve: (answers) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answers);
        },
        request,
        sessionPath,
      });
      if (this.config.activeSessionPath === sessionPath) this.onQuestionRequest?.(request);
    }).finally(() => {
      this.pendingQuestions.delete(questionId);
      this.onStateChange?.();
    });
  }

  /** Answer a pending question. An empty list means the user dismissed it. */
  respondQuestion(questionId: string, answers: QuestionAnswer[]): void {
    this.pendingQuestions.get(questionId)?.resolve(answers);
  }

  // ---------- chat ----------

  async prompt(text: string): Promise<{ steered: boolean }> {
    if (!this.harness) throw new Error("Add a model before sending a message");

    const sessionPath = this.config.activeSessionPath;
    if (!sessionPath) throw new Error("No chat is open");
    if (sessionPath && !this.sessions.hasTitle(sessionPath)) {
      await this.sessions.rename(sessionPath, titleFromPrompt(text), this.session ?? undefined);
      this.onStateChange?.();
    }

    // A new message supersedes a retry that has not fired yet. One already in
    // flight is a running turn, so it takes the steering path below instead.
    this.cancelRetry(sessionPath);

    if (this.streaming) {
      this.unrepeatableTurns.add(sessionPath);
      await this.harness.steer(text);
      return { steered: true };
    }
    const pendingRun = sessionPath ? this.afterRunPromises.get(sessionPath) : undefined;
    if (pendingRun) await pendingRun;
    if (this.compactionPromise) await this.compactionPromise;

    if (isPonytailDeactivationCommand(text)) {
      this.ponytailSessionOff.add(sessionPath);
    }

    await this.refreshContextUsage();
    if (
      this.config.behavior.autoCompact &&
      this.contextUsage.canCompact &&
      shouldCompact(
        this.contextUsage.tokens,
        this.contextUsage.contextWindow,
        DEFAULT_COMPACTION_SETTINGS,
      )
    ) {
      await this.runCompaction();
    }

    if (sessionPath) this.latestCheckpoints.delete(sessionPath);
    const workspace = this.sessionSettings?.workspace ?? this.env.cwd;
    this.turnCheckpoints.set(
      sessionPath,
      await TurnCheckpoint.begin(workspace, { env: this.env }),
    );
    this.onStateChange?.();

    // Captured, because the chat can be switched away from while it runs.
    const harness = this.harness;
    const session = this.session;
    const env = this.env;
    void this.runTurn({ harness, session, sessionPath, text, workspace, env });
    return { steered: false };
  }

  /**
   * Run a turn, sending it again when the model request fails for a transient
   * reason — a dropped connection, a rate limit, a provider hiccup — rather than
   * leaving the chat on "Generation failed" after a single attempt.
   *
   * Only a turn that produced nothing is retried. Once a tool has run, the
   * failure stands: re-sending would run that tool a second time, which is not
   * this code's call to make.
   */
  private async runTurn(turn: {
    harness: AgentHarness<ExecutionToolContext>;
    session: Session<JsonlSessionMetadata> | null;
    sessionPath: string;
    text: string;
    workspace: string;
    env: NodeExecutionEnv;
  }): Promise<void> {
    const { harness, session, sessionPath, text, workspace, env } = turn;
    try {
      for (let retry = 0; ; retry++) {
        this.unrepeatableTurns.delete(sessionPath);

        let result: AssistantMessage;
        try {
          result = await harness.prompt(text);
        } catch (error) {
          console.error("prompt failed:", error);
          this.setBusy(sessionPath, false);
          this.onStateChange?.();
          return;
        }

        // "aborted" is the user stopping; a deterministic error (bad key, oversized
        // context) fails the same way however often it is sent.
        if (
          result.stopReason !== "error" ||
          retry >= MAX_TURN_RETRIES ||
          !isRetryableAssistantError(result) ||
          this.unrepeatableTurns.has(sessionPath) ||
          !session
        ) {
          return;
        }

        const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** retry, RETRY_MAX_DELAY_MS);
        this.retries.set(sessionPath, {
          attempt: retry + 1,
          maxAttempts: MAX_TURN_RETRIES,
          delayMs,
          errorMessage: result.errorMessage ?? "The request failed",
        });
        // The failed turn ended, so nothing is streaming. The chat stays marked
        // busy anyway: it is still working on that message, and the composer
        // should not invite another one into the gap.
        this.setBusy(sessionPath, true);
        this.onStateChange?.();

        if (!(await this.waitToRetry(sessionPath, delayMs))) return;
        if (!(await this.rewindFailedTurn(harness, session, sessionPath))) return;
        // The failed attempt is off the branch now. Reload before it streams
        // again, or the transcript would show the old copy of the message
        // alongside the one the retry is about to append.
        if (this.config.activeSessionPath === sessionPath) {
          await this.loadTranscript(session);
          this.onStateChange?.();
        }
        this.turnCheckpoints.set(sessionPath, await TurnCheckpoint.begin(workspace, { env }));
      }
    } finally {
      if (this.retries.delete(sessionPath)) {
        this.setBusy(sessionPath, false);
        this.onStateChange?.();
      }
    }
  }

  /** Mark a chat busy, wherever it currently lives. */
  private setBusy(sessionPath: string, busy: boolean): void {
    if (this.config.activeSessionPath === sessionPath) this.streaming = busy;
    else {
      const background = this.backgroundSessions.get(sessionPath);
      if (background) background.streaming = busy;
    }
  }

  /** Back off before the next attempt. False means the retry was cancelled. */
  private waitToRetry(sessionPath: string, delayMs: number): Promise<boolean> {
    const wait = new AbortController();
    this.retryWaits.set(sessionPath, wait);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      timer = setTimeout(() => {
        wait.signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, delayMs);
      wait.signal.addEventListener("abort", onAbort, { once: true });
    }).finally(() => {
      if (this.retryWaits.get(sessionPath) === wait) this.retryWaits.delete(sessionPath);
    });
  }

  /**
   * Move the leaf off the failed attempt, so the retry re-sends the message as a
   * new branch instead of appending a second copy of it below the failure. The
   * failed attempt stays in the tree, reachable through the branch arrows.
   */
  private async rewindFailedTurn(
    harness: AgentHarness<ExecutionToolContext>,
    session: Session<JsonlSessionMetadata>,
    sessionPath: string,
  ): Promise<boolean> {
    const pendingRun = this.afterRunPromises.get(sessionPath);
    if (pendingRun) await pendingRun.catch(() => undefined);
    try {
      const branch = await session.getBranch();
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" && (entry.message as ChatMessage).role === "user") {
          // Targeting a user entry moves the leaf to its parent, so the retry
          // becomes a sibling of the failed attempt rather than a child.
          await harness.navigateTree(entry.id);
          return true;
        }
      }
    } catch (error) {
      console.warn("Could not rewind the failed turn to retry it:", error);
    }
    return false;
  }

  /** Drop a scheduled retry: the user stopped the turn, or moved on. */
  private cancelRetry(sessionPath: string): void {
    const wait = this.retryWaits.get(sessionPath);
    // Without a pending wait an attempt is in flight, and aborting the turn is
    // the harness's job — clearing the flags here would only lie about it.
    if (!wait) return;
    this.retryWaits.delete(sessionPath);
    this.retries.delete(sessionPath);
    this.setBusy(sessionPath, false);
    wait.abort();
    this.onStateChange?.();
  }

  async editMessage(entryId: string, text: string): Promise<void> {
    if (!this.harness || !this.session) throw new Error("No chat is open");
    if (this.streaming || this.compacting) throw new Error("Wait for the agent to finish first");
    const sessionPath = this.config.activeSessionPath;
    const pendingRun = sessionPath ? this.afterRunPromises.get(sessionPath) : undefined;
    if (pendingRun) await pendingRun;
    await this.harness.navigateTree(entryId);
    await this.loadTranscript(this.session);
    await this.refreshContextUsage();
    await this.prompt(text);
  }

  async switchBranch(targetId: string): Promise<void> {
    if (!this.harness || !this.session) throw new Error("No chat is open");
    if (this.streaming || this.compacting) throw new Error("Wait for the agent to finish first");
    const sessionPath = this.config.activeSessionPath;
    const pendingRun = sessionPath ? this.afterRunPromises.get(sessionPath) : undefined;
    if (pendingRun) await pendingRun;
    await this.harness.navigateTree(targetId);
    await this.loadTranscript(this.session);
    await this.refreshStats();
    await this.refreshContextUsage();
  }

  async undoLatestChanges(turnId: string): Promise<void> {
    if (!this.session) throw new Error("No chat is open");
    if (this.streaming || this.compacting) throw new Error("Wait for the agent to finish first");
    const metadata = await this.session.getMetadata();
    const pendingRun = this.afterRunPromises.get(metadata.path);
    if (pendingRun) await pendingRun;

    const latest = this.latestCheckpoints.get(metadata.path);
    const notice = this.turnChanges.find((change) => change.turnId === turnId);
    if (!latest || latest.turnId !== turnId || !notice?.canUndo) {
      throw new Error("Only the latest turn's changes can be undone");
    }

    await latest.checkpoint.undo();
    const paths = notice.files.map((file) => file.path);
    await this.session.appendCustomMessageEntry(
      FILE_UNDO_MESSAGE,
      [
        "The user reverted all file changes made during the previous assistant turn.",
        paths.length > 0 ? `Restored files: ${paths.join(", ")}.` : "",
        "Do not assume the reverted edits are still present. Inspect the current files before making further changes.",
      ]
        .filter(Boolean)
        .join("\n"),
      false,
      { turnId, files: paths },
    );
    this.latestCheckpoints.delete(metadata.path);
    await this.loadTranscript(this.session);
    await this.refreshContextUsage();
    this.onStateChange?.();
  }

  async compact(): Promise<void> {
    await this.refreshContextUsage();
    if (!this.contextUsage.canCompact) throw new Error("There is not enough old context to compact");
    await this.runCompaction();
  }

  async abort(): Promise<void> {
    const sessionPath = this.config.activeSessionPath;
    if (sessionPath) this.cancelRetry(sessionPath);
    // Released before the harness is asked to stop: aborting waits for the tool
    // to return, and a tool blocked on the user would never get there.
    for (const pending of this.pendingApprovals.values()) {
      if (pending.sessionPath === sessionPath) pending.resolve(false);
    }
    for (const pending of this.pendingQuestions.values()) {
      if (pending.sessionPath === sessionPath) pending.resolve([]);
    }
    if (this.compactionPromise) {
      await this.compactionPromise.catch(() => undefined);
    }
    const pendingBeforeAbort = sessionPath ? this.afterRunPromises.get(sessionPath) : undefined;
    if (pendingBeforeAbort) await pendingBeforeAbort.catch(() => undefined);
    await this.harness?.abort();
    const pendingAfterAbort = sessionPath ? this.afterRunPromises.get(sessionPath) : undefined;
    if (pendingAfterAbort) await pendingAfterAbort.catch(() => undefined);
    this.streaming = false;
  }

  // ---------- sessions ----------

  private async loadTranscript(session: Session<JsonlSessionMetadata>): Promise<void> {
    let entries: SessionTreeEntry[] = [];
    let leafId: string | null = null;
    try {
      entries = await session.getEntries();
      leafId = await session.getLeafId();
    } catch (error) {
      console.warn("Could not read session transcript:", error);
    }

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const entryOrder = new Map(entries.map((entry, index) => [entry.id, index]));
    const activeEntries: SessionTreeEntry[] = [];
    let cursor = leafId ? byId.get(leafId) : undefined;
    while (cursor) {
      activeEntries.unshift(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }

    // Leaf records only persist navigation bookkeeping; they are not branches
    // users can select. Every other entry can be a valid navigateTree target.
    const children = new Map<string | null, SessionTreeEntry[]>();
    for (const entry of entries) {
      if (entry.type === "leaf") continue;
      const siblings = children.get(entry.parentId) ?? [];
      siblings.push(entry);
      children.set(entry.parentId, siblings);
    }
    const deepestTarget = (root: SessionTreeEntry): string => {
      let best = root;
      const stack = [root];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if ((entryOrder.get(current.id) ?? -1) > (entryOrder.get(best.id) ?? -1)) best = current;
        for (const child of children.get(current.id) ?? []) stack.push(child);
      }
      return best.id;
    };

    const messages: ChatMessage[] = [];
    const compactions: CompactionNotice[] = [];
    const storedChanges = new Map<string, StoredTurnChanges>();
    const undoneTurns = new Set<string>();

    for (const entry of activeEntries) {
      if (entry.type === "message") {
        const message: ChatMessage = { ...(entry.message as ChatMessage), entryId: entry.id };
        if (message.role === "user") {
          const variants = (children.get(entry.parentId) ?? []).filter(
            (candidate) =>
              candidate.type === "message" &&
              (candidate.message as ChatMessage).role === "user",
          );
          if (variants.length > 1) {
            message.branch = {
              index: variants.findIndex((candidate) => candidate.id === entry.id),
              count: variants.length,
              targets: variants.map(deepestTarget),
            };
          }
        }
        messages.push(message);
      } else if (entry.type === "compaction") {
        compactions.push({
          id: entry.id,
          afterMessageCount: messages.length,
          timestamp: entry.timestamp,
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
        });
      } else if (entry.type === "custom" && entry.customType === TURN_CHANGES_ENTRY) {
        const data = entry.data as StoredTurnChanges | undefined;
        if (data?.turnId && data.afterEntryId && Array.isArray(data.files)) {
          storedChanges.set(data.turnId, data);
        }
      } else if (entry.type === "custom_message" && entry.customType === FILE_UNDO_MESSAGE) {
        const details = entry.details as { turnId?: string } | undefined;
        if (details?.turnId) undoneTurns.add(details.turnId);
      }
    }

    const metadata = await session.getMetadata();
    const latestCheckpoint = this.latestCheckpoints.get(metadata.path);
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const turnChanges: TurnChangesNotice[] = [...storedChanges.values()].map((change) => {
      const undone = undoneTurns.has(change.turnId);
      return {
        ...change,
        undone,
        canUndo: Boolean(
          !undone &&
            latestUser?.entryId === change.turnId &&
            latestCheckpoint?.turnId === change.turnId,
        ),
      };
    });

    this.messages = messages;
    this.compactions = compactions;
    this.turnChanges = turnChanges;
  }

  checkProjectName(name: string): ProjectNameCheck {
    return checkProjectName(name, this.config.behavior.projectsRoot);
  }

  /**
   * Create a chat. The workspace is chosen here and never changes again, so the
   * transcript always matches the folder the agent ran in.
   */
  async newSession(input: NewChatInput): Promise<void> {
    const workspace =
      input.kind === "project"
        ? createProject(input.name, this.config.behavior.projectsRoot)
        : input.path;

    await this.abort();
    this.sessionSettings = {
      workspace,
      approvalMode: this.config.behavior.defaultApprovalMode,
    };
    this.useWorkspace(workspace);
    this.session = await this.sessions.create(workspace);
    await this.sessions.writeSettings(this.session, this.sessionSettings);
    const sessionPath = (await this.session.getMetadata()).path;
    this.config.activeSessionPath = sessionPath;
    this.messages = [];
    this.compactions = [];
    this.turnChanges = [];
    this.stats = { tokens: 0, cost: 0 };
    this.contextUsage = { tokens: 0, contextWindow: 0, compactAt: 0, canCompact: false };
    this.harness = this.createHarness(this.session, sessionPath);
    await this.refreshContextUsage();
  }

  /** Leave the app with no chat open — first launch, or after the last one is deleted. */
  private async clearSession(): Promise<void> {
    await this.abort();
    this.session = null;
    this.sessionSettings = null;
    this.harness = null;
    this.messages = [];
    this.compactions = [];
    this.turnChanges = [];
    this.stats = { tokens: 0, cost: 0 };
    this.contextUsage = { tokens: 0, contextWindow: 0, compactAt: 0, canCompact: false };
    this.config.activeSessionPath = null;
  }

  async openSession(sessionPath: string): Promise<void> {
    // Already open, so re-selecting it in the sidebar is a no-op. The loaded
    // session is part of that test: on launch the path is restored from the
    // config before anything is read from disk, and skipping the work there
    // would leave the chat highlighted but never opened.
    if (sessionPath === this.config.activeSessionPath && this.session) return;
    if (this.compactionPromise) await this.compactionPromise;

    const currentPath = this.config.activeSessionPath;
    // The chat being left keeps running in the background; `this.streaming` is
    // about to describe the incoming chat instead, so remember it first.
    const wasStreaming = this.streaming;
    if (
      currentPath &&
      this.session &&
      this.harness &&
      this.sessionSettings &&
      wasStreaming
    ) {
      this.backgroundSessions.set(currentPath, {
        session: this.session,
        harness: this.harness,
        settings: this.sessionSettings,
        env: this.env,
        streaming: true,
      });
    }

    // Mark the old harness inactive before opening the target session so any
    // background events emitted during the filesystem reads are not forwarded
    // into the newly selected transcript. The old transcript goes with it: a
    // state push landing mid-switch would otherwise show the previous chat's
    // messages under the newly selected one.
    this.config.activeSessionPath = sessionPath;
    this.messages = [];
    this.compactions = [];
    this.turnChanges = [];
    this.stats = { tokens: 0, cost: 0 };
    this.streaming = false;

    const cached = this.backgroundSessions.get(sessionPath);
    if (cached) {
      if (!wasStreaming) void this.env.cleanup();
      this.backgroundSessions.delete(sessionPath);
      this.session = cached.session;
      this.sessionSettings = cached.settings;
      this.env = cached.env;
      this.harness = cached.harness;
      this.streaming = cached.streaming;
    } else {
      this.session = await this.sessions.open(sessionPath);
      this.sessionSettings = await this.sessions.readSettings(this.session, {
        workspace: this.config.behavior.projectsRoot,
        approvalMode: this.config.behavior.defaultApprovalMode,
      });
      this.useWorkspace(this.sessionSettings.workspace, Boolean(currentPath && wasStreaming));
      this.harness = this.createHarness(this.session, sessionPath);
    }

    const pendingRun = this.afterRunPromises.get(sessionPath);
    if (pendingRun && !this.streaming) await pendingRun;
    await this.loadTranscript(this.session);
    await this.refreshStats();
    await this.refreshContextUsage();
  }

  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    if (!this.sessionSettings) return;
    this.sessionSettings = { ...this.sessionSettings, approvalMode: mode };
    if (this.session) await this.sessions.writeSettings(this.session, this.sessionSettings);
    // Push, so the UI reflects the change even when it did not initiate it
    // (e.g. "Always run" chosen from an approval card mid-run).
    this.onStateChange?.();
  }

  async renameSession(sessionPath: string, title: string): Promise<void> {
    const isActive = sessionPath === this.config.activeSessionPath;
    await this.sessions.rename(sessionPath, title, isActive ? this.session ?? undefined : undefined);
  }

  async deleteSession(sessionPath: string): Promise<void> {
    const isActive = sessionPath === this.config.activeSessionPath;
    if (isActive) {
      await this.abort();
    } else {
      const background = this.backgroundSessions.get(sessionPath);
      if (background) {
        this.cancelRetry(sessionPath);
        for (const pending of this.pendingApprovals.values()) {
          if (pending.sessionPath === sessionPath) pending.resolve(false);
        }
        for (const pending of this.pendingQuestions.values()) {
          if (pending.sessionPath === sessionPath) pending.resolve([]);
        }
        await background.harness.abort();
        const pendingRun = this.afterRunPromises.get(sessionPath);
        if (pendingRun) await pendingRun.catch(() => undefined);
        await background.env.cleanup();
        this.backgroundSessions.delete(sessionPath);
      }
    }
    this.turnCheckpoints.delete(sessionPath);
    this.latestCheckpoints.delete(sessionPath);
    this.retries.delete(sessionPath);
    this.unrepeatableTurns.delete(sessionPath);
    await this.sessions.delete(sessionPath);
    this.ponytailSessionOff.delete(sessionPath);
    if (!isActive) return;
    const remaining = this.sessions.list();
    // Clear the active path first so openSession does not treat the target as
    // already selected after the deleted chat's path is removed.
    this.config.activeSessionPath = null;
    if (remaining[0]) await this.openSession(remaining[0].path);
    else await this.clearSession();
  }

  // ---------- models ----------

  listProviders(): Promise<ProviderOption[]> {
    return this.registry.listProviders();
  }

  listCatalog(providerId: string) {
    return this.registry.listCatalog(providerId);
  }

  setProviderWebSocket(providerId: string, enabled: boolean): void {
    this.registry.setProviderWebSocket(providerId, enabled);
  }

  async updateCustomModel(edit: CustomModelEdit): Promise<void> {
    const wasActive = this.activeKey === modelKey(edit.providerId, edit.originalModelId);
    const key = await this.registry.updateCustomModel(edit);
    // Rebuild the harness so an in-flight chat picks up the new endpoint.
    if (wasActive) await this.setActiveModel(key);
  }

  async clearProviderKey(providerId: string): Promise<void> {
    await this.registry.clearProviderKey(providerId);
  }

  async setActiveModel(key: string): Promise<void> {
    const model = this.registry.resolve(key);
    if (!model) throw new Error(`Unknown model ${key}`);
    this.setActiveKey(key);
    if (!this.harness) {
      const sessionPath = this.config.activeSessionPath;
      if (this.session && sessionPath) this.harness = this.createHarness(this.session, sessionPath);
      return;
    }
    await this.harness.setModel(model);
    await this.harness.setThinkingLevel(
      clampThinkingLevel(model, this.config.behavior.thinkingLevel),
    );
    await this.refreshContextUsage();
  }

  async addModel(providerId: string, modelId: string): Promise<void> {
    this.registry.addModel(providerId, modelId);
    if (!this.activeKey) await this.setActiveModel(modelKey(providerId, modelId));
  }

  async addCustomModel(input: CustomProviderInput): Promise<void> {
    const key = await this.registry.addCustomModel(input);
    if (!this.activeKey) await this.setActiveModel(key);
  }

  async removeModel(key: string): Promise<void> {
    this.registry.removeModel(key);
    if (this.activeKey !== key) return;
    const remaining = await this.registry.listConfiguredModels();
    if (remaining[0]) {
      await this.setActiveModel(remaining[0].key);
    } else {
      this.setActiveKey(null);
      this.harness = null;
    }
  }

  // ---------- settings ----------

  async updateBehavior(patch: Partial<BehaviorSettings>): Promise<void> {
    this.config.updateBehavior(patch);
    if (patch.thinkingLevel && this.harness) {
      await this.harness.setThinkingLevel(
        clampThinkingLevel(this.harness.getModel(), patch.thinkingLevel as ThinkingLevel),
      );
    }
  }

  // ---------- state ----------

  async getState(): Promise<AppState> {
    await this.refreshContextUsage();
    return {
      behavior: this.config.behavior,
      session: this.sessionSettings,
      models: await this.registry.listConfiguredModels(),
      activeModelKey: this.activeKey,
      sessions: this.sessions.list(),
      activeSessionPath: this.config.activeSessionPath,
      messages: this.messages,
      compactions: this.compactions,
      pendingApprovals: [...this.pendingApprovals.values()]
        .filter((pending) => pending.sessionPath === this.config.activeSessionPath)
        .map((pending) => pending.request),
      pendingQuestions: [...this.pendingQuestions.values()]
        .filter((pending) => pending.sessionPath === this.config.activeSessionPath)
        .map((pending) => pending.request),
      isStreaming: this.streaming,
      isCompacting: this.compacting,
      retry: this.config.activeSessionPath
        ? this.retries.get(this.config.activeSessionPath) ?? null
        : null,
      contextUsage: this.contextUsage,
      turnChanges: this.turnChanges,
      stats: this.stats,
      appVersion: this.appVersion,
    };
  }
}
