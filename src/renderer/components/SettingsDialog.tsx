import { useState } from "react";
import type { AppState, BehaviorSettings } from "../../shared/ipc.js";
import { IconCube, IconFolder, IconPencil, IconPlus, IconShield, IconTrash } from "../lib/icons.js";
import {
  Button,
  Modal,
  SegmentedControl,
  SettingRow,
  Toggle,
  cx,
} from "./ui.js";

type Section = "general" | "models" | "about";

interface SettingsDialogProps {
  open: boolean;
  initialSection?: Section;
  state: AppState;
  onClose: () => void;
  onUpdate: (patch: Partial<BehaviorSettings>) => void;
  onChooseProjectsRoot: () => void;
  onRemoveModel: (key: string) => void;
  onAddModel: () => void;
  onToggleWebSocket: (providerId: string, enabled: boolean) => void;
  onEditModel: (key: string) => void;
}

export function SettingsDialog({
  open,
  initialSection = "general",
  state,
  onClose,
  onUpdate,
  onChooseProjectsRoot,
  onRemoveModel,
  onAddModel,
  onToggleWebSocket,
  onEditModel,
}: SettingsDialogProps) {
  const [section, setSection] = useState<Section>(initialSection);
  const { behavior, models } = state;

  const nav: Array<{ id: Section; label: string; icon: typeof IconShield }> = [
    { id: "general", label: "General", icon: IconShield },
    { id: "models", label: "Models", icon: IconCube },
    { id: "about", label: "About", icon: IconFolder },
  ];

  return (
    <Modal open={open} onClose={onClose} title="Settings" width="max-w-3xl">
      <div className="flex min-h-[440px]">
        <nav className="w-44 shrink-0 border-r border-ink-800 p-2">
          {nav.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={cx(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition",
                section === item.id
                  ? "bg-ink-800 text-mist-100"
                  : "text-mist-400 hover:bg-ink-850 hover:text-mist-200",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {section === "general" && (
            <div>
              <div className="mb-1 rounded-lg border border-ink-800 bg-ink-850/60 px-3 py-2 text-[11.5px] text-mist-400">
                Each chat runs in its own folder, chosen when you create it and fixed from then on.
                These settings decide where new projects are created and how new chats start.
              </div>

              <SettingRow
                title="Projects folder"
                description="Named projects are created here. Chats opened on an existing folder are unaffected."
              >
                <div className="flex items-center gap-2">
                  <code className="max-w-[240px] truncate rounded-md bg-ink-850 px-2 py-1 font-mono text-[11.5px] text-mist-400">
                    {behavior.projectsRoot}
                  </code>
                  <Button variant="outline" size="sm" onClick={onChooseProjectsRoot}>
                    Change
                  </Button>
                </div>
              </SettingRow>

              <SettingRow
                title="Default shell approval for new chats"
                description="The agent can run shell commands with your user's permissions. Ask first shows the command and waits for you; Run automatically executes it immediately."
              >
                <SegmentedControl
                  value={behavior.defaultApprovalMode}
                  onChange={(defaultApprovalMode) => onUpdate({ defaultApprovalMode })}
                  options={[
                    { value: "ask", label: "Ask first" },
                    { value: "auto", label: "Run automatically" },
                  ]}
                />
              </SettingRow>

              <SettingRow
                title="Send with Enter"
                description="On: Enter sends, Shift+Enter adds a newline. Off: Enter adds a newline, ⌘/Ctrl+Enter sends."
              >
                <Toggle
                  checked={behavior.sendOnEnter}
                  onChange={(sendOnEnter) => onUpdate({ sendOnEnter })}
                />
              </SettingRow>

              <SettingRow
                title="Expand reasoning by default"
                description="Show the model's thinking blocks open instead of collapsed."
              >
                <Toggle
                  checked={behavior.autoExpandThinking}
                  onChange={(autoExpandThinking) => onUpdate({ autoExpandThinking })}
                />
              </SettingRow>

              <SettingRow
                title="Show token usage"
                description="Display running token count and estimated cost for the current chat."
              >
                <Toggle
                  checked={behavior.showTokenUsage}
                  onChange={(showTokenUsage) => onUpdate({ showTokenUsage })}
                />
              </SettingRow>
            </div>
          )}

          {section === "models" && (
            <div>
              <div className="mb-4 flex items-center justify-between">
                <p className="text-[13px] text-mist-400">
                  {models.length === 0
                    ? "No models yet. Add one to start chatting."
                    : `${models.length} model${models.length === 1 ? "" : "s"} available in the picker.`}
                </p>
                <Button variant="primary" size="sm" onClick={onAddModel}>
                  <span className="flex items-center gap-1.5">
                    <IconPlus className="h-3.5 w-3.5" /> Add model
                  </span>
                </Button>
              </div>

              <div className="space-y-1.5">
                {models.map((model) => (
                  <div
                    key={model.key}
                    className="group flex items-center gap-3 rounded-xl border border-ink-800 px-3 py-2.5 transition hover:border-ink-700"
                  >
                    <IconCube className="h-4 w-4 shrink-0 text-iris-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12.5px] text-mist-200">
                        {model.modelId}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-mist-500">
                        <span>{model.providerName}</span>
                        <span>·</span>
                        <span>{Math.round(model.contextWindow / 1000)}k context</span>
                        {model.isCustom && (
                          <>
                            <span>·</span>
                            <span className="text-iris-400">custom</span>
                          </>
                        )}
                        {model.webSocket?.enabled && (
                          <>
                            <span>·</span>
                            <span
                              className={
                                model.webSocket.supported ? "text-jade-400" : "text-amber-soft"
                              }
                              title={model.webSocket.lastError}
                            >
                              {model.webSocket.supported
                                ? model.webSocket.consecutiveFailures > 0
                                  ? `ws (${model.webSocket.consecutiveFailures}/${model.webSocket.failureLimit} failed)`
                                  : "ws"
                                : "ws unavailable — using SSE"}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {!model.hasKey && (
                      <span className="rounded-full border border-amber-soft/40 px-2 py-0.5 text-[10.5px] text-amber-soft">
                        no key
                      </span>
                    )}
                    {model.key === state.activeModelKey && (
                      <span className="rounded-full border border-jade-400/40 px-2 py-0.5 text-[10.5px] text-jade-400">
                        active
                      </span>
                    )}
                    {model.webSocket && (
                      <span
                        className="flex items-center gap-1.5 text-[10.5px] text-mist-500"
                        title="Stream over WebSocket, falling back to SSE"
                      >
                        ws
                        <Toggle
                          checked={model.webSocket.enabled}
                          onChange={(enabled) =>
                            onToggleWebSocket(model.webSocket!.providerId, enabled)
                          }
                        />
                      </span>
                    )}
                    <div className="flex items-center opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        title="Edit"
                        onClick={() => onEditModel(model.key)}
                        className="rounded-lg p-1.5 text-mist-500 transition hover:text-mist-100"
                      >
                        <IconPencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Remove"
                        onClick={() => onRemoveModel(model.key)}
                        className="rounded-lg p-1.5 text-mist-500 transition hover:text-rose-soft"
                      >
                        <IconTrash className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {section === "about" && (
            <div className="space-y-4 text-[13px] text-mist-400">
              <div>
                <div className="text-[15px] font-semibold text-mist-100">pi desktop</div>
                <div className="mt-0.5 text-[12px] text-mist-500">Version {state.appVersion}</div>
              </div>
              <p className="leading-relaxed">
                A desktop coding agent built on the pi agent framework — the agent loop, tools,
                session storage, and provider catalog all come from{" "}
                <code className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[11.5px]">
                  @earendil-works/pi-agent-core
                </code>{" "}
                and{" "}
                <code className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[11.5px]">
                  @earendil-works/pi-ai
                </code>
                .
              </p>
              <p className="leading-relaxed">
                Chats are stored as JSONL transcripts on this machine. API keys are encrypted with
                your OS keychain and used only for direct requests to the provider you configured.
              </p>
              <p className="leading-relaxed">
                Tools run with your user account's permissions, so keep shell approval on unless you
                trust the task.
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
