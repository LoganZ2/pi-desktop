import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { FileChange } from "../shared/ipc.js";

interface FileState {
  exists: boolean;
  content?: Buffer;
  hash?: string;
}

interface JournalEntry {
  absolutePath: string;
  displayPath: string;
  before: FileState;
  after?: FileState;
}

interface GitSnapshot {
  root: string;
  beforeTree: string;
  indexDir: string;
  indexFile: string;
}

const MAX_GIT_OUTPUT = 128 * 1024 * 1024;

function git(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, ...extraEnv },
        encoding: "buffer",
        maxBuffer: MAX_GIT_OUTPUT,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr).trim();
          reject(new Error(detail || error.message, { cause: error }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readState(filePath: string): FileState {
  if (!existsSync(filePath)) return { exists: false };
  const info = lstatSync(filePath);
  if (!info.isFile() && !info.isSymbolicLink()) return { exists: true };
  const content = readFileSync(filePath);
  return { exists: true, content, hash: hash(content) };
}

function statesEqual(a: FileState, b: FileState): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.hash === b.hash;
}

function displayPath(workspace: string, absolutePath: string): string {
  const relative = path.relative(workspace, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

async function createGitSnapshot(workspace: string): Promise<GitSnapshot | undefined> {
  try {
    const root = (await git(workspace, ["rev-parse", "--show-toplevel"]))
      .toString("utf8")
      .trim();
    if (!root) return undefined;
    const indexDir = mkdtempSync(path.join(os.tmpdir(), "pi-desktop-checkpoint-"));
    const indexFile = path.join(indexDir, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    await git(root, ["read-tree", "--empty"], env);
    await git(root, ["add", "-A", "--", "."], env);
    const beforeTree = (await git(root, ["write-tree"], env)).toString("utf8").trim();
    return { root, beforeTree, indexDir, indexFile };
  } catch (error) {
    console.warn("Could not create Git turn checkpoint; falling back to file-tool tracking:", error);
    return undefined;
  }
}

function parseGitChanges(statusOutput: Buffer, numstatOutput: Buffer): FileChange[] {
  const stats = new Map<string, { addedLines?: number; removedLines?: number }>();
  for (const record of numstatOutput.toString("utf8").split("\0")) {
    if (!record) continue;
    const [added, removed, filePath] = record.split("\t");
    if (!filePath) continue;
    stats.set(filePath, {
      addedLines: added === "-" ? undefined : Number(added),
      removedLines: removed === "-" ? undefined : Number(removed),
    });
  }

  const tokens = statusOutput.toString("utf8").split("\0").filter(Boolean);
  const changes: FileChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i];
    const filePath = tokens[i + 1];
    const lineStats = stats.get(filePath) ?? {};
    changes.push({
      path: filePath,
      status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
      ...lineStats,
    });
  }
  return changes;
}

export interface FinishedTurnCheckpoint {
  files: FileChange[];
  undo(): Promise<void>;
}

/**
 * Captures one agent turn. Git workspaces get a full tracked/untracked snapshot;
 * edit/write tool paths are journaled as a fallback and to cover ignored files.
 */
export class TurnCheckpoint {
  private readonly journal = new Map<string, JournalEntry>();
  private finished = false;

  private constructor(
    private readonly workspace: string,
    private readonly toolContext: ExecutionToolContext,
    private readonly gitSnapshot?: GitSnapshot,
  ) {}

  static async begin(
    workspace: string,
    toolContext: ExecutionToolContext,
  ): Promise<TurnCheckpoint> {
    return new TurnCheckpoint(workspace, toolContext, await createGitSnapshot(workspace));
  }

  async captureToolPath(inputPath: string): Promise<void> {
    if (this.finished) return;
    const normalized = inputPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    const addressed = normalized.startsWith("@") ? normalized.slice(1) : normalized;
    const result = await this.toolContext.env.absolutePath(addressed);
    if (!result.ok || this.journal.has(result.value)) return;
    try {
      const before = readState(result.value);
      // Directories are not mutated by the built-in edit/write tools.
      if (before.exists && before.hash === undefined) return;
      this.journal.set(result.value, {
        absolutePath: result.value,
        displayPath: displayPath(this.workspace, result.value),
        before,
      });
    } catch (error) {
      console.warn(`Could not checkpoint ${result.value}:`, error);
    }
  }

  async finish(): Promise<FinishedTurnCheckpoint | undefined> {
    if (this.finished) return undefined;
    this.finished = true;

    let gitPatch: Buffer | undefined;
    let gitRoot: string | undefined;
    let gitChanges: FileChange[] = [];
    const gitChangedPaths = new Set<string>();

    if (this.gitSnapshot) {
      const snapshot = this.gitSnapshot;
      const env = { GIT_INDEX_FILE: snapshot.indexFile };
      try {
        await git(snapshot.root, ["read-tree", "--empty"], env);
        await git(snapshot.root, ["add", "-A", "--", "."], env);
        const afterTree = (await git(snapshot.root, ["write-tree"], env)).toString("utf8").trim();
        const [status, numstat, patch] = await Promise.all([
          git(snapshot.root, ["diff", "--name-status", "--no-renames", "-z", snapshot.beforeTree, afterTree]),
          git(snapshot.root, ["diff", "--numstat", "--no-renames", "-z", snapshot.beforeTree, afterTree]),
          git(snapshot.root, ["diff", "--binary", "--full-index", "--no-renames", afterTree, snapshot.beforeTree]),
        ]);
        gitChanges = parseGitChanges(status, numstat);
        for (const change of gitChanges) gitChangedPaths.add(path.resolve(snapshot.root, change.path));
        if (patch.length > 0) {
          gitPatch = patch;
          gitRoot = snapshot.root;
        }
      } catch (error) {
        console.warn("Could not finish Git turn checkpoint:", error);
      } finally {
        rmSync(snapshot.indexDir, { recursive: true, force: true });
      }
    }

    const journalChanges: FileChange[] = [];
    for (const entry of this.journal.values()) {
      try {
        entry.after = readState(entry.absolutePath);
      } catch (error) {
        console.warn(`Could not inspect ${entry.absolutePath} after the turn:`, error);
        continue;
      }
      if (statesEqual(entry.before, entry.after) || gitChangedPaths.has(entry.absolutePath)) continue;
      journalChanges.push({
        path: entry.displayPath,
        status: !entry.before.exists ? "added" : !entry.after.exists ? "deleted" : "modified",
      });
    }

    const files = [...gitChanges, ...journalChanges].sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) return undefined;

    let used = false;
    return {
      files,
      undo: async () => {
        if (used) throw new Error("These changes have already been undone");

        // Validate every fallback file before mutating anything.
        for (const entry of this.journal.values()) {
          if (!entry.after || gitChangedPaths.has(entry.absolutePath)) continue;
          const current = readState(entry.absolutePath);
          if (!statesEqual(current, entry.after)) {
            throw new Error(`${entry.displayPath} changed after the response finished`);
          }
        }

        let patchFile: string | undefined;
        if (gitPatch && gitRoot) {
          const patchDir = mkdtempSync(path.join(os.tmpdir(), "pi-desktop-undo-"));
          patchFile = path.join(patchDir, "restore.patch");
          writeFileSync(patchFile, gitPatch);
          try {
            await git(gitRoot, ["apply", "--check", "--whitespace=nowarn", patchFile]);
          } catch (error) {
            rmSync(patchDir, { recursive: true, force: true });
            throw new Error("Workspace files changed after the response finished", { cause: error });
          }
        }

        if (patchFile && gitRoot) {
          const patchDir = path.dirname(patchFile);
          try {
            await git(gitRoot, ["apply", "--whitespace=nowarn", patchFile]);
          } finally {
            rmSync(patchDir, { recursive: true, force: true });
          }
        }

        for (const entry of this.journal.values()) {
          if (!entry.after || gitChangedPaths.has(entry.absolutePath)) continue;
          if (entry.before.exists && entry.before.content) {
            const result = await this.toolContext.env.writeFile(entry.absolutePath, entry.before.content);
            if (!result.ok) throw new Error(`Could not restore ${entry.displayPath}: ${result.error.message}`);
          } else if (!entry.before.exists) {
            const result = await this.toolContext.env.remove(entry.absolutePath, { force: true });
            if (!result.ok) throw new Error(`Could not remove ${entry.displayPath}: ${result.error.message}`);
          }
        }
        used = true;
      },
    };
  }
}
