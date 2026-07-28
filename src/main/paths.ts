import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { app } from "electron";

/** All user-owned app data lives here, so it is easy to find, edit, and back up. */
export const PI_DIR = path.join(homedir(), ".pi-desktop");
export const CONFIG_FILE = path.join(PI_DIR, "config.json");
export const MODELS_FILE = path.join(PI_DIR, "models.json");
export const CREDENTIALS_FILE = path.join(PI_DIR, "credentials.json");

export function readJson<T extends object>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch (error) {
    console.warn(`Could not read ${file}, using defaults:`, error);
    return fallback;
  }
}

export function writeJson(file: string, data: unknown, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
}

interface LegacySettings {
  behavior?: Record<string, unknown>;
  activeSessionPath?: string | null;
  activeModelKey?: string | null;
  configuredModels?: unknown[];
  customProviders?: unknown[];
}

/**
 * One-time move of pre-0.2 data out of Electron's userData directory.
 * Runs before the stores load; anything already in ~/.pi-desktop wins.
 */
export function migrateLegacyData(): void {
  mkdirSync(PI_DIR, { recursive: true });

  const userData = app.getPath("userData");
  const legacySettings = path.join(userData, "settings.json");
  const legacyCredentials = path.join(userData, "credentials.json");

  if (existsSync(legacySettings) && !existsSync(CONFIG_FILE) && !existsSync(MODELS_FILE)) {
    const legacy = readJson<LegacySettings>(legacySettings, {});
    writeJson(CONFIG_FILE, {
      ...(legacy.behavior ?? {}),
      activeSessionPath: legacy.activeSessionPath ?? null,
    });
    writeJson(MODELS_FILE, {
      activeModelKey: legacy.activeModelKey ?? null,
      configuredModels: legacy.configuredModels ?? [],
      customProviders: legacy.customProviders ?? [],
    });
    try {
      renameSync(legacySettings, `${legacySettings}.migrated`);
    } catch {
      // Keeping the original is harmless — the new files already exist.
    }
    console.log(`Migrated settings from ${legacySettings} to ${PI_DIR}`);
  }

  if (existsSync(legacyCredentials) && !existsSync(CREDENTIALS_FILE)) {
    try {
      renameSync(legacyCredentials, CREDENTIALS_FILE);
      console.log(`Migrated credentials to ${CREDENTIALS_FILE}`);
    } catch (error) {
      console.warn("Could not migrate credentials:", error);
    }
  }
}
