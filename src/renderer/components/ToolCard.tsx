import { useState, type ReactNode } from "react";
import type { ApprovalRequest, ChatBlock, ChatMessage } from "../../shared/ipc.js";
import {
  IconCheck,
  IconFile,
  IconGlobe,
  IconPencil,
  IconSpinner,
  IconTerminal,
  IconX,
} from "../lib/icons.js";
import { cx } from "./ui.js";

export interface ToolRun {
  status: "running" | "done" | "error";
  output: string;
  details?: unknown;
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => (block as ChatBlock)?.type === "text")
      .map((block) => (block as ChatBlock).text ?? "")
      .join("\n");
  }
  return "";
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

// ---------- bash ----------

function BashBody({ command, output, isError }: { command: string; output: string; isError: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
      <div className="flex gap-2 border-b border-ink-800 px-3 py-2 font-mono text-[12px]">
        <span className="shrink-0 text-jade-400 select-none">$</span>
        <span className="whitespace-pre-wrap text-mist-200">{command}</span>
      </div>
      {output.trim() ? (
        <pre
          className={cx(
            "max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap",
            isError ? "text-rose-soft" : "text-mist-400",
          )}
        >
          {output}
        </pre>
      ) : (
        <p className="px-3 py-2 font-mono text-[11.5px] text-mist-600">(no output)</p>
      )}
    </div>
  );
}

// ---------- read ----------

function ReadBody({ path, offset, output }: { path: string; offset?: number; output: string }) {
  // pi appends a "[Showing lines …]" note after the file body; keep it separate.
  const noteMatch = output.match(/\n*\[(Showing lines[^\]]*|Line \d+ is[^\]]*)\]\s*$/);
  const note = noteMatch?.[1];
  const body = note ? output.slice(0, noteMatch.index) : output;
  const lines = body.replace(/\n$/, "").split("\n");
  const start = offset && offset > 0 ? offset : 1;
  const gutter = String(start + lines.length - 1).length;

  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-1.5 font-mono text-[11.5px] text-mist-400">
        <IconFile className="h-3 w-3 shrink-0" />
        <span className="truncate">{path}</span>
        <span className="ml-auto shrink-0 text-mist-600">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="max-h-72 overflow-auto">
        <pre className="px-3 py-2 font-mono text-[11.5px] leading-relaxed">
          {lines.map((line, index) => (
            <div key={index} className="flex gap-3">
              <span
                className="shrink-0 text-right text-mist-600 select-none"
                style={{ width: `${gutter}ch` }}
              >
                {start + index}
              </span>
              <span className="whitespace-pre-wrap text-mist-300">{line || " "}</span>
            </div>
          ))}
        </pre>
      </div>
      {note && <p className="border-t border-ink-800 px-3 py-1.5 text-[11px] text-mist-500">{note}</p>}
    </div>
  );
}

// ---------- web fetch ----------

interface FetchHeader {
  status: number;
  statusText: string;
  contentType: string;
  redirectedTo?: string;
}

/** The tool's model output starts with "HTTP <status> <text> · <type> [· redirected to <url>]". */
function parseFetchHeader(output: string): { header?: FetchHeader; body: string } {
  const divider = output.indexOf("\n" + "—".repeat(24) + "\n");
  if (divider === -1) return { body: output };
  const firstLine = output.slice(0, divider);
  const body = output.slice(divider + 27);
  const match = firstLine.match(/^HTTP (\d+) ([^·]*?)(?: · ([^·]*?))?(?: · redirected to (.+))?$/);
  if (!match) return { body: output };
  return {
    header: {
      status: Number(match[1]),
      statusText: match[2].trim(),
      contentType: (match[3] ?? "").trim(),
      redirectedTo: match[4],
    },
    body,
  };
}

function statusTone(status: number): string {
  if (status >= 500) return "text-rose-soft";
  if (status >= 400) return "text-amber-soft";
  if (status >= 300) return "text-iris-400";
  return "text-jade-400";
}

