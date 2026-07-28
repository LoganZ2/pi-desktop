import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ProjectNameCheck } from "../shared/ipc.js";

/** Characters that are illegal or dangerous in a folder name on any platform. */
const ILLEGAL = /[\\/:*?"<>|]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;
/** Names Windows refuses, rejected here so projects stay portable. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LENGTH = 64;

/**
 * Validate a project name and report where it would live. Pure except for the
 * existence check, so the renderer can call it on every keystroke.
 */
export function checkProjectName(name: string, projectsRoot: string): ProjectNameCheck {
  const trimmed = name.trim();
  const target = path.join(projectsRoot, trimmed);
  const fail = (error: string): ProjectNameCheck => ({ valid: false, path: target, error });

  if (!trimmed) return { valid: false, path: projectsRoot, error: "" };
  if (trimmed.length > MAX_LENGTH) return fail(`Keep it under ${MAX_LENGTH} characters.`);
  if (ILLEGAL.test(trimmed) || CONTROL.test(trimmed)) {
    return fail('A name cannot contain \\ / : * ? " < > |');
  }
  if (trimmed.startsWith(".")) return fail("A name cannot start with a dot.");
  if (trimmed.endsWith(".") || trimmed.endsWith(" ")) {
    return fail("A name cannot end with a dot or space.");
  }
  if (RESERVED.test(trimmed)) return fail("That name is reserved by the operating system.");
  if (existsSync(target)) return fail("A project with that name already exists.");

  return { valid: true, path: target };
}

/** Create the project folder, re-validating so IPC callers cannot bypass the rules. */
export function createProject(name: string, projectsRoot: string): string {
  const check = checkProjectName(name, projectsRoot);
  if (!check.valid) throw new Error(check.error || "Enter a project name.");
  mkdirSync(check.path, { recursive: true });
  return check.path;
}
