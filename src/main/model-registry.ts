import { randomUUID } from "node:crypto";
import {
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  CatalogModel,
  ConfiguredModel,
  CustomModelEdit,
  CustomProviderInput,
  ProviderOption,
  ThinkingLevel,
  WebSocketStatusInfo,
} from "../shared/ipc.js";
import type { EncryptedCredentialStore } from "./credentials.js";
import type { ConfiguredModelSpec, CustomProviderSpec, ModelStore } from "./model-store.js";
import { WS_FAILURE_LIMIT, WebSocketBreaker, responsesApiWithWebSocket } from "./responses-ws.js";

/** Built-in providers offered in the add-model flow, with their env fallbacks. */
const BUILTIN_PROVIDERS: Array<{ id: string; envHint: string; blurb: string }> = [
  { id: "anthropic", envHint: "ANTHROPIC_API_KEY", blurb: "Claude models" },
  { id: "openai", envHint: "OPENAI_API_KEY", blurb: "GPT and o-series" },
  { id: "google", envHint: "GEMINI_API_KEY", blurb: "Gemini models" },
  { id: "xai", envHint: "XAI_API_KEY", blurb: "Grok models" },
  { id: "groq", envHint: "GROQ_API_KEY", blurb: "Fast open models" },
  { id: "deepseek", envHint: "DEEPSEEK_API_KEY", blurb: "DeepSeek chat and reasoner" },
  { id: "mistral", envHint: "MISTRAL_API_KEY", blurb: "Mistral and Codestral" },
  { id: "openrouter", envHint: "OPENROUTER_API_KEY", blurb: "Hundreds of models, one key" },
];

function apiImplementation(
  api: CustomProviderInput["api"],
  websocket?: ProviderStreams,
): ProviderStreams {
  switch (api) {
    case "openai-responses":
      return websocket ?? openAIResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    default:
      return openAICompletionsApi();
  }
}

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/**
 * Owns the pi `Models` collection: built-in providers, user-defined custom
 * providers, and the subset of models the user has actually added.
 */
export class ModelRegistry {
  readonly models: MutableModels;
  /** Session-only models (the faux demo provider) that must not be persisted. */
  private ephemeral: ConfiguredModelSpec[] = [];
  /** Websocket health per provider. In-memory, so it resets each app launch. */
  private readonly breaker = new WebSocketBreaker();

  constructor(
    private readonly store: ModelStore,
    private readonly credentials: EncryptedCredentialStore,
  ) {
    this.models = builtinModels({ credentials });
    for (const spec of store.customProviders) this.registerCustomProvider(spec);
  }

  addEphemeralModel(providerId: string, modelId: string): void {
    this.ephemeral = [{ providerId, modelId }];
  }

  private specs(): ConfiguredModelSpec[] {
    return [...this.ephemeral, ...this.store.configuredModels];
  }

  private registerCustomProvider(spec: CustomProviderSpec): void {
    this.models.setProvider(
      createProvider({
        id: spec.id,
        name: spec.name,
        baseUrl: spec.baseUrl,
        auth: { apiKey: envApiKeyAuth(`${spec.name} API key`, []) },
        models: spec.models.map((m) => ({
          id: m.id,
          name: m.name,
          api: spec.api,
          provider: spec.id,
          baseUrl: spec.baseUrl,
          reasoning: m.reasoning,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        })),
        api: apiImplementation(
          spec.api,
          responsesApiWithWebSocket(this.breaker, (providerId) =>
            Boolean(this.store.customProviders.find((p) => p.id === providerId)?.useWebSocket),
          ),
        ),
      }),
    );
  }

  /** Websocket state for the model picker and settings, or undefined if N/A. */
  private webSocketStatus(providerId: string): WebSocketStatusInfo | undefined {
    const spec = this.store.customProviders.find((p) => p.id === providerId);
    if (!spec || spec.api !== "openai-responses") return undefined;
    const status = this.breaker.status(providerId);
    return {
      providerId,
      enabled: Boolean(spec.useWebSocket),
      supported: status.supported,
      consecutiveFailures: status.consecutiveFailures,
      failureLimit: WS_FAILURE_LIMIT,
      lastError: status.lastError,
    };
  }

  setProviderWebSocket(providerId: string, enabled: boolean): void {
    this.store.setCustomProviderWebSocket(providerId, enabled);
  }

  private async providerHasKey(providerId: string): Promise<boolean> {
    if (this.credentials.hasStoredKey(providerId)) return true;
    try {
      return (await this.models.checkAuth(providerId)) !== undefined;
    } catch {
      return false;
    }
  }

  async listProviders(): Promise<ProviderOption[]> {
    const options: ProviderOption[] = [];
    for (const entry of BUILTIN_PROVIDERS) {
      const provider = this.models.getProvider(entry.id);
      if (!provider) continue;
      options.push({
        id: entry.id,
        name: provider.name,
        envHint: entry.envHint,
        blurb: entry.blurb,
        hasKey: await this.providerHasKey(entry.id),
        isCustom: false,
      });
    }
    for (const spec of this.store.customProviders) {
      options.push({
        id: spec.id,
        name: spec.name,
        blurb: spec.baseUrl,
        hasKey: await this.providerHasKey(spec.id),
        isCustom: true,
      });
    }
    return options;
  }

