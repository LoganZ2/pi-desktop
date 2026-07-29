import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ApprovalRequest,
  ChatBlock,
  ChatMessage,
  CompactionNotice,
  TurnChangesNotice,
} from "../../shared/ipc.js";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevron,
  IconCompress,
  IconCopy,
  IconPencil,
  IconUndo,
  IconX,
} from "../lib/icons.js";
import { renderMarkdown } from "../lib/markdown.js";
import { ToolCard, contentToText, parseDiff, type ToolRun } from "./ToolCard.js";
import { Button, cx, formatTokens } from "./ui.js";

export { contentToText, type ToolRun };

function blocksOf(message: ChatMessage): ChatBlock[] {
  if (Array.isArray(message.content)) return message.content as ChatBlock[];
  return [{ type: "text", text: String(message.content ?? "") }];
}

function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div
      className={cx("prose-pi", className ?? "text-[14px] text-mist-200")}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  );
}

function ThinkingBlock({ text, defaultOpen }: { text: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!text.trim()) return null;
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium tracking-wide text-mist-500 uppercase transition hover:text-mist-300"
      >
        <IconChevron className={cx("h-3 w-3 transition", open ? "rotate-0" : "-rotate-90")} />
        Thinking
      </button>
      {open && (
        <div className="border-t border-ink-800 px-3 py-2.5">
          <Markdown source={text} className="text-[13px] text-mist-400" />
        </div>
      )}
    </div>
  );
}

function CompactionMarker({ notice }: { notice: CompactionNotice }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Older messages above were summarized to free up context. Click to read the summary the model keeps."
        className="group flex w-full items-center gap-3"
      >
        <span className="h-px flex-1 bg-ink-800" />
        <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-mist-500 uppercase transition group-hover:text-mist-300">
          <IconCompress className="h-3 w-3" />
          Context compacted · {formatTokens(notice.tokensBefore)} tokens summarized
          <IconChevron className={cx("h-3 w-3 transition", open ? "rotate-0" : "-rotate-90")} />
        </span>
        <span className="h-px flex-1 bg-ink-800" />
      </button>
      {open && (
        <div className="mt-3 rounded-xl border border-ink-800 bg-ink-900/60 px-3.5 py-3">
          <Markdown source={notice.summary} className="text-[13px] text-mist-400" />
        </div>
      )}
    </div>
  );
}

// ---------- status divider ----------

