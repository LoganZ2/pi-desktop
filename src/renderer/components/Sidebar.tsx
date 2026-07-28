import { useState } from "react";
import type { SessionSummary } from "../../shared/ipc.js";
import { IconChat, IconGear, IconPencil, IconPlus, IconTrash } from "../lib/icons.js";
import { cx } from "./ui.js";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface SidebarProps {
  sessions: SessionSummary[];
  activePath: string | null;
  onNew: () => void;
  onOpen: (path: string) => void;
  onRename: (path: string, title: string) => void;
  onDelete: (path: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  sessions,
  activePath,
  onNew,
  onOpen,
  onRename,
  onDelete,
  onOpenSettings,
}: SidebarProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = (path: string) => {
    const title = draft.trim();
    if (title) onRename(path, title);
    setEditing(null);
  };

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      <div className="drag-region flex h-14 items-center justify-between pr-3 pl-20">
        <span className="text-[11px] font-semibold tracking-widest text-mist-500 uppercase">
          Chats
        </span>
        <button
          type="button"
          onClick={onNew}
          title="New chat"
          className="no-drag rounded-lg p-1.5 text-mist-400 transition hover:bg-ink-800 hover:text-mist-100"
        >
          <IconPlus />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-mist-500">No chats yet</p>
        )}
        {sessions.map((session) => {
          const active = session.path === activePath;
          return (
            <div
              key={session.path}
              className={cx(
                "group relative mb-0.5 rounded-lg transition",
                active ? "bg-ink-800" : "hover:bg-ink-850",
              )}
            >
              {editing === session.path ? (
                <input
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(session.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(session.path);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="w-full rounded-lg border border-iris-500/60 bg-ink-850 px-2.5 py-2 text-[13px] text-mist-100 outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(session.path)}
                  className="flex w-full items-start gap-2.5 px-2.5 py-2 text-left"
                >
                  <IconChat
                    className={cx(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      active ? "text-iris-400" : "text-mist-500",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cx(
                        "block truncate text-[13px]",
                        active ? "text-mist-100" : "text-mist-300",
                      )}
                    >
                      {session.title}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-mist-500">
                      {relativeTime(session.updatedAt)}
                      {session.messageCount > 0 && ` · ${session.messageCount} msgs`}
                    </span>
                  </span>
                </button>
              )}

              {editing !== session.path && (
                <div className="absolute top-1.5 right-1.5 hidden items-center gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    title="Rename"
                    onClick={() => {
                      setDraft(session.title);
                      setEditing(session.path);
                    }}
                    className="rounded-md bg-ink-750 p-1 text-mist-400 transition hover:text-mist-100"
                  >
                    <IconPencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => onDelete(session.path)}
                    className="rounded-md bg-ink-750 p-1 text-mist-400 transition hover:text-rose-soft"
                  >
                    <IconTrash className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        className="flex items-center gap-2.5 border-t border-ink-800 px-4 py-3 text-[13px] text-mist-400 transition hover:bg-ink-850 hover:text-mist-100"
      >
        <IconGear className="h-4 w-4" />
        Settings
      </button>
    </aside>
  );
}
