import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import type {
  ApprovalMode,
  BehaviorSettings,
  CustomModelEdit,
  CustomProviderInput,
  NewChatInput,
} from "../shared/ipc.js";
import { CH_AGENT_EVENT, CH_APPROVAL_REQUEST, CH_STATE } from "../shared/ipc.js";
import { AgentService } from "./agent-service.js";
import { ConfigStore } from "./config-store.js";
import { EncryptedCredentialStore } from "./credentials.js";
import { ModelStore } from "./model-store.js";
import { migrateLegacyData } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** dist/main/index.js -> project root */
const ICON_PNG = path.join(__dirname, "..", "..", "assets", "icon.png");

let win: BrowserWindow | null = null;
let service: AgentService;
let config: ConfigStore;
let credentials: EncryptedCredentialStore;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: "pi desktop",
    backgroundColor: "#0b0c0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    // macOS takes its icon from the bundle (or app.dock below), not from here.
    ...(process.platform === "darwin" ? {} : { icon: ICON_PNG }),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  // Unpackaged macOS runs show the stock Electron icon otherwise.
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(ICON_PNG);
    } catch (error) {
      console.warn("Could not set the dock icon:", error);
    }
  }

  migrateLegacyData();
  config = new ConfigStore();
  credentials = new EncryptedCredentialStore();
  service = new AgentService(config, new ModelStore(), credentials, app.getVersion());

  service.onEvent = (event) => win?.webContents.send(CH_AGENT_EVENT, event);
  service.onApprovalRequest = (request) => win?.webContents.send(CH_APPROVAL_REQUEST, request);
  service.onStateChange = () => {
    void service.getState().then((state) => win?.webContents.send(CH_STATE, state));
  };

  await service.init();

  const state = () => service.getState();

  ipcMain.handle("pi:get-state", state);
  ipcMain.handle("pi:prompt", (_e, text: string) => service.prompt(text));
  ipcMain.handle("pi:abort", async () => {
    await service.abort();
    return state();
  });

  ipcMain.handle("pi:session-new", async (_e, input: NewChatInput) => {
    await service.newSession(input);
    return state();
  });
  ipcMain.handle("pi:project-check-name", (_e, name: string) => service.checkProjectName(name));
  ipcMain.handle("pi:choose-directory", async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: "Choose a folder for this chat",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: config.behavior.projectsRoot,
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("pi:session-open", async (_e, sessionPath: string) => {
    await service.openSession(sessionPath);
    return state();
  });
  ipcMain.handle("pi:session-rename", async (_e, sessionPath: string, title: string) => {
    await service.renameSession(sessionPath, title);
    return state();
  });
  ipcMain.handle("pi:session-delete", async (_e, sessionPath: string) => {
    await service.deleteSession(sessionPath);
    return state();
  });

  ipcMain.handle("pi:model-set-active", async (_e, key: string) => {
    await service.setActiveModel(key);
    return state();
  });
  ipcMain.handle("pi:model-remove", async (_e, key: string) => {
    await service.removeModel(key);
    return state();
  });
  ipcMain.handle("pi:provider-set-websocket", async (_e, providerId: string, enabled: boolean) => {
    service.setProviderWebSocket(providerId, enabled);
    return state();
  });
  ipcMain.handle("pi:model-update-custom", async (_e, edit: CustomModelEdit) => {
    await service.updateCustomModel(edit);
    return state();
  });
  ipcMain.handle("pi:provider-clear-key", async (_e, providerId: string) => {
    await service.clearProviderKey(providerId);
    return state();
  });
  ipcMain.handle("pi:providers-list", () => service.listProviders());
  ipcMain.handle("pi:provider-save-key", async (_e, providerId: string, apiKey: string) => {
    await credentials.setApiKey(providerId, apiKey);
    return service.listProviders();
  });
  ipcMain.handle("pi:catalog-list", (_e, providerId: string) => service.listCatalog(providerId));
  ipcMain.handle("pi:model-add", async (_e, providerId: string, modelId: string) => {
    await service.addModel(providerId, modelId);
    return state();
  });
  ipcMain.handle("pi:model-add-custom", async (_e, input: CustomProviderInput) => {
    await service.addCustomModel(input);
    return state();
  });

  ipcMain.handle("pi:behavior-update", async (_e, patch: Partial<BehaviorSettings>) => {
    await service.updateBehavior(patch);
    return state();
  });
  ipcMain.handle("pi:approval-mode-set", async (_e, mode: ApprovalMode) => {
    await service.setApprovalMode(mode);
    return state();
  });
  ipcMain.handle("pi:choose-projects-root", async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: "Choose the folder where new projects are created",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: config.behavior.projectsRoot,
    });
    const dir = result.filePaths[0];
    if (!result.canceled && dir) await service.updateBehavior({ projectsRoot: dir });
    return state();
  });

  ipcMain.handle(
    "pi:approval-respond",
    (_e, approvalId: string, allow: boolean, always: boolean) => {
      service.respondApproval(approvalId, allow, always);
    },
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