function StatusDivider({
  status,
  errorMessage,
}: {
  status: "generating" | "complete" | "aborted" | "error";
  errorMessage?: string;
}) {
  const [showError, setShowError] = useState(false);

  const config: Record<typeof status, { dot: string; label: string; tone: string }> = {
    generating: { dot: "●", label: "Generating…", tone: "text-iris-400" },
    complete: { dot: "✓", label: "Answer complete", tone: "text-jade-400/60" },
    aborted: { dot: "■", label: "Stopped", tone: "text-mist-500" },
    error: { dot: "!", label: "Generation failed", tone: "text-rose-soft/70" },
  };
  const { dot, label, tone } = config[status];
  const isGenerating = status === "generating";

  return (
    <div className="mt-2">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-ink-800" />
        <span
          className={cx(
            "flex items-center gap-2 text-[11px] font-medium tracking-wide select-none",
            tone,
            isGenerating && "animate-pulse-soft",
          )}
        >
          <span className="text-[11px]">{dot}</span> {label}
        </span>
        <span className="h-px flex-1 bg-ink-800" />
      </div>
      {status === "error" && (
        <div className="mt-2 text-center">
          {showError ? (
            <p className="text-[12px] text-rose-soft">{errorMessage || "An unknown error occurred"}</p>
          ) : (
            <button
              type="button"
              onClick={() => setShowError(true)}
              className="text-[11px] text-mist-500 hover:text-mist-300 underline transition"
            >
              Show details
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- inline user-message editor ----------

function InlineEditor({
  initialText,
  onSend,
  onCancel,
}: {
  initialText: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
  };

  return (
    <div className="w-full max-w-[80%] ml-auto rounded-2xl rounded-br-md border border-iris-500/35 bg-ink-900 px-3.5 py-3">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(8, text.split("\n").length + 1)}
        className="w-full resize-none bg-transparent text-[14px] text-mist-100 outline-none placeholder:text-mist-600"
        placeholder="Edit your message…"
      />
      <div className="mt-2.5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={send} disabled={!text.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}

// ---------- branch controls ----------

function BranchControls({
  branch,
  onSwitch,
}: {
  branch: NonNullable<ChatMessage["branch"]>;
  onSwitch: (targetId: string) => void;
}) {
  const canPrev = branch.index > 0;
  const canNext = branch.index < branch.count - 1;

  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] text-mist-600 select-none">
      <button
        type="button"
        disabled={!canPrev}
        onClick={() => canPrev && onSwitch(branch.targets[branch.index - 1])}
        className={cx(
          "rounded p-1 transition",
          canPrev ? "hover:bg-ink-800 hover:text-mist-200" : "opacity-30",
        )}
        title="Previous branch"
      >
        <IconArrowLeft className="h-3 w-3" />
      </button>
      <span className="min-w-[2ch] text-center font-mono tabular-nums text-[10.5px]">
        {branch.index + 1}&thinsp;/&thinsp;{branch.count}
      </span>
      <button
        type="button"
        disabled={!canNext}
        onClick={() => canNext && onSwitch(branch.targets[branch.index + 1])}
        className={cx(
          "rounded p-1 transition",
          canNext ? "hover:bg-ink-800 hover:text-mist-200" : "opacity-30",
        )}
        title="Next branch"
      >
        <IconArrowRight className="h-3 w-3" />
      </button>
    </span>
  );
}

// ---------- turn changes card ----------

function TurnChangesCard({
  notice,
  onUndo,
}: {
  notice: TurnChangesNotice;
  onUndo: (turnId: string) => void;
}) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  if (notice.files.length === 0) return null;

  const maxBeforeFold = 5;
  const visibleFiles = expandedFile
    ? notice.files
    : notice.files.slice(0, maxBeforeFold);
  const hiddenCount = notice.files.length - visibleFiles.length;

  return (
    <div className="mt-3 animate-fade-up overflow-hidden rounded-xl border border-ink-800 bg-ink-850/60">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12px] text-mist-400">
          {notice.files.length} file{notice.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="flex-1" />
        {notice.undone ? (
          <span className="rounded-full border border-mist-700 px-2 py-0.5 text-[10.5px] text-mist-500">
            Undone
          </span>
        ) : notice.canUndo ? (
          <button
            type="button"
            onClick={() => onUndo(notice.turnId)}
            className="flex items-center gap-1 rounded-lg border border-ink-600 px-2 py-1 text-[11px] text-mist-300 transition hover:border-amber-soft/40 hover:text-amber-soft"
          >
            <IconUndo className="h-3 w-3" />
            Undo changes
          </button>
        ) : (
          <span className="text-[11px] text-mist-600">Historical changes</span>
        )}
      </div>

      <div className="border-t border-ink-800">
        {visibleFiles.map((file) => {
          const isExpanded = expandedFile === file.path;
          return (
            <div key={file.path}>
              <button
                type="button"
                onClick={() => setExpandedFile(isExpanded ? null : file.path)}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-mono text-[11.5px] transition hover:bg-ink-800/50"
              >
                <span
                  className={cx(
                    "w-4 shrink-0 text-center text-[10px] font-semibold",
                    file.status === "added"
                      ? "text-jade-400"
                      : file.status === "deleted"
                        ? "text-rose-soft"
                        : "text-mist-400",
                  )}
                >
                  {file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}
                </span>
                <span className="min-w-0 flex-1 truncate text-mist-300">{file.path}</span>
                {(file.addedLines !== undefined || file.removedLines !== undefined) && (
                  <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px]">
                    {file.addedLines !== undefined && file.addedLines > 0 && (
                      <span className="text-jade-400">+{file.addedLines}</span>
                    )}
                    {file.removedLines !== undefined && file.removedLines > 0 && (
                      <span className="text-rose-soft">−{file.removedLines}</span>
                    )}
                  </span>
                )}
                <IconChevron
                  className={cx(
                    "h-3 w-3 shrink-0 text-mist-600 transition",
                    isExpanded && "rotate-180",
                  )}
                />
              </button>
              {isExpanded && <FileChangePreview path={file.path} status={file.status} />}
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpandedFile("__show_all")}
            className="w-full px-3 py-1.5 text-left text-[11px] text-mist-500 transition hover:text-mist-300"
          >
            Show {hiddenCount} more file{hiddenCount === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </div>
  );
}

function FileChangePreview({ path, status }: { path: string; status: string }) {
  if (status === "deleted") {
    return (
      <div className="border-t border-ink-800 px-3 py-2 text-[11.5px] text-mist-500">
        File was deleted.
      </div>
    );
  }
  // A full diff preview would need the file content stored in the checkpoint.
  // For now show that it was added/modified.
  return (
    <div className="border-t border-ink-800 px-3 py-2 text-[11.5px] text-mist-500">
      {status === "added" ? "File was created." : "File was modified."}
    </div>
  );
}

// ---------- user message bubble with controls ----------

function UserMessage({
  message,
  onEdit,
  onSwitchBranch,
  editing,
  onEditingChange,
}: {
  message: ChatMessage;
  onEdit: (entryId: string, text: string) => void;
  onSwitchBranch: (targetId: string) => void;
  editing: string | null;
  onEditingChange: (entryId: string | null) => void;
}) {
  const text = contentToText(message.content) || String(message.content ?? "");
  const isEditing = editing === message.entryId;
  const [copied, setCopied] = useState(false);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      console.error("Could not copy message:", error);
    }
  };

  return (
    <div
      className={cx(
        "group ml-auto flex flex-col items-end",
        isEditing ? "w-full" : "w-fit max-w-[80%]",
      )}
    >
      {isEditing ? (
        <InlineEditor
          initialText={text}
          onSend={(newText) => {
            onEditingChange(null);
            if (message.entryId) onEdit(message.entryId, newText);
          }}
          onCancel={() => onEditingChange(null)}
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl rounded-br-md border border-iris-500/25 bg-iris-600/15 px-3.5 py-2.5 text-[14px] whitespace-pre-wrap break-words text-mist-100">
            {text}
          </div>
          {/* Keep the action row in normal flow so it has a stable hover target
              and never overlaps the following assistant content. */}
          <div
            className={cx(
              "mt-0.5 flex h-5 items-center gap-1 transition",
              message.branch && message.branch.count > 1
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            <button
              type="button"
              title={copied ? "Copied" : "Copy"}
              onClick={() => void copyMessage()}
              className={cx(
                "rounded p-1 transition hover:bg-ink-800 hover:text-mist-200",
                copied ? "text-jade-400" : "text-mist-600",
              )}
            >
              <IconCopy className="h-3 w-3" />
            </button>
            {message.entryId && (
              <button
                type="button"
                title="Edit"
                onClick={() => onEditingChange(message.entryId ?? null)}
                className="rounded p-1 text-mist-600 transition hover:bg-ink-800 hover:text-mist-200"
              >
                <IconPencil className="h-3 w-3" />
              </button>
            )}
            {message.branch && message.branch.count > 1 && (
              <BranchControls branch={message.branch} onSwitch={onSwitchBranch} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- main transcript ----------

type ItemKind = "user" | "text" | "thinking" | "tool" | "error" | "compaction" | "turn-changes" | "status";
interface Item {
  key: string;
  kind: ItemKind;
  node: ReactNode;
}

function spacingFor(previous: ItemKind | undefined, current: ItemKind): string {
  if (!previous) return "";
  if (previous === "tool" && current === "tool") return "mt-1.5";
  if (previous === "compaction" || current === "compaction") return "mt-6";
  if (previous === "status" || current === "status") return "";
  if (current === "user") return "mt-6";
  if (current === "turn-changes") return "mt-2";
  return "mt-4";
}

interface TranscriptProps {
  messages: ChatMessage[];
  compactions: CompactionNotice[];
  turnChanges: TurnChangesNotice[];
  streaming: ChatMessage | null;
  isStreaming: boolean;
  toolRuns: Record<string, ToolRun>;
  approvals: Record<string, ApprovalRequest>;
  autoExpandThinking: boolean;
  onApprove: (approvalId: string, allow: boolean, always: boolean) => void;
  onEditMessage: (entryId: string, text: string) => void;
  onSwitchBranch: (targetId: string) => void;
  onUndoChanges: (turnId: string) => void;
}

export function Transcript({
  messages,
  compactions,
  turnChanges,
  streaming,
  isStreaming,
  toolRuns,
  approvals,
  autoExpandThinking,
  onApprove,
  onEditMessage,
  onSwitchBranch,
  onUndoChanges,
}: TranscriptProps) {
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const locked = useRef(false);
  const scrollRaf = useRef<number>(0);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const dist = node.scrollHeight - node.scrollTop - node.clientHeight;
      pinned.current = dist < 36;
      if (dist <= 2) locked.current = false;
      else if (dist > 36) locked.current = true;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!pinned.current || locked.current || !scrollRef.current) return;
    cancelAnimationFrame(scrollRaf.current);
    const node = scrollRef.current;
    scrollRaf.current = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, [messages, streaming, isStreaming, toolRuns, approvals]);

  const results = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      results.set(message.toolCallId, message);
    }
  }

  // Build rows: messages + compaction markers
  type Row =
    | { kind: "message"; message: ChatMessage }
    | { kind: "compaction"; notice: CompactionNotice };
  const sortedNotices = [...compactions].sort((a, b) => a.afterMessageCount - b.afterMessageCount);
  const rows: Row[] = [];
  let noticeIndex = 0;
  messages.forEach((message, index) => {
    while (
      noticeIndex < sortedNotices.length &&
      sortedNotices[noticeIndex].afterMessageCount <= index
    ) {
      rows.push({ kind: "compaction", notice: sortedNotices[noticeIndex++] });
    }
    if (message.role !== "toolResult") rows.push({ kind: "message", message });
  });
  while (noticeIndex < sortedNotices.length) {
    rows.push({ kind: "compaction", notice: sortedNotices[noticeIndex++] });
  }

  // Turn changes indexed by turnId (user message entryId)
  const changesByTurnId = new Map(turnChanges.map((change) => [change.turnId, change]));

  // Detect last assistant message to determine status
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  let status: "generating" | "complete" | "aborted" | "error" = "complete";
  let statusError: string | undefined;
  if (isStreaming) {
    status = "generating";
  } else if (lastAssistant) {
    if (lastAssistant.stopReason === "aborted") status = "aborted";
    else if (lastAssistant.errorMessage) {
      status = "error";
      statusError = lastAssistant.errorMessage;
    }
  } else if (messages.length > 0) {
    // Messages exist but no assistant message yet — likely aborted before first response
    status = "aborted";
  }

  // Flatten to items
  const items: Item[] = [];
  let lastUserMessage: ChatMessage | undefined;

  rows.forEach((row, rowIndex) => {
    if (row.kind === "compaction") {
      items.push({
        key: `compaction-${row.notice.id}`,
        kind: "compaction",
        node: <CompactionMarker notice={row.notice} />,
      });
      return;
    }
    const message = row.message;
    const base = `${rowIndex}-${message.timestamp ?? ""}`;

    if (message.role === "user") {
      // Before the new user, if the previous turn had changes, inject them
      if (lastUserMessage?.entryId) {
        const change = changesByTurnId.get(lastUserMessage.entryId);
        if (change) {
          items.push({
            key: `changes-${change.turnId}`,
            kind: "turn-changes",
            node: <TurnChangesCard notice={change} onUndo={onUndoChanges} />,
          });
        }
      }
      lastUserMessage = message;

      items.push({
        key: `${base}-user`,
        kind: "user",
        node: (
          <UserMessage
            message={message}
            onEdit={onEditMessage}
            onSwitchBranch={onSwitchBranch}
            editing={editingEntryId}
            onEditingChange={setEditingEntryId}
          />
        ),
      });
      return;
    }
    if (message.role !== "assistant") return;

    blocksOf(message).forEach((block, blockIndex) => {
      const key = `${base}-${blockIndex}`;
      if (block.type === "thinking") {
        const text = String(block.thinking ?? "");
        if (!text.trim()) return;
        items.push({
          key,
          kind: "thinking",
          node: <ThinkingBlock text={text} defaultOpen={autoExpandThinking} />,
        });
      } else if (block.type === "text") {
        const text = String(block.text ?? "");
        if (!text.trim()) return;
        items.push({ key, kind: "text", node: <Markdown source={text} /> });
      } else if (block.type === "toolCall") {
        const id = String(block.id ?? key);
        items.push({
          key: id,
          kind: "tool",
          node: (
            <ToolCard
              call={block}
              run={toolRuns[id]}
              result={results.get(id)}
              approval={approvals[id]}
              onApprove={onApprove}
            />
          ),
        });
      }
    });
  });

  // Inject changes after the last user before streaming
  if (lastUserMessage?.entryId && !streaming) {
    const change = changesByTurnId.get(lastUserMessage.entryId);
    if (change) {
      items.push({
        key: `changes-${change.turnId}`,
        kind: "turn-changes",
        node: <TurnChangesCard notice={change} onUndo={onUndoChanges} />,
      });
    }
  }

  // Add status divider at the end
  if (rows.length > 0 || streaming) {
    items.push({
      key: "status-divider",
      kind: "status",
      node: <StatusDivider status={status} errorMessage={statusError} />,
    });
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 pt-8 pb-1">
        {items.map((item, index) => (
          <div
            key={item.key}
            className={cx("animate-fade-up", spacingFor(items[index - 1]?.kind, item.kind))}
          >
            {item.node}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
