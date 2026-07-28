import { useEffect, useRef, useState } from "react";
import type {
  AppState,
  ApprovalMode,
  ConfiguredModel,
  ThinkingLevel,
} from "../../shared/ipc.js";
import {
  IconArrowUp,
  IconCheck,
  IconCompress,
  IconCube,
  IconPlus,
  IconShield,
  IconSliders,
  IconSpinner,
  IconStop,
} from "../lib/icons.js";
import { Dropdown, MenuItem, MenuLabel, cx, formatTokens } from "./ui.js";

interface ComposerProps {
  state: AppState;
  activeModel: ConfiguredModel | undefined;
  /** Text pushed in from outside, e.g. clicking a suggestion. `id` re-applies the same text. */
  draft?: { text: string; id: number } | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onCompact: () => void;
  onSelectModel: (key: string) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
  onSelectApproval: (mode: ApprovalMode) => void;
  onManageModels: () => void;
}

const APPROVAL_OPTIONS: Array<{ value: ApprovalMode; label: string; hint: string }> = [
  {
    value: "ask",
    label: "Approve commands",
    hint: "Shell commands wait for you to allow them",
  },
  {
    value: "auto",
    label: "Auto-run commands",
    hint: "Shell commands run as soon as the agent asks",
  },
];

export function Composer({
  state,
  activeModel,
  draft,
  onSend,
  onStop,
  onCompact,
  onSelectModel,
  onSelectThinking,
  onSelectApproval,
  onManageModels,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { behavior, session, models, isStreaming, isCompacting, contextUsage, stats } = state;
  const disabled = !activeModel || !session;
  const isCustomModel = activeModel?.isCustom === true;

  const contextPct =
    contextUsage.contextWindow > 0
      ? Math.min(100, Math.round((contextUsage.tokens / contextUsage.contextWindow) * 100))
      : 0;
  /** Fraction of the auto-compact threshold, so the meter warns before compaction kicks in. */
  const contextPressure = contextUsage.compactAt > 0 ? contextUsage.tokens / contextUsage.compactAt : 0;

  useEffect(() => {
    if (!draft) return;
    setValue(draft.text);
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled || isStreaming) return;
    onSend(text);
    setValue("");
  };

  const byProvider = new Map<string, ConfiguredModel[]>();
  for (const model of models) {
    const list = byProvider.get(model.providerName) ?? [];
    list.push(model);
    byProvider.set(model.providerName, list);
  }

  const thinkingLevels = activeModel?.thinkingLevels ?? [];

  return (
    <div className="px-6 pt-2 pb-5">
      <div className="mx-auto max-w-3xl">
        <div
          className={cx(
            // No overflow clipping here: the toolbar's menus open upward past this edge.
            "rounded-2xl border bg-ink-850 transition",
            focused ? "border-iris-500/60 ring-2 ring-iris-500/12" : "border-ink-700",
          )}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled || isStreaming}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              const sendNow = behavior.sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey;
              if (sendNow) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              !activeModel
                ? "Add a model to start chatting…"
                : !session
                  ? "Start a chat to begin…"
                  : isStreaming
                    ? "Agent is working…"
                    : isCompacting
                      ? "Compacting conversation…"
                      : "Ask the agent to build, fix, or explain something…"
            }
            className="max-h-[200px] w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] text-mist-100 outline-none placeholder:text-mist-500 disabled:cursor-not-allowed"
          />

          <div className="flex items-center gap-1 px-2 pb-2">
            <Dropdown
              disabled={models.length === 0}
              title="Model"
              label={
                <span className="flex items-center gap-1.5">
                  <IconCube className="h-3.5 w-3.5 text-mist-400" />
                  {activeModel ? activeModel.displayName : "No model"}
                </span>
              }
              panelClass="max-h-80 overflow-y-auto"
            >
              {(close) => (
                <>
                  {[...byProvider.entries()].map(([provider, list]) => (
                    <div key={provider}>
                      <MenuLabel>{provider}</MenuLabel>
                      {list.map((model) => (
                        <MenuItem
                          key={model.key}
                          selected={model.key === activeModel?.key}
                          onClick={() => {
                            onSelectModel(model.key);
                            close();
                          }}
                        >
                          <span className="flex-1 truncate">{model.displayName}</span>
                          {!model.hasKey && (
                            <span className="text-[10px] text-amber-soft">no key</span>
                          )}
                          {model.key === activeModel?.key && (
                            <IconCheck className="h-3.5 w-3.5 text-iris-400" />
                          )}
                        </MenuItem>
                      ))}
                    </div>
                  ))}
                  <div className="mt-1 border-t border-ink-700 pt-1">
                    <MenuItem
                      onClick={() => {
                        onManageModels();
                        close();
                      }}
                    >
                      <IconPlus className="h-3.5 w-3.5" /> Manage models…
                    </MenuItem>
                  </div>
                </>
              )}
            </Dropdown>

            {thinkingLevels.length > 1 && (
              <Dropdown
                title="Thinking effort"
                label={
                  <span className="flex items-center gap-1.5">
                    <IconSliders className="h-3.5 w-3.5 text-mist-400" />
                    {behavior.thinkingLevel === "off" ? "No thinking" : behavior.thinkingLevel}
                  </span>
                }
              >
                {(close) => (
                  <>
                    <MenuLabel>Thinking effort</MenuLabel>
                    {thinkingLevels.map((level) => (
                      <MenuItem
                        key={level}
                        selected={level === behavior.thinkingLevel}
                        onClick={() => {
                          onSelectThinking(level);
                          close();
                        }}
                      >
                        <span className="flex-1 capitalize">{level}</span>
                        {level === behavior.thinkingLevel && (
                          <IconCheck className="h-3.5 w-3.5 text-iris-400" />
                        )}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Dropdown>
            )}

            <Dropdown
              title="Shell command approval for this chat"
              disabled={!session}
              label={
                <span className="flex items-center gap-1.5">
                  <IconShield
                    className={cx(
                      "h-3.5 w-3.5",
                      session?.approvalMode === "auto" ? "text-amber-soft" : "text-mist-400",
                    )}
                  />
                  {session?.approvalMode === "auto" ? "Auto-run" : "Approve"}
                </span>
              }
              panelClass="min-w-72"
            >
              {(close) => (
                <>
                  <MenuLabel>Shell commands · this chat</MenuLabel>
                  {APPROVAL_OPTIONS.map((option) => (
                    <MenuItem
                      key={option.value}
                      selected={option.value === session?.approvalMode}
                      onClick={() => {
                        onSelectApproval(option.value);
                        close();
                      }}
                    >
                      <span className="flex-1">
                        <span className="block">{option.label}</span>
                        <span className="block text-[11px] text-mist-500">{option.hint}</span>
                      </span>
                      {option.value === session?.approvalMode && (
                        <IconCheck className="h-3.5 w-3.5 shrink-0 text-iris-400" />
                      )}
                    </MenuItem>
                  ))}
                </>
              )}
            </Dropdown>

            <div className="flex-1" />

            {behavior.showTokenUsage && !isCustomModel && stats.tokens > 0 && (
              <span className="mr-1 font-mono text-[11px] text-mist-500">
                {formatTokens(stats.tokens)} tok · ${stats.cost.toFixed(4)}
              </span>
            )}

            {session && contextUsage.tokens > 0 && contextUsage.contextWindow > 0 && (
              <span
                title={
                  isCustomModel
                    ? `${contextPct}% of context in use`
                    : `≈${formatTokens(contextUsage.tokens)} of ${formatTokens(contextUsage.contextWindow)} context tokens in use${
                        behavior.autoCompact && contextUsage.compactAt > 0
                          ? ` · auto-compacts around ${formatTokens(contextUsage.compactAt)}`
                          : ""
                      }`
                }
                className={cx(
                  "mr-0.5 font-mono text-[11px]",
                  contextPressure >= 1
                    ? "text-rose-soft"
                    : contextPressure >= 0.8
                      ? "text-amber-soft"
                      : "text-mist-500",
                )}
              >
                {contextPct}% ctx
              </span>
            )}

            {session && (
              <button
                type="button"
                onClick={onCompact}
                disabled={isStreaming || isCompacting || !contextUsage.canCompact}
                title={
                  isCompacting
                    ? "Compacting conversation…"
                    : contextUsage.canCompact
                      ? "Compact conversation — summarize older messages to free up context"
                      : "Nothing to compact yet"
                }
                className="flex h-8 w-8 items-center justify-center rounded-xl text-mist-500 transition hover:bg-ink-800 hover:text-mist-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mist-500"
              >
                {isCompacting ? (
                  <IconSpinner className="h-3.5 w-3.5" />
                ) : (
                  <IconCompress className="h-3.5 w-3.5" />
                )}
              </button>
            )}

            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop"
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-rose-soft/40 text-rose-soft transition hover:bg-rose-soft/10"
              >
                <IconStop className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!value.trim() || disabled || isStreaming}
                title="Send"
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-iris-600 text-white transition hover:bg-iris-500 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-mist-500"
              >
                <IconArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <p className="mt-2 text-center text-[11px] text-mist-500">
          Command approval applies to this chat. Its folder is fixed when the chat is created.
        </p>
      </div>
    </div>
  );
}
