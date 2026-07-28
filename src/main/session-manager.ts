import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  JsonlSessionRepo,
  loadJsonlSessionMetadata,
  type JsonlSessionMetadata,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { SessionSettings, SessionSummary } from "../shared/ipc.js";

interface IndexEntry {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

const UNTITLED = "New chat";

/**
 * Custom-entry tag for this app's per-chat settings. pi keeps custom entries in
 * the transcript but out of the model's context, so they persist without
 * leaking into prompts.
 */
const SETTINGS_ENTRY = "pi-desktop:session-settings";

/**
 * Session persistence on top of pi's JSONL session repository.
 *
 * The JSONL files are the source of truth; a small index file mirrors titles
 * and timestamps so the sidebar can render without opening every transcript.
 */
export class SessionManager {
  private readonly repo: JsonlSessionRepo;
  private readonly fs: NodeExecutionEnv;
  private readonly root: string;
  private readonly indexFile: string;
  private index: Record<string, IndexEntry> = {};

  constructor() {
    // Session storage has its own filesystem handle so it is unaffected by the
    // workspace folder, which now varies per chat.
    this.fs = new NodeExecutionEnv({ cwd: app.getPath("userData") });
    this.root = path.join(app.getPath("userData"), "sessions");
    mkdirSync(this.root, { recursive: true });
    this.indexFile = path.join(app.getPath("userData"), "sessions-index.json");
    try {
      if (existsSync(this.indexFile)) {
        this.index = JSON.parse(readFileSync(this.indexFile, "utf-8")) as Record<string, IndexEntry>;
      }
    } catch (error) {
      console.warn("Could not read session index:", error);
    }
    this.repo = new JsonlSessionRepo({ fs: this.fs, sessionsRoot: this.root });
  }

  /**
   * Per-chat settings: the newest settings entry wins, falling back to the
   * chat's recorded cwd and then the caller's defaults.
   */
  async readSettings(
    session: Session<JsonlSessionMetadata>,
    defaults: SessionSettings,
  ): Promise<SessionSettings> {
    let settings: SessionSettings = { ...defaults };
    try {
      const metadata = await session.getMetadata();
      if (metadata.cwd) settings.workspace = metadata.cwd;
      for (const entry of await session.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== SETTINGS_ENTRY) continue;
        settings = { ...settings, ...(entry.data as Partial<SessionSettings>) };
      }
    } catch (error) {
      console.warn("Could not read chat settings:", error);
    }
    return settings;
  }

  async writeSettings(
    session: Session<JsonlSessionMetadata>,
    settings: SessionSettings,
  ): Promise<void> {
    try {
      await session.appendCustomEntry(SETTINGS_ENTRY, settings);
    } catch (error) {
      console.warn("Could not persist chat settings:", error);
    }
  }

  private saveIndex(): void {
    writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  /** Backfill index entries for session files written outside this app run. */
  async refreshIndex(): Promise<void> {
    let metadataList: JsonlSessionMetadata[] = [];
    try {
      metadataList = await this.repo.list();
    } catch (error) {
      console.warn("Could not list sessions:", error);
      return;
    }
    const known = new Set(metadataList.map((m) => m.path));
    for (const stale of Object.keys(this.index)) {
      if (!known.has(stale)) delete this.index[stale];
    }
    for (const metadata of metadataList) {
      if (this.index[metadata.path]) continue;
      try {
        const session = await this.repo.open(metadata);
        this.index[metadata.path] = {
          id: metadata.id,
          title: (await session.getSessionName()) ?? UNTITLED,
          updatedAt: metadata.createdAt,
          messageCount: (await session.getSessionStats()).messageCount,
        };
      } catch (error) {
        console.warn(`Could not index session ${metadata.path}:`, error);
      }
    }
    this.saveIndex();
  }

  list(): SessionSummary[] {
    return Object.entries(this.index)
      .map(([sessionPath, entry]) => ({ path: sessionPath, ...entry }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(cwd: string): Promise<Session<JsonlSessionMetadata>> {
    const session = await this.repo.create({ cwd });
    const metadata = await session.getMetadata();
    this.index[metadata.path] = {
      id: metadata.id,
      title: UNTITLED,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    };
    this.saveIndex();
    return session;
  }

  async open(sessionPath: string): Promise<Session<JsonlSessionMetadata>> {
    const metadata = await loadJsonlSessionMetadata(this.fs, sessionPath);
    return this.repo.open(metadata);
  }

  async delete(sessionPath: string): Promise<void> {
    try {
      const metadata = await loadJsonlSessionMetadata(this.fs, sessionPath);
      await this.repo.delete(metadata);
    } catch (error) {
      console.warn("Could not delete session file:", error);
    }
    delete this.index[sessionPath];
    this.saveIndex();
  }

  /** Persist a title both in the session transcript and in the sidebar index. */
  async rename(
    sessionPath: string,
    title: string,
    session?: Session<JsonlSessionMetadata>,
  ): Promise<void> {
    const trimmed = title.trim().slice(0, 80) || UNTITLED;
    const entry = this.index[sessionPath];
    if (entry) {
      entry.title = trimmed;
      entry.updatedAt = new Date().toISOString();
      this.saveIndex();
    }
    try {
      const target = session ?? (await this.open(sessionPath));
      await target.appendSessionName(trimmed);
    } catch (error) {
      console.warn("Could not persist session name:", error);
    }
  }

  hasTitle(sessionPath: string): boolean {
    const entry = this.index[sessionPath];
    return Boolean(entry && entry.title !== UNTITLED);
  }

  touch(sessionPath: string, messageCount: number): void {
    const entry = this.index[sessionPath];
    if (!entry) return;
    entry.updatedAt = new Date().toISOString();
    entry.messageCount = messageCount;
    this.saveIndex();
  }
}

/** Derive a sidebar title from the first thing the user said. */
export function titleFromPrompt(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= 60) return firstLine || UNTITLED;
  return `${firstLine.slice(0, 57)}…`;
}
