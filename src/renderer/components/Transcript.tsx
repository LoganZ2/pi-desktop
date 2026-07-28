import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ApprovalRequest,
  ChatBlock,
  ChatMessage,
  CompactionNotice,
} from "../../shared/ipc.js";
import { IconChevron, IconCompress } from "../lib/icons.js";
import { renderMarkdown } from "../lib/markdown.js";
import { ToolCard, contentToText, type ToolRun } from "./ToolCard.js";
import { cx, formatTokens } from "./ui.js";

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

type ItemKind = "user" | "text" | "thinking" | "tool" | "error" | "compaction";
interface Item {
  key: string;
  kind: ItemKind;
  node: ReactNode;
}

/** Consecutive tool cards sit tight together; everything else gets more air. */
function spacingFor(previous: ItemKind | undefined, current: ItemKind): string {
  if (!previous) return "";
  if (previous === "tool" && current === "tool") return "mt-1.5";
  if (previous === "compaction" || current === "compaction") return "mt-6";
  if (current === "user") return "mt-6";
  return "mt-4";
}

interface TranscriptProps {
  messages: ChatMessage[];
  compactions: CompactionNotice[];
  streaming: ChatMessage | null;
  toolRuns: Record<string, ToolRun>;
  approvals: Record<string, ApprovalRequest>;
  autoExpandThinking: boolean;
  onApprove: (approvalId: string, allow: boolean, always: boolean) => void;
}

export function Transcript({
  messages,
  compactions,
  streaming,
  toolRuns,
  approvals,
  autoExpandThinking,
  onApprove,
}: TranscriptProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** User is close enough to the bottom that we should auto-scroll. */
  const pinned = useRef(true);
  /**
   * If the user intentionally scrolls away, lock auto-scroll off until they
   * manually scroll all the way back to the bottom. This prevents streaming
   * content from fighting the user when they are reading earlier messages.
   */
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
    // Use rAF so multiple rapid updates batch into a single frame — avoids
    // jitter when streaming content fights with manual scroll position.
    cancelAnimationFrame(scrollRaf.current);
    const node = scrollRef.current;
    scrollRaf.current = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, [messages, streaming, toolRuns, approvals]);

  const results = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      results.set(message.toolCallId, message);
    }
  }

  // Compaction markers slot in by how many persisted messages precede them,
  // counted against the raw transcript (before tool results are hidden).
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
  if (streaming) rows.push({ kind: "message", message: streaming });

  // Flatten to a single list so spacing can react to what actually sits next
  // to what, rather than to message boundaries.
  const items: Item[] = [];
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
      items.push({
        key: `${base}-user`,
        kind: "user",
        node: (
          <div className="flex justify-end">
            <div className="max-w-[80%] overflow-hidden rounded-2xl rounded-br-md border border-iris-500/25 bg-iris-600/15 px-3.5 py-2.5 text-[14px] whitespace-pre-wrap break-words text-mist-100">
              {contentToText(message.content) || String(message.content ?? "")}
            </div>
          </div>
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

    if (message.errorMessage) {
      items.push({
        key: `${base}-error`,
        kind: "error",
        node: (
          <div
            className={cx(
              "rounded-xl border px-3.5 py-2.5 text-[12.5px]",
              message.stopReason === "aborted"
                ? "border-ink-700 bg-ink-850 text-mist-400"
                : "border-rose-soft/35 bg-rose-soft/[0.07] text-rose-soft",
            )}
          >
            {message.stopReason === "aborted" ? "Stopped." : message.errorMessage}
          </div>
        ),
      });
    }
  });

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
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
