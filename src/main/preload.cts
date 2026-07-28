// Preload bridge: the only surface the renderer can reach the main process through.
// Kept CommonJS because sandboxed preload scripts require it.
import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentEvent,
  AppState,
  ApprovalRequest,
  BehaviorSettings,
  ApprovalMode,
  CustomModelEdit,
  CustomProviderInput,
  NewChatInput,
  PiBridge,
} from "../shared/ipc.js";

const CH_AGENT_EVENT = "pi:agent-event";
const CH_APPROVAL_REQUEST = "pi:approval-request";
const CH_STATE = "pi:state";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: PiBridge = {
  getState: () => ipcRenderer.invoke("pi:get-state"),

  prompt: (text: string) => ipcRenderer.invoke("pi:prompt", text),
  abort: () => ipcRenderer.invoke("pi:abort"),

  newSession: (input: NewChatInput) => ipcRenderer.invoke("pi:session-new", input),
  checkProjectName: (name: string) => ipcRenderer.invoke("pi:project-check-name", name),
  chooseDirectory: () => ipcRenderer.invoke("pi:choose-directory"),
  openSession: (path: string) => ipcRenderer.invoke("pi:session-open", path),
  renameSession: (path: string, title: string) =>
    ipcRenderer.invoke("pi:session-rename", path, title),
  deleteSession: (path: string) => ipcRenderer.invoke("pi:session-delete", path),

  setActiveModel: (key: string) => ipcRenderer.invoke("pi:model-set-active", key),
  removeModel: (key: string) => ipcRenderer.invoke("pi:model-remove", key),
  setProviderWebSocket: (providerId: string, enabled: boolean) =>
    ipcRenderer.invoke("pi:provider-set-websocket", providerId, enabled),
  updateCustomModel: (edit: CustomModelEdit) => ipcRenderer.invoke("pi:model-update-custom", edit),
  clearProviderKey: (providerId: string) =>
    ipcRenderer.invoke("pi:provider-clear-key", providerId),
  listProviders: () => ipcRenderer.invoke("pi:providers-list"),
  saveProviderKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke("pi:provider-save-key", providerId, apiKey),
  listCatalog: (providerId: string) => ipcRenderer.invoke("pi:catalog-list", providerId),
  addModel: (providerId: string, modelId: string) =>
    ipcRenderer.invoke("pi:model-add", providerId, modelId),
  addCustomModel: (input: CustomProviderInput) => ipcRenderer.invoke("pi:model-add-custom", input),

  updateBehavior: (patch: Partial<BehaviorSettings>) =>
    ipcRenderer.invoke("pi:behavior-update", patch),
  setApprovalMode: (mode: ApprovalMode) => ipcRenderer.invoke("pi:approval-mode-set", mode),
  chooseProjectsRoot: () => ipcRenderer.invoke("pi:choose-projects-root"),

  respondApproval: (approvalId: string, allow: boolean, always: boolean) =>
    ipcRenderer.invoke("pi:approval-respond", approvalId, allow, always),

  onAgentEvent: (listener: (event: AgentEvent) => void) =>
    subscribe<AgentEvent>(CH_AGENT_EVENT, listener),
  onApprovalRequest: (listener: (request: ApprovalRequest) => void) =>
    subscribe<ApprovalRequest>(CH_APPROVAL_REQUEST, listener),
  onState: (listener: (state: AppState) => void) => subscribe<AppState>(CH_STATE, listener),
};

contextBridge.exposeInMainWorld("pi", bridge);