function FetchBody({
  url,
  method,
  output,
  isError,
}: {
  url: string;
  method: string;
  output: string;
  isError: boolean;
}) {
  const { header, body } = isError ? { body: output } : parseFetchHeader(output);
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2 font-mono text-[12px]">
        <span className="shrink-0 rounded border border-iris-400/40 px-1.5 py-0.5 text-[10.5px] font-semibold text-iris-400">
          {method}
        </span>
        <span className="min-w-0 truncate text-mist-200">{url}</span>
      </div>
      {header && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 px-3 py-1.5 font-mono text-[11px]">
          <span className={cx("font-semibold", statusTone(header.status))}>
            {header.status} {header.statusText}
          </span>
          {header.contentType && <span className="text-mist-500">{header.contentType}</span>}
          {header.redirectedTo && (
            <span className="min-w-0 truncate text-mist-500">→ {header.redirectedTo}</span>
          )}
        </div>
      )}
      {body.trim() ? (
        <pre
          className={cx(
            "max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap",
            isError ? "text-rose-soft" : "text-mist-400",
          )}
        >
          {body.length > 20_000 ? `${body.slice(0, 20_000)}\n… (truncated)` : body}
        </pre>
      ) : (
        !isError && <p className="px-3 py-2 font-mono text-[11.5px] text-mist-600">(empty body)</p>
      )}
    </div>
  );
}

// ---------- diffs (edit / write) ----------

interface DiffRow {
  kind: "add" | "remove" | "context" | "skip";
  lineNumber?: string;
  text: string;
}

/**
 * pi's edit tool returns a display diff shaped `[+- ]<lineNo> <text>`, with
 * ` <blank> ...` marking skipped context.
 */
export function parseDiff(diff: string): DiffRow[] {
  return diff.split("\n").map((line) => {
    const marker = line[0];
    const rest = line.slice(1);
    const match = rest.match(/^(\s*\d+|\s+) (.*)$/s);
    const lineNumber = match?.[1]?.trim();
    const text = match ? match[2] : rest;
    if (text === "..." && !lineNumber) return { kind: "skip", text: "⋯" };
    if (marker === "+") return { kind: "add", lineNumber, text };
    if (marker === "-") return { kind: "remove", lineNumber, text };
    return { kind: "context", lineNumber, text };
  });
}

