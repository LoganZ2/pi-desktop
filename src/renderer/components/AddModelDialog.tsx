import { useEffect, useMemo, useState } from "react";
import type {
  CatalogModel,
  CustomProviderInput,
  ProviderOption,
} from "../../shared/ipc.js";
import { IconCheck, IconCube, IconSearch, IconSliders } from "../lib/icons.js";
import { Button, Modal, TextField, Toggle, cx } from "./ui.js";

type Step = "provider" | "key" | "model" | "custom";

const API_OPTIONS: Array<{ value: CustomProviderInput["api"]; label: string; hint: string }> = [
  { value: "openai-completions", label: "OpenAI compatible", hint: "/chat/completions — vLLM, Ollama, LM Studio, most proxies" },
  { value: "openai-responses", label: "OpenAI Responses", hint: "/responses — newer OpenAI-style endpoints" },
  { value: "anthropic-messages", label: "Anthropic Messages", hint: "/v1/messages — Claude-compatible gateways" },
];

interface AddModelDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export function AddModelDialog({ open, onClose, onAdded }: AddModelDialogProps) {
  const [step, setStep] = useState<Step>("provider");
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<ProviderOption | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);

  const [custom, setCustom] = useState<CustomProviderInput>({
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    modelId: "",
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: false,
    useWebSocket: false,
  });

  useEffect(() => {
    if (!open) return;
    setStep("provider");
    setProvider(null);
    setApiKey("");
    setQuery("");
    setError(null);
    setAdded([]);
    void window.pi.listProviders().then(setProviders);
  }, [open]);

  const loadCatalog = async (providerId: string) => {
    setCatalog(await window.pi.listCatalog(providerId));
    setStep("model");
  };

  const pickProvider = async (option: ProviderOption) => {
    setProvider(option);
    setError(null);
    if (option.hasKey) await loadCatalog(option.id);
    else setStep("key");
  };

  const saveKey = async () => {
    if (!provider || !apiKey.trim()) return;
    setBusy(true);
    try {
      setProviders(await window.pi.saveProviderKey(provider.id, apiKey.trim()));
      await loadCatalog(provider.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addModel = async (model: CatalogModel) => {
    if (!provider) return;
    await window.pi.addModel(provider.id, model.id);
    setAdded((prev) => [...prev, model.id]);
    onAdded();
  };

  const saveCustom = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.pi.addCustomModel(custom);
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? catalog.filter((m) => m.id.toLowerCase().includes(q)) : catalog;
    return list.slice(0, 300);
  }, [catalog, query]);

  const titles: Record<Step, string> = {
    provider: "Add a model",
    key: `Connect ${provider?.name ?? ""}`,
    model: `Choose a model from ${provider?.name ?? ""}`,
    custom: "Custom endpoint",
  };

  return (
    <Modal open={open} onClose={onClose} title={titles[step]} width="max-w-2xl">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && (
          <div className="mb-4 rounded-lg border border-rose-soft/35 bg-rose-soft/[0.07] px-3 py-2 text-[12.5px] text-rose-soft">
            {error}
          </div>
        )}

        {step === "provider" && (
          <>
            <p className="mb-4 text-[13px] text-mist-400">
              Pick where the model runs. You'll add your API key next — it's stored encrypted on
              this machine and sent only to that provider.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {providers
                .filter((p) => !p.isCustom)
                .map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => void pickProvider(option)}
                    className="flex items-start gap-3 rounded-xl border border-ink-700 bg-ink-850 p-3 text-left transition hover:border-iris-500/60 hover:bg-ink-800"
                  >
                    <IconCube className="mt-0.5 h-4 w-4 shrink-0 text-iris-400" />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-mist-100">
                        {option.name}
                        {option.hasKey && <IconCheck className="h-3 w-3 text-jade-400" />}
                      </span>
                      <span className="mt-0.5 block truncate text-[11.5px] text-mist-500">
                        {option.hasKey ? "Key configured" : option.blurb}
                      </span>
                    </span>
                  </button>
                ))}
              <button
                type="button"
                onClick={() => setStep("custom")}
                className="flex items-start gap-3 rounded-xl border border-dashed border-ink-600 p-3 text-left transition hover:border-iris-500/60 hover:bg-ink-850"
              >
                <IconSliders className="mt-0.5 h-4 w-4 shrink-0 text-mist-400" />
                <span>
                  <span className="block text-[13px] font-medium text-mist-100">
                    Custom endpoint
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-mist-500">
                    Self-hosted, proxy, or any OpenAI-compatible URL
                  </span>
                </span>
              </button>
            </div>
          </>
        )}

        {step === "key" && provider && (
          <div className="space-y-4">
            <p className="text-[13px] text-mist-400">
              Paste an API key for {provider.name}. It is encrypted with your OS keychain and never
              leaves this machine except in requests to {provider.name}.
            </p>
            <TextField
              autoFocus
              type="password"
              mono
              value={apiKey}
              onChange={setApiKey}
              onEnter={() => void saveKey()}
              placeholder="sk-…"
            />
            {provider.envHint && (
              <p className="text-[11.5px] text-mist-500">
                Tip: setting{" "}
                <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono">
                  {provider.envHint}
                </code>{" "}
                before launching the app works too.
              </p>
            )}
          </div>
        )}

        {step === "model" && (
          <div className="space-y-3">
            <div className="relative">
              <IconSearch className="absolute top-2.5 left-3 h-4 w-4 text-mist-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="w-full rounded-lg border border-ink-700 bg-ink-850 py-2 pr-3 pl-9 text-[13px] text-mist-100 outline-none placeholder:text-mist-500 focus:border-iris-500/70"
              />
            </div>
            <div className="max-h-[46vh] space-y-1 overflow-y-auto">
              {filtered.map((model) => {
                const isAdded = model.alreadyAdded || added.includes(model.id);
                return (
                  <div
                    key={model.id}
                    className="flex items-center gap-3 rounded-lg border border-ink-800 px-3 py-2 transition hover:border-ink-700"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12.5px] text-mist-200">
                        {model.id}
                      </div>
                      <div className="mt-0.5 text-[11px] text-mist-500">
                        {Math.round(model.contextWindow / 1000)}k context
                        {model.reasoning && " · reasoning"}
                        {model.inputCost > 0 &&
                          ` · $${model.inputCost}/M in · $${model.outputCost}/M out`}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={isAdded ? "ghost" : "outline"}
                      disabled={isAdded}
                      onClick={() => void addModel(model)}
                    >
                      {isAdded ? "Added" : "Add"}
                    </Button>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="py-6 text-center text-[13px] text-mist-500">No models match.</p>
              )}
            </div>
          </div>
        )}

        {step === "custom" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Name</span>
                <TextField
                  value={custom.name}
                  onChange={(name) => setCustom({ ...custom, name })}
                  placeholder="My server"
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Base URL</span>
                <TextField
                  mono
                  value={custom.baseUrl}
                  onChange={(baseUrl) => setCustom({ ...custom, baseUrl })}
                  placeholder="http://localhost:11434/v1"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="block text-[12px] font-medium text-mist-300">API format</span>
              <div className="space-y-1.5">
                {API_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setCustom({ ...custom, api: option.value })}
                    className={cx(
                      "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition",
                      custom.api === option.value
                        ? "border-iris-500/60 bg-iris-600/10"
                        : "border-ink-700 hover:border-ink-600",
                    )}
                  >
                    <span
                      className={cx(
                        "mt-1 h-2 w-2 shrink-0 rounded-full",
                        custom.api === option.value ? "bg-iris-400" : "bg-ink-600",
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

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Model ID</span>
                <TextField
                  mono
                  value={custom.modelId}
                  onChange={(modelId) => setCustom({ ...custom, modelId })}
                  placeholder="qwen3-coder"
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">
                  API key <span className="text-mist-500">(optional)</span>
                </span>
                <TextField
                  type="password"
                  mono
                  value={custom.apiKey}
                  onChange={(apiKey) => setCustom({ ...custom, apiKey })}
                  placeholder="leave blank for local servers"
                />
              </label>
            </div>

            {custom.api === "openai-responses" && (
              <div className="flex items-start justify-between gap-4 rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[12.5px] text-mist-100">Stream over WebSocket</div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-mist-500">
                    Connects to <code className="font-mono">/responses</code> over wss instead of
                    SSE. Falls back to SSE automatically, and stops trying after 5 failed
                    connections until the app restarts.
                  </p>
                </div>
                <Toggle
                  checked={Boolean(custom.useWebSocket)}
                  onChange={(useWebSocket) => setCustom({ ...custom, useWebSocket })}
                />
              </div>
            )}

            <div className="grid grid-cols-3 items-end gap-3">
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Context window</span>
                <TextField
                  type="number"
                  value={String(custom.contextWindow)}
                  onChange={(v) => setCustom({ ...custom, contextWindow: Number(v) || 0 })}
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-[12px] font-medium text-mist-300">Max output</span>
                <TextField
                  type="number"
                  value={String(custom.maxTokens)}
                  onChange={(v) => setCustom({ ...custom, maxTokens: Number(v) || 0 })}
                />
              </label>
              <div className="flex items-center gap-2.5 pb-2">
                <Toggle
                  checked={custom.reasoning}
                  onChange={(reasoning) => setCustom({ ...custom, reasoning })}
                />
                <span className="text-[12px] text-mist-300">Reasoning</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-ink-800 px-5 py-3">
        <div>
          {step !== "provider" && (
            <Button variant="ghost" onClick={() => setStep("provider")}>
              ← Back
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {step === "key" && (
            <Button variant="primary" disabled={!apiKey.trim() || busy} onClick={() => void saveKey()}>
              {busy ? "Saving…" : "Continue"}
            </Button>
          )}
          {step === "custom" && (
            <Button
              variant="primary"
              disabled={busy || !custom.baseUrl.trim() || !custom.modelId.trim()}
              onClick={() => void saveCustom()}
            >
              {busy ? "Adding…" : "Add model"}
            </Button>
          )}
          {step === "model" && (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