  listCatalog(providerId: string): CatalogModel[] {
    const configured = new Set(this.specs().map((m) => modelKey(m.providerId, m.modelId)));
    return this.models.getModels(providerId).map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      inputCost: model.cost.input,
      outputCost: model.cost.output,
      alreadyAdded: configured.has(modelKey(providerId, model.id)),
    }));
  }

  resolve(key: string | null): Model<Api> | undefined {
    if (!key) return undefined;
    const separator = key.indexOf("::");
    if (separator < 0) return undefined;
    return this.models.getModel(key.slice(0, separator), key.slice(separator + 2));
  }

  async listConfiguredModels(): Promise<ConfiguredModel[]> {
    const keyCache = new Map<string, boolean>();
    const result: ConfiguredModel[] = [];
    for (const spec of this.specs()) {
      const model = this.models.getModel(spec.providerId, spec.modelId);
      if (!model) continue;
      const provider = this.models.getProvider(spec.providerId);
      const custom = this.store.customProviders.find((p) => p.id === spec.providerId);
      if (!keyCache.has(spec.providerId)) {
        keyCache.set(spec.providerId, await this.providerHasKey(spec.providerId));
      }
      const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
      result.push({
        key: modelKey(spec.providerId, spec.modelId),
        providerId: spec.providerId,
        providerName: provider?.name ?? spec.providerId,
        modelId: spec.modelId,
        displayName: model.name,
        isCustom: Boolean(custom),
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        thinkingLevels: levels.includes("off") ? levels : ["off", ...levels],
        hasKey: keyCache.get(spec.providerId) ?? false,
        webSocket: this.webSocketStatus(spec.providerId),
        custom: custom
          ? { baseUrl: custom.baseUrl, api: custom.api, maxTokens: model.maxTokens }
          : undefined,
      });
    }
    return result;
  }

  addModel(providerId: string, modelId: string): void {
    if (!this.models.getModel(providerId, modelId)) {
      throw new Error(`Unknown model ${providerId}/${modelId}`);
    }
    this.store.addConfiguredModel({ providerId, modelId });
  }

  removeModel(key: string): void {
    const separator = key.indexOf("::");
    if (separator < 0) return;
    const providerId = key.slice(0, separator);
    const modelId = key.slice(separator + 2);
    this.store.removeConfiguredModel(providerId, modelId);

    // Drop a custom provider once its last model is gone.
    const custom = this.store.customProviders.find((p) => p.id === providerId);
    if (custom && !this.store.configuredModels.some((m) => m.providerId === providerId)) {
      this.store.removeCustomProvider(providerId);
      this.models.deleteProvider(providerId);
      void this.credentials.delete(providerId);
    }
  }

  /**
   * Apply an edit to a custom provider and one of its models. Returns the model
   * key afterwards, which changes when the model id was renamed.
   */
  async updateCustomModel(edit: CustomModelEdit): Promise<string> {
    const spec = this.store.customProviders.find((p) => p.id === edit.providerId);
    if (!spec) throw new Error("That provider no longer exists");

    const baseUrl = edit.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) throw new Error("Base URL must start with http:// or https://");
    const modelId = edit.modelId.trim();
    if (!modelId) throw new Error("Model ID is required");
    if (
      modelId !== edit.originalModelId &&
      spec.models.some((m) => m.id === modelId)
    ) {
      throw new Error("This provider already has a model with that ID");
    }

    const updated: CustomProviderSpec = {
      ...spec,
      name: edit.name.trim() || new URL(baseUrl).host,
      baseUrl,
      api: edit.api,
      useWebSocket: edit.api === "openai-responses" ? Boolean(edit.useWebSocket) : undefined,
      models: spec.models.map((m) =>
        m.id === edit.originalModelId
          ? {
              id: modelId,
              name: modelId,
              contextWindow: edit.contextWindow || m.contextWindow,
              maxTokens: edit.maxTokens || m.maxTokens,
              reasoning: edit.reasoning,
            }
          : m,
      ),
    };

    this.store.addCustomProvider(updated);
    this.registerCustomProvider(updated);
    if (modelId !== edit.originalModelId) {
      this.store.renameConfiguredModel(edit.providerId, edit.originalModelId, modelId);
    }
    if (edit.apiKey?.trim()) await this.credentials.setApiKey(edit.providerId, edit.apiKey.trim());
    return modelKey(edit.providerId, modelId);
  }

  async clearProviderKey(providerId: string): Promise<void> {
    await this.credentials.delete(providerId);
  }

  async addCustomModel(input: CustomProviderInput): Promise<string> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) throw new Error("Base URL must start with http:// or https://");
    if (!input.modelId.trim()) throw new Error("Model ID is required");

    // Reuse an existing custom provider pointing at the same endpoint.
    const existing = this.store.customProviders.find(
      (p) => p.baseUrl === baseUrl && p.api === input.api,
    );
    const spec: CustomProviderSpec = existing ?? {
      id: `custom-${randomUUID().slice(0, 8)}`,
      name: input.name.trim() || new URL(baseUrl).host,
      baseUrl,
      api: input.api,
      models: [],
    };
    if (input.api === "openai-responses") spec.useWebSocket = Boolean(input.useWebSocket);
    const modelId = input.modelId.trim();
    spec.models = [
      ...spec.models.filter((m) => m.id !== modelId),
      {
        id: modelId,
        name: modelId,
        contextWindow: input.contextWindow || 128_000,
        maxTokens: input.maxTokens || 8_192,
        reasoning: input.reasoning,
      },
    ];

    this.store.addCustomProvider(spec);
    this.registerCustomProvider(spec);
    if (input.apiKey.trim()) await this.credentials.setApiKey(spec.id, input.apiKey.trim());
    this.store.addConfiguredModel({ providerId: spec.id, modelId });
    return modelKey(spec.id, modelId);
  }
}
