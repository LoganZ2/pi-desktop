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
import { clampThinkingLevel } from "@earendil-works/pi-ai";
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
  NewChatInput,
  ProjectNameCheck,
  ProviderOption,
  SessionSettings,
  ThinkingLevel,
} from "../shared/ipc.js";
import type { EncryptedCredentialStore } from "./credentials.js";
import { maybeRegisterFauxDemo } from "./faux-demo.js";
import { ModelRegistry, modelKey } from "./model-registry.js";
import { checkProjectName, createProject } from "./projects.js";
import type { ConfigStore } from "./config-store.js";
import type { ModelStore } from "./model-store.js";
import { SessionManager, titleFromPrompt } from "./session-manager.js";

type Tools = AgentHarnessTool<ExecutionToolContext>[];

export class AgentService {
  private readonly registry: ModelRegistry;
  private readonly sessions: SessionManager;
  private env: NodeExecutionEnv;
  private harness: AgentHarness<ExecutionToolContext> | null = null;
  private session: Session<JsonlSessionMetadata> | null = null;
  private messages: ChatMessage[] = [];
  private compactions: CompactionNotice[] = [];
  private pendingApprovals = new Map<string, (allow: boolean) => void>();
  private streaming = false;
  private compacting = false;
  private compactionPromise: Promise<void> | null = null;
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

