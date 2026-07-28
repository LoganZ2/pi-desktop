import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { BehaviorSettings } from "../shared/ipc.js";
import { CONFIG_FILE, readJson, writeJson } from "./paths.js";

/**
 * `~/.pi-desktop/config.json` — app behavior plus which chat was last open.
 * Written flat so it stays readable if someone edits it by hand.
 */
interface StoredConfig extends Partial<BehaviorSettings> {
  activeSessionPath?: string | null;
}

function defaultProjectsRoot(): string {
  const dir = path.join(homedir(), "pi-desktop-projects");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const DEFAULTS: BehaviorSettings = {
  projectsRoot: "",
  defaultApprovalMode: "ask",
  thinkingLevel: "off",
  sendOnEnter: true,
  autoExpandThinking: false,
  showTokenUsage: true,
  autoCompact: true,
};

export class ConfigStore {
  private data: StoredConfig;

  constructor() {
    if (existsSync(CONFIG_FILE)) {
      this.data = readJson<StoredConfig>(CONFIG_FILE, {});
    } else {
      // Materialize defaults on first run so the file is there to read and edit.
      this.data = {};
      this.data = { ...this.behavior, activeSessionPath: null };
      this.save();
    }
  }

  private save(): void {
    writeJson(CONFIG_FILE, this.data);
  }

  get behavior(): BehaviorSettings {
    const projectsRoot =
      this.data.projectsRoot && existsSync(this.data.projectsRoot)
        ? this.data.projectsRoot
        : defaultProjectsRoot();
    const { activeSessionPath: _ignored, ...behavior } = this.data;
    return { ...DEFAULTS, ...behavior, projectsRoot };
  }

  updateBehavior(patch: Partial<BehaviorSettings>): BehaviorSettings {
    this.data = { ...this.data, ...this.behavior, ...patch };
    this.save();
    return this.behavior;
  }

  get activeSessionPath(): string | null {
    return this.data.activeSessionPath ?? null;
  }

  set activeSessionPath(sessionPath: string | null) {
    this.data.activeSessionPath = sessionPath;
    this.save();
  }
}
