import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentEvent,
  AppState,
  ApprovalRequest,
  ApprovalMode,
  BehaviorSettings,
  ChatMessage,
  NewChatInput,
  ThinkingLevel,
} from "../shared/ipc.js";
import { AddModelDialog } from "./components/AddModelDialog.js";
import { EditModelDialog } from "./components/EditModelDialog.js";
import { Composer } from "./components/Composer.js";
import { NewChatDialog } from "./components/NewChatDialog.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { Sidebar } from "./components/Sidebar.js";
import { Transcript, contentToText, type ToolRun } from "./components/Transcript.js";
import { Button } from "./components/ui.js";
import { IconFolder, IconPlus, PiMark } from "./lib/icons.js";

const SUGGESTIONS = [
  "What files are in my workspace?",
  "Write a small Python script that prints a mandelbrot set, then run it",
  "Initialize a git repo here and make the first commit",
];

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolRuns, setToolRuns] = useState<Record<string, ToolRun>>({});
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "models">("general");
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; id: number } | null>(null);

  const applyState = useCallback((next: AppState) => {
    setState(next);
    setMessages(next.messages);
    setIsStreaming(next.isStreaming);
    setApprovals(
      Object.fromEntries(next.pendingApprovals.map((request) => [request.toolCallId, request])),
    );
  }, []);

  const refresh = useCallback(async () => {
    applyState(await window.pi.getState());
  }, [applyState]);

  useEffect(() => {
    void refresh();
    const offState = window.pi.onState(applyState);
    const offApproval = window.pi.onApprovalRequest((request) => {
      setApprovals((prev) => ({ ...prev, [request.toolCallId]: request }));
    });
    const offEvent = window.pi.onAgentEvent((event: AgentEvent) => {
      switch (event.type) {
        case "agent_start":
          setIsStreaming(true);
          break;
        case "agent_end":
          setIsStreaming(false);
          setStreaming(null);
          break;
        case "message_start":
        case "message_update": {
          const message = event.message as ChatMessage;
          if (message.role === "assistant") setStreaming(message);
          break;
        }
        case "message_end": {
          const message = event.message as ChatMessage;
          if (message.role === "assistant") setStreaming(null);
          setMessages((prev) => [...prev, message]);
          break;
        }
        case "tool_execution_start":
          setToolRuns((prev) => ({
            ...prev,
            [event.toolCallId]: { status: "running", output: "" },
          }));
          setApprovals((prev) => {
            const { [event.toolCallId]: _resolved, ...rest } = prev;
            return rest;
          });
          break;
        case "tool_execution_update": {
          const partial = event.partialResult as { content?: unknown; details?: unknown };
          setToolRuns((prev) => ({
            ...prev,
            [event.toolCallId]: {
              status: "running",
              output: contentToText(partial?.content),
              details: partial?.details,
            },
          }));
          break;
        }
        case "tool_execution_end": {
          const result = event.result as { content?: unknown; details?: unknown };
          setToolRuns((prev) => ({
            ...prev,
            [event.toolCallId]: {
              status: event.isError ? "error" : "done",
              output: contentToText(result?.content),
              details: result?.details,
            },
          }));
          break;
        }
        default:
          break;
      }
    });
    return () => {
      offState();
      offApproval();
      offEvent();
    };
  }, [applyState, refresh]);

  const activeModel = useMemo(
    () => state?.models.find((m) => m.key === state.activeModelKey),
    [state],
  );

  const resetTransient = () => {
    setToolRuns({});
    setApprovals({});
    setStreaming(null);
  };

  const send = async (text: string) => {
    setDraft(null);
    try {
      await window.pi.prompt(text);
    } catch (error) {
      console.error(error);
    }
  };

  const compact = async () => {
    try {
      applyState(await window.pi.compact());
    } catch (error) {
      console.error("compaction failed:", error);
      void refresh();
    }
  };

  const editAndResend = async (entryId: string, text: string) => {
    try {
      applyState(await window.pi.editMessage(entryId, text));
    } catch (error) {
      console.error("edit failed:", error);
    }
  };

  const switchBranch = async (targetId: string) => {
    try {
      applyState(await window.pi.switchBranch(targetId));
    } catch (error) {
      console.error("branch switch failed:", error);
    }
  };

  const undoLatest = async (turnId: string) => {
    try {
      applyState(await window.pi.undoLatestChanges(turnId));
    } catch (error) {
      console.error("undo failed:", error);
      void refresh();
    }
  };

  const respondApproval = (approvalId: string, allow: boolean, always: boolean) => {
    setApprovals((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([, v]) => v.approvalId !== approvalId)),
    );
    void window.pi.respondApproval(approvalId, allow, always);
    if (always) void refresh();
  };

  const updateBehavior = (patch: Partial<BehaviorSettings>) => {
    void window.pi.updateBehavior(patch).then(applyState);
  };

  const createChat = (input: NewChatInput) => {
    resetTransient();
    void window.pi
      .newSession(input)
      .then((next) => {
        applyState(next);
        setNewChatOpen(false);
      })
      .catch((error) => console.error("could not create chat:", error));
  };

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-mist-500">
        <PiMark className="h-8 w-8 animate-pulse-soft text-iris-500" />
      </div>
    );
  }

  const hasContent = messages.length > 0 || streaming !== null;

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={state.sessions}
        activePath={state.activeSessionPath}
        onNew={() => setNewChatOpen(true)}
        onOpen={(path) => {
          resetTransient();
          void window.pi.openSession(path).then(applyState);
        }}
        onRename={(path, title) => void window.pi.renameSession(path, title).then(applyState)}
        onDelete={(path) => {
          resetTransient();
          void window.pi.deleteSession(path).then(applyState);
        }}
        onOpenSettings={() => {
          setSettingsSection("general");
          setSettingsOpen(true);
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col bg-ink-950">
        <header className="drag-region flex h-14 shrink-0 items-center gap-3 border-b border-ink-800 px-6">
          <PiMark className="h-4 w-4 text-iris-500" />
          <span className="text-[13px] font-medium text-mist-300">
            {state.sessions.find((s) => s.path === state.activeSessionPath)?.title ?? "pi desktop"}
          </span>
          <div className="flex-1" />
          {state.session && (
            <span
              title={`This chat runs in ${state.session.workspace}`}
              className="flex max-w-[280px] items-center gap-1.5 rounded-lg border border-ink-800 px-2.5 py-1 text-[11.5px] text-mist-400"
            >
              <IconFolder className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {state.session.workspace.split("/").filter(Boolean).pop()}
              </span>
            </span>
          )}
        </header>

        {hasContent ? (
          <Transcript
            messages={messages}
            compactions={state.compactions}
            turnChanges={state.turnChanges}
            streaming={streaming}
            isStreaming={isStreaming}
            toolRuns={toolRuns}
            approvals={approvals}
            autoExpandThinking={state.behavior.autoExpandThinking}
            onApprove={respondApproval}
            onEditMessage={editAndResend}
            onSwitchBranch={switchBranch}
            onUndoChanges={undoLatest}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="w-full max-w-md text-center">
              <PiMark className="mx-auto h-12 w-12 text-iris-500 drop-shadow-[0_0_28px_rgba(113,128,255,0.45)]" />
              <h1 className="mt-3 text-[19px] font-semibold text-mist-100">
                {!activeModel
                  ? "Add a model to get started"
                  : !state.session
                    ? "Start your first chat"
                    : "What should we build?"}
              </h1>
              <p className="mt-1.5 text-[13px] text-mist-400">
                {!activeModel
                  ? "Connect a provider with your API key, or point pi at any OpenAI-compatible endpoint."
                  : !state.session
                    ? "Every chat works in its own folder — name a new project, or pick one you already have."
                    : "A coding agent with shell, file, and edit tools, running in this chat's folder."}
              </p>

              {!activeModel ? (
                <div className="mt-6">
                  <Button variant="primary" onClick={() => setAddModelOpen(true)}>
                    <span className="flex items-center gap-1.5">
                      <IconPlus className="h-4 w-4" /> Add a model
                    </span>
                  </Button>
                </div>
              ) : !state.session ? (
                <div className="mt-6">
                  <Button variant="primary" onClick={() => setNewChatOpen(true)}>
                    <span className="flex items-center gap-1.5">
                      <IconPlus className="h-4 w-4" /> New chat
                    </span>
                  </Button>
                </div>
              ) : (
                <div className="mt-7 flex flex-col gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setDraft({ text: suggestion, id: Date.now() })}
                      className="rounded-xl border border-ink-800 bg-ink-900 px-3.5 py-2.5 text-left text-[13px] text-mist-400 transition hover:border-iris-500/40 hover:text-mist-200"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <Composer
          state={{ ...state, isStreaming }}
          activeModel={activeModel}
          draft={draft}
          onSend={send}
          onStop={() => void window.pi.abort().then(applyState)}
          onCompact={() => void compact()}
          onSelectModel={(key) => void window.pi.setActiveModel(key).then(applyState)}
          onSelectThinking={(level: ThinkingLevel) => updateBehavior({ thinkingLevel: level })}
          onSelectApproval={(mode: ApprovalMode) =>
            void window.pi.setApprovalMode(mode).then(applyState)
          }
          onManageModels={() => {
            setSettingsSection("models");
            setSettingsOpen(true);
          }}
        />
      </main>

      <SettingsDialog
        key={settingsSection}
        open={settingsOpen}
        initialSection={settingsSection}
        state={state}
        onClose={() => setSettingsOpen(false)}
        onUpdate={updateBehavior}
        onChooseProjectsRoot={() => void window.pi.chooseProjectsRoot().then(applyState)}
        onRemoveModel={(modelKey) => void window.pi.removeModel(modelKey).then(applyState)}
        onToggleWebSocket={(providerId, enabled) =>
          void window.pi.setProviderWebSocket(providerId, enabled).then(applyState)
        }
        onEditModel={setEditingModelKey}
        onAddModel={() => setAddModelOpen(true)}
      />

      <NewChatDialog
        open={newChatOpen}
        projectsRoot={state.behavior.projectsRoot}
        onClose={() => setNewChatOpen(false)}
        onCreate={createChat}
      />

      <EditModelDialog
        model={state.models.find((m) => m.key === editingModelKey) ?? null}
        onClose={() => setEditingModelKey(null)}
        onSaved={() => void refresh()}
      />

      <AddModelDialog
        open={addModelOpen}
        onClose={() => setAddModelOpen(false)}
        onAdded={() => void refresh()}
      />
    </div>
  );
}
