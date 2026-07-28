import { useEffect, useState } from "react";
import type { ConfiguredModel, CustomModelEdit, CustomProviderInput } from "../../shared/ipc.js";
import { Button, Modal, TextField, Toggle, cx } from "./ui.js";

const API_OPTIONS: Array<{ value: CustomProviderInput["api"]; label: string; hint: string }> = [
  {
    value: "openai-completions",
    label: "OpenAI compatible",
    hint: "/chat/completions — vLLM, Ollama, LM Studio, most proxies",
  },
  { value: "openai-responses", label: "OpenAI Responses", hint: "/responses — newer OpenAI-style endpoints" },
  { value: "anthropic-messages", label: "Anthropic Messages", hint: "/v1/messages — Claude-compatible gateways" },
];

interface EditModelDialogProps {
  model: ConfiguredModel | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Edits an existing entry in place. Built-in models only expose their key,
 * since everything else comes from the provider catalog.
 */
export function EditModelDialog({ model, onClose, onSaved }: EditModelDialogProps) {
  const [form, setForm] = useState<CustomModelEdit | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setApiKey("");
    setError(null);
    setBusy(false);
    if (!model?.custom) {
      setForm(null);
      return;
    }
    setForm({
      providerId: model.providerId,
      originalModelId: model.modelId,
      name: model.providerName,
      baseUrl: model.custom.baseUrl,
      api: model.custom.api,
      modelId: model.modelId,
      contextWindow: model.contextWindow,
      maxTokens: model.custom.maxTokens,
      reasoning: model.reasoning,
      useWebSocket: model.webSocket?.enabled ?? false,
    });
  }, [model]);

  if (!model) return null;
  const isCustom = Boolean(model.custom);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isCustom && form) {
        await window.pi.updateCustomModel({ ...form, apiKey: apiKey.trim() || undefined });
      } else if (apiKey.trim()) {
        await window.pi.saveProviderKey(model.providerId, apiKey.trim());
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      await window.pi.clearProviderKey(model.providerId);
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const patch = (next: Partial<CustomModelEdit>) => setForm((f) => (f ? { ...f, ...next } : f));

  return (
    <Modal open onClose={onClose} title={`Edit ${model.modelId}`} width="max-w-2xl">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && (
          <div className="mb-4 rounded-lg border border-rose-soft/35 bg-rose-soft/[0.07] px-3 py-2 text-[12.5px] text-rose-soft">
            {error}
          </div>
        )}

        {isCustom && form ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Name</span>
                <TextField value={form.name} onChange={(name) => patch({ name })} />
              </label>
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Base URL</span>
                <TextField mono value={form.baseUrl} onChange={(baseUrl) => patch({ baseUrl })} />
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="block text-[12px] font-medium text-mist-300">API format</span>
              <div className="space-y-1.5">
                {API_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => patch({ api: option.value })}
                    className={cx(
                      "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition",
                      form.api === option.value
                        ? "border-iris-500/60 bg-iris-600/10"
                        : "border-ink-700 hover:border-ink-600",
                    )}
                  >
                    <span
                      className={cx(
                        "mt-1 h-2 w-2 shrink-0 rounded-full",
                        form.api === option.value ? "bg-iris-400" : "bg-ink-600",
                      )}
                    />
                    <span>
                      <span className="block text-[12.5px] text-mist-100">{option.label}</span>
                      <span className="block text-[11px] text-mist-500">{option.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {form.api === "openai-responses" && (
              <div className="flex items-start justify-between gap-4 rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[12.5px] text-mist-100">Stream over WebSocket</div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-mist-500">
                    Connects to <code className="font-mono">/responses</code> over wss, falling back
                    to SSE. {model.webSocket && !model.webSocket.supported && (
                      <span className="text-amber-soft">
                        Currently unavailable after {model.webSocket.consecutiveFailures} failed
                        attempts — restart the app to retry.
                      </span>
                    )}
                  </p>
                </div>
                <Toggle
                  checked={Boolean(form.useWebSocket)}
                  onChange={(useWebSocket) => patch({ useWebSocket })}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Model ID</span>
                <TextField mono value={form.modelId} onChange={(modelId) => patch({ modelId })} />
              </label>
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">
                  API key{" "}
                  <span className="text-mist-500">
                    ({model.hasKey ? "leave blank to keep" : "not set"})
                  </span>
                </span>
                <TextField
                  type="password"
                  mono
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={model.hasKey ? "•••••• stored" : "sk-…"}
                />
              </label>
            </div>

            <div className="grid grid-cols-3 items-end gap-3">
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Context window</span>
                <TextField
                  type="number"
                  value={String(form.contextWindow)}
                  onChange={(v) => patch({ contextWindow: Number(v) || 0 })}
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Max output</span>
                <TextField
                  type="number"
                  value={String(form.maxTokens)}
                  onChange={(v) => patch({ maxTokens: Number(v) || 0 })}
                />
              </label>
              <div className="flex items-center gap-2.5 pb-2">
                <Toggle
                  checked={form.reasoning}
                  onChange={(reasoning) => patch({ reasoning })}
                />
                <span className="text-[12px] text-mist-300">Reasoning</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-[13px] text-mist-400">
              <span className="font-mono text-mist-200">{model.modelId}</span> comes from{" "}
              {model.providerName}'s catalog, so its details aren't editable here. You can replace
              the API key used for every {model.providerName} model.
            </p>
            <label className="space-y-1.5 block">
              <span className="block text-[12px] font-medium text-mist-300">
                API key{" "}
                <span className="text-mist-500">
                  ({model.hasKey ? "replace the stored key" : "not set"})
                </span>
              </span>
              <TextField
                autoFocus
                type="password"
                mono
                value={apiKey}
                onChange={setApiKey}
                onEnter={() => void save()}
                placeholder={model.hasKey ? "•••••• stored" : "sk-…"}
              />
            </label>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-ink-800 px-5 py-3">
        {model.hasKey ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void clearKey()}>
            Remove key
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || (!isCustom && !apiKey.trim())}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
