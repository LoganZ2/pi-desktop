import type { CustomProviderInput } from "../shared/ipc.js";
import { MODELS_FILE, readJson, writeJson } from "./paths.js";


/** A provider the user defined by hand (self-hosted, proxy, or an unlisted vendor). */
export interface CustomProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderInput["api"];
  /** Responses format only: prefer websocket streaming for this provider. */
  useWebSocket?: boolean;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
  }>;
}

/** A model the user added to their picker. */
export interface ConfiguredModelSpec {
  providerId: string;
  modelId: string;
}

/** `~/.pi-desktop/models.json` — which models exist in the picker and which is selected. */
interface StoredModels {
  activeModelKey?: string | null;
  configuredModels?: ConfiguredModelSpec[];
  customProviders?: CustomProviderSpec[];
}

export class ModelStore {
  private data: StoredModels;

  constructor() {
    this.data = readJson<StoredModels>(MODELS_FILE, {});
    this.save();
  }

  private save(): void {
    writeJson(MODELS_FILE, {
      activeModelKey: this.data.activeModelKey ?? null,
      configuredModels: this.configuredModels,
      customProviders: this.customProviders,
    });
  }

  get configuredModels(): ConfiguredModelSpec[] {
    return this.data.configuredModels ?? [];
  }

  addConfiguredModel(spec: ConfiguredModelSpec): void {
    const models = this.configuredModels;
    if (models.some((m) => m.providerId === spec.providerId && m.modelId === spec.modelId)) return;
    this.data.configuredModels = [...models, spec];
    this.save();
  }

  /** Rename a configured model in place, preserving its position in the list. */
  renameConfiguredModel(providerId: string, fromModelId: string, toModelId: string): void {
    this.data.configuredModels = this.configuredModels.map((m) =>
      m.providerId === providerId && m.modelId === fromModelId ? { ...m, modelId: toModelId } : m,
    );
    this.save();
  }

  removeConfiguredModel(providerId: string, modelId: string): void {
    this.data.configuredModels = this.configuredModels.filter(
      (m) => !(m.providerId === providerId && m.modelId === modelId),
    );
    this.save();
  }

  get customProviders(): CustomProviderSpec[] {
    return this.data.customProviders ?? [];
  }

  addCustomProvider(spec: CustomProviderSpec): void {
    this.data.customProviders = [...this.customProviders.filter((p) => p.id !== spec.id), spec];
    this.save();
  }

  setCustomProviderWebSocket(id: string, useWebSocket: boolean): void {
    const spec = this.customProviders.find((p) => p.id === id);
    if (!spec) return;
    this.addCustomProvider({ ...spec, useWebSocket });
  }

  removeCustomProvider(id: string): void {
    this.data.customProviders = this.customProviders.filter((p) => p.id !== id);
    this.save();
  }

  get activeModelKey(): string | null {
    return this.data.activeModelKey ?? null;
  }

  set activeModelKey(key: string | null) {
    this.data.activeModelKey = key;
    this.save();
  }
}