function DiffView({ rows }: { rows: DiffRow[] }) {
  const gutter = Math.max(2, ...rows.map((r) => (r.lineNumber ?? "").length));
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-ink-800 bg-ink-950">
      <pre className="py-1 font-mono text-[11.5px] leading-relaxed">
        {rows.map((row, index) => {
          if (row.kind === "skip") {
            return (
              <div key={index} className="px-3 py-0.5 text-center text-mist-600 select-none">
                {row.text}
              </div>
            );
          }
          const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
          return (
            <div
              key={index}
              className={cx(
                "flex gap-2 px-3",
                row.kind === "add" && "bg-jade-400/10",
                row.kind === "remove" && "bg-rose-soft/10",
              )}
            >
              <span
                className="shrink-0 text-right text-mist-600 select-none"
                style={{ width: `${gutter}ch` }}
              >
                {row.lineNumber ?? ""}
              </span>
              <span
                className={cx(
                  "shrink-0 select-none",
                  row.kind === "add" && "text-jade-400",
                  row.kind === "remove" && "text-rose-soft",
                  row.kind === "context" && "text-mist-600",
                )}
              >
                {sign}
              </span>
              <span
                className={cx(
                  "whitespace-pre-wrap",
                  row.kind === "add" && "text-jade-400",
                  row.kind === "remove" && "text-rose-soft",
                  row.kind === "context" && "text-mist-400",
                )}
              >
                {row.text || " "}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.kind === "add").length,
    removed: rows.filter((r) => r.kind === "remove").length,
  };
}

/** A written file has no prior content, so render it as an all-added diff. */
function contentAsAddedRows(content: string): DiffRow[] {
  return content.replace(/\n$/, "").split("\n").map((text, index) => ({
    kind: "add" as const,
    lineNumber: String(index + 1),
    text,
  }));
}

// ---------- card ----------

const TOOL_ICON: Record<string, typeof IconTerminal> = {
  bash: IconTerminal,
  read: IconFile,
  write: IconFile,
  edit: IconPencil,
  web_fetch: IconGlobe,
};

interface ToolCardProps {
  call: ChatBlock;
  run?: ToolRun;
  result?: ChatMessage;
  approval?: ApprovalRequest;
  onApprove: (approvalId: string, allow: boolean, always: boolean) => void;
}

export function ToolCard({ call, run, result, approval, onApprove }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const name = call.name ?? "tool";
  const args = (call.arguments ?? {}) as Record<string, any>;
  const Icon = TOOL_ICON[name] ?? IconTerminal;

  const isError = result?.isError === true || run?.status === "error";
  const finished = Boolean(result) || run?.status === "done" || run?.status === "error";
  const output = result ? contentToText(result.content) : (run?.output ?? "");
  const details = (result?.details ?? run?.details) as { diff?: string } | undefined;
  const waiting = Boolean(approval);

  const diffRows =
    name === "edit" && typeof details?.diff === "string"
      ? parseDiff(details.diff)
      : name === "write" && typeof args.content === "string"
        ? contentAsAddedRows(args.content)
        : undefined;
  const stats = diffRows ? diffStats(diffRows) : undefined;

  // A one-line summary that reads like a sentence rather than JSON.
  const summary = (() => {
    if (name === "bash") return String(args.command ?? "");
    if (name === "web_fetch") {
      const method = String(args.method ?? "GET").toUpperCase();
      return method === "GET" ? String(args.url ?? "") : `${method} ${String(args.url ?? "")}`;
    }
    if (typeof args.path === "string") {
      const range =
        name === "read" && args.offset ? ` :${args.offset}${args.limit ? `-${args.offset + args.limit - 1}` : "+"}` : "";
      return shortPath(args.path) + range;
    }
    return JSON.stringify(args);
  })();

  const status = waiting
    ? { label: "needs approval", tone: "text-amber-soft border-amber-soft/40" }
    : isError
      ? { label: "failed", tone: "text-rose-soft border-rose-soft/40" }
      : finished
        ? { label: "done", tone: "text-jade-400 border-jade-400/40" }
        : { label: "running", tone: "text-amber-soft border-amber-soft/40" };

  const body: ReactNode = (() => {
    if (diffRows) return <DiffView rows={diffRows} />;
    if (name === "bash") {
      return <BashBody command={String(args.command ?? "")} output={output} isError={isError} />;
    }
    if (name === "web_fetch") {
      return (
        <FetchBody
          url={String(args.url ?? "")}
          method={String(args.method ?? "GET").toUpperCase()}
          output={output}
          isError={isError}
        />
      );
    }
    if (name === "read" && !isError && output) {
      return <ReadBody path={String(args.path ?? "")} offset={args.offset} output={output} />;
    }
    return (
      <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
        {Object.keys(args).length > 0 && (
          <pre className="border-b border-ink-800 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-iris-400">
            {JSON.stringify(args, null, 2)}
          </pre>
        )}
        {output && (
          <pre
            className={cx(
              "max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap",
              isError ? "text-rose-soft" : "text-mist-400",
            )}
          >
            {output.length > 20_000 ? `${output.slice(0, 20_000)}\n… (truncated)` : output}
          </pre>
        )}
      </div>
    );
  })();

  const showBody = expanded || (run?.status === "running" && Boolean(output)) || waiting;

  return (
    <div
      className={cx(
        "overflow-hidden rounded-xl border bg-ink-850/70 transition",
        waiting ? "border-amber-soft/40" : "border-ink-800",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-mist-400" />
        <span className="shrink-0 text-[12px] font-semibold text-mist-200">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-mist-400">{summary}</span>

        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
            {stats.added > 0 && <span className="text-jade-400">+{stats.added}</span>}
            {stats.removed > 0 && <span className="text-rose-soft">−{stats.removed}</span>}
          </span>
        )}

        <span
          className={cx(
            "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
            status.tone,
          )}
        >
          {!finished && !waiting && <IconSpinner className="h-2.5 w-2.5" />}
          {status.label}
        </span>
      </button>

      {showBody && <div className="px-2 pb-2">{body}</div>}

      {approval && (
        <div className="border-t border-amber-soft/30 bg-amber-soft/[0.06] px-3 py-2.5">
          <p className="text-[12px] text-amber-soft">
            {name === "web_fetch"
              ? "The agent wants to fetch this URL from the internet."
              : "The agent wants to run this shell command in your workspace."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onApprove(approval.approvalId, true, false)}
              className="flex items-center gap-1.5 rounded-lg border border-jade-400/40 px-2.5 py-1.5 text-[12px] font-medium text-jade-400 transition hover:bg-jade-400/10"
            >
              <IconCheck className="h-3.5 w-3.5" /> {name === "web_fetch" ? "Fetch once" : "Run once"}
            </button>
            <button
              type="button"
              onClick={() => onApprove(approval.approvalId, true, true)}
              className="rounded-lg border border-ink-600 px-2.5 py-1.5 text-[12px] font-medium text-mist-300 transition hover:bg-ink-750"
            >
              {name === "web_fetch" ? "Always fetch URLs" : "Always run commands"}
            </button>
            <button
              type="button"
              onClick={() => onApprove(approval.approvalId, false, false)}
              className="flex items-center gap-1.5 rounded-lg border border-rose-soft/40 px-2.5 py-1.5 text-[12px] font-medium text-rose-soft transition hover:bg-rose-soft/10"
            >
              <IconX className="h-3.5 w-3.5" /> Deny
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