  onEvent?: (event: AgentHarnessEvent) => void;
  onApprovalRequest?: (request: ApprovalRequest) => void;
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
  private useWorkspace(workspace: string): void {
    if (this.env.cwd === workspace) return;
    void this.env.cleanup();
    this.env = new NodeExecutionEnv({ cwd: workspace });
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

  private systemPrompt(): string {
    const workspace = this.sessionSettings?.workspace ?? this.config.behavior.projectsRoot;
    return [
      "You are pi desktop, a coding agent running inside a desktop app, built on the pi agent framework.",
      "You help with software engineering tasks: reading and writing code, running shell commands, and explaining what you find.",
      "",
      `Working directory: ${workspace}`,
      `Platform: ${process.platform} (${os.release()}), Node ${process.versions.node}`,
      `Today's date: ${new Date().toDateString()}`,
      "",
      "Rules:",
      "- Prefer the read/edit/write tools for file operations; use bash for everything else.",
      "- Relative paths resolve against the working directory.",
      "- Keep answers concise. Use markdown code blocks for code.",
      "- Never run destructive commands unless the user explicitly asks.",
    ].join("\n");
  }

  private buildTools(): Tools {
    return [createReadTool(), createBashTool(), createEditTool(), createWriteTool()] as Tools;
  }

  private createHarness(session: Session<JsonlSessionMetadata>): AgentHarness<ExecutionToolContext> | null {
    const model = this.registry.resolve(this.activeKey);
    if (!model) return null;

    const harness = new AgentHarness<ExecutionToolContext>({
      session,
      models: this.registry.models,
      model,
      thinkingLevel: clampThinkingLevel(model, this.config.behavior.thinkingLevel),
      tools: this.buildTools(),
      toolContext: () => ({ env: this.env }),
      systemPrompt: () => this.systemPrompt(),
    });

    harness.subscribe((event) => {
      this.handleEvent(event);
    });
    harness.on("tool_call", async (event) => {
      if (event.toolName !== "bash" || this.sessionSettings?.approvalMode === "auto") return;
      const command =
        typeof event.input?.command === "string"
          ? event.input.command
          : JSON.stringify(event.input ?? {});
      const allowed = await this.requestApproval(event.toolCallId, event.toolName, command);
      return allowed
        ? undefined
        : { block: true, reason: "The user denied this command in the approval prompt." };
    });
    return harness;
  }

  private handleEvent(event: AgentHarnessEvent): void {
    switch (event.type) {
      case "agent_start":
        this.streaming = true;
        break;
      case "agent_end":
        this.streaming = false;
        void this.afterRun();
        break;
      case "message_end": {
        const message = event.message as ChatMessage;
        this.messages = [...this.messages, message];
        break;
      }
      case "session_compact":
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
        break;
      default:
        break;
    }
    this.onEvent?.(event);
  }

  private async afterRun(): Promise<void> {
    await this.refreshStats();
    await this.refreshContextUsage();
    const sessionPath = this.config.activeSessionPath;
    if (sessionPath) this.sessions.touch(sessionPath, this.messages.length);

    if (
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
  ): Promise<boolean> {
    const approvalId = randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approvalId, resolve);
      this.onApprovalRequest?.({ approvalId, toolCallId, toolName, command });
    }).finally(() => {
      this.pendingApprovals.delete(approvalId);
    });
  }

  respondApproval(approvalId: string, allow: boolean, always: boolean): void {
    // "Always" applies to this chat only, matching where the setting lives.
    if (always) void this.setApprovalMode("auto");
    this.pendingApprovals.get(approvalId)?.(allow);
  }

  // ---------- chat ----------

  async prompt(text: string): Promise<{ steered: boolean }> {
    if (!this.harness) throw new Error("Add a model before sending a message");

    const sessionPath = this.config.activeSessionPath;
    if (sessionPath && !this.sessions.hasTitle(sessionPath)) {
      await this.sessions.rename(sessionPath, titleFromPrompt(text), this.session ?? undefined);
      this.onStateChange?.();
    }

    if (this.streaming) {
      await this.harness.steer(text);
      return { steered: true };
    }
    if (this.compactionPromise) await this.compactionPromise;

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

    void this.harness.prompt(text).catch((error) => {
      console.error("prompt failed:", error);
      this.streaming = false;
      this.onStateChange?.();
    });
    return { steered: false };
  }

  async compact(): Promise<void> {
    await this.refreshContextUsage();
    if (!this.contextUsage.canCompact) throw new Error("There is not enough old context to compact");
    await this.runCompaction();
  }

  async abort(): Promise<void> {
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    if (this.compactionPromise) {
      // pi-agent-core compaction is not currently abortable. Waiting prevents a
      // session switch from racing a summary write into the previous chat.
      await this.compactionPromise.catch(() => undefined);
    }
    await this.harness?.abort();
    this.streaming = false;
  }

  // ---------- sessions ----------

  private async loadTranscript(session: Session<JsonlSessionMetadata>): Promise<void> {
    let entries: SessionTreeEntry[] = [];
    try {
      // The full append log keeps pre-compaction messages available to the UI;
      // Session.buildContext() still uses pi's compacted active branch for LLM calls.
      entries = await session.getEntries();
    } catch (error) {
      console.warn("Could not read session transcript:", error);
    }

    const messages: ChatMessage[] = [];
    const compactions: CompactionNotice[] = [];
    for (const entry of entries) {
      if (entry.type === "message") {
        messages.push(entry.message as ChatMessage);
      } else if (entry.type === "compaction") {
        compactions.push({
          id: entry.id,
          afterMessageCount: messages.length,
          timestamp: entry.timestamp,
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
        });
      }
    }
    this.messages = messages;
    this.compactions = compactions;
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
    this.config.activeSessionPath = (await this.session.getMetadata()).path;
    this.messages = [];
    this.compactions = [];
    this.stats = { tokens: 0, cost: 0 };
    this.contextUsage = { tokens: 0, contextWindow: 0, compactAt: 0, canCompact: false };
    this.harness = this.createHarness(this.session);
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
    this.stats = { tokens: 0, cost: 0 };
    this.contextUsage = { tokens: 0, contextWindow: 0, compactAt: 0, canCompact: false };
    this.config.activeSessionPath = null;
  }

  async openSession(sessionPath: string): Promise<void> {
    await this.abort();
    this.session = await this.sessions.open(sessionPath);
    this.sessionSettings = await this.sessions.readSettings(this.session, {
      workspace: this.config.behavior.projectsRoot,
      approvalMode: this.config.behavior.defaultApprovalMode,
    });
    this.useWorkspace(this.sessionSettings.workspace);
    this.config.activeSessionPath = sessionPath;
    await this.loadTranscript(this.session);
    await this.refreshStats();
    this.harness = this.createHarness(this.session);
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
    await this.sessions.delete(sessionPath);
    if (sessionPath !== this.config.activeSessionPath) return;
    const remaining = this.sessions.list();
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
      if (this.session) this.harness = this.createHarness(this.session);
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
      isStreaming: this.streaming,
      isCompacting: this.compacting,
      contextUsage: this.contextUsage,
      stats: this.stats,
      appVersion: this.appVersion,
    };
  }
}
