/**
 * AGENTS.md project instructions, loaded once when a chat opens.
 *
 * Common practice (Claude Code's CLAUDE.md, Codex's AGENTS.md): the file is
 * read by the app when the workspace is chosen and injected as a standing
 * section of the system prompt — the model never has to remember to read it.
 * A chain is supported: the git root's AGENTS.md applies repo-wide, and files
 * in directories between the root and the workspace add more specific rules.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Per-file cap so a bloated AGENTS.md can't eat the context window. */
const MAX_CHARS_PER_FILE = 12_000;

function readAgentsFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) return null;
    return text.length > MAX_CHARS_PER_FILE
      ? `${text.slice(0, MAX_CHARS_PER_FILE)}\n[…truncated]`
      : text;
  } catch {
    return null;
  }
}

/**
 * Nearest directory at or above `start` that contains a `.git` entry. Stops
 * at the filesystem root. Returns null outside any repository.
 */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * AGENTS.md chain for a workspace: root file first (broadest), then one entry
 * per directory down to the workspace (most specific). With no git root, only
 * the workspace's own file applies — walking to / would pull in unrelated
 * instructions from random parent folders.
 */
export function loadAgentsInstructions(workspace: string): string | null {
  let root: string;
  let resolvedWorkspace: string;
  try {
    // Canonicalize so symlinked workspaces compare cleanly against the root.
    resolvedWorkspace = realpathSync(workspace);
    root = findProjectRoot(resolvedWorkspace) ?? resolvedWorkspace;
  } catch {
    return null;
  }

  const chain: string[] = [root];
  const relative = path.relative(root, resolvedWorkspace);
  if (relative && relative !== "." && !relative.startsWith("..")) {
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      chain.push(current);
    }
  }

  const sections: string[] = [];
  for (const dir of chain) {
    const filePath = path.join(dir, "AGENTS.md");
    const text = readAgentsFile(filePath);
    if (text) {
      const label = path.relative(resolvedWorkspace, filePath) || "AGENTS.md";
      sections.push(`### ${label}\n\n${text}`);
    }
  }
  if (sections.length === 0) return null;

  return [
    "## Project instructions (AGENTS.md)",
    "",
    "Instructions from this workspace, loaded automatically when the chat opened.",
    "Follow them for everything you do here; deeper files override broader ones.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}
