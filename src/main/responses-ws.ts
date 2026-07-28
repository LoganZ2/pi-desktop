// Responses API over WebSocket, with retries and automatic fallback to SSE.
//
// Reliability: keepalive pings stop proxies from killing quiet connections
// mid-response (the classic 1006 close while the model thinks), a stall
// detector surfaces dead connections instead of hanging, and transport
// failures retry the request — once more over websocket, then over SSE — so a
// dropped connection degrades instead of ending the conversation.
//
// pi ships no websocket transport for the OpenAI Responses wire format — its
// only websocket client speaks the ChatGPT/Codex backend protocol. This adds
// one, following OpenAI's own `openai/resources/responses/ws` client so the
// framing is theirs rather than invented here:
//
//   URL      <baseUrl>/responses, scheme swapped to wss (ws for http)
//   Auth     Authorization: Bearer <key> on the handshake
//   Send     one frame: { type: "response.create", ...params }
//   Receive  JSON frames of the same ResponseStreamEvent union SSE delivers
//
// Because the server events are identical to SSE, pi's own
// `processResponsesStream` maps them into an AssistantMessageEventStream
// unchanged, and the SSE path below is pi's stock implementation.
import { WebSocket } from "ws";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@earendil-works/pi-ai/api/openai-responses-shared";

/** Mirrors pi's own set for the Responses wire format. */
const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const MIN_OUTPUT_TOKENS = 16;
const CONNECT_TIMEOUT_MS = 15_000;
/** Consecutive transport failures before a provider stops trying websockets. */
export const WS_FAILURE_LIMIT = 5;
/** Websocket attempts per request before the SSE fallback takes over. */
const WS_ATTEMPTS = 2;
const RETRY_DELAY_MS = 750;
/**
 * Keepalive: proxies and NATs kill connections that go quiet while the model
 * thinks, which surfaces as a 1006 close mid-response. Pings keep traffic
 * flowing; a stall this long with no frames or pongs means the connection is
 * dead (or the server ignores pings — the retry/SSE ladder covers that too).
 */
const PING_INTERVAL_MS = 20_000;
const STALL_TIMEOUT_MS = 75_000;

/** Terminal server events, after which the response is finished. */
const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete"]);

/** Raised when the handshake fails — no request ever reached the model. */
class WebSocketUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebSocketUnavailableError";
  }
}

/**
 * Raised for socket-level failures after the handshake (abnormal close, stall,
 * garbled frame). The request can be retried from scratch: every event pi
 * consumers see carries the full partial message and replaces the previous
 * one, so a restarted response supersedes whatever already streamed. API
 * errors reported by the server stay plain `Error`s and are never retried.
 */
class WebSocketTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebSocketTransportError";
  }
}

const isTransportError = (error: unknown): boolean =>
  error instanceof WebSocketUnavailableError || error instanceof WebSocketTransportError;

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

export interface WebSocketStatus {
  /** False once the failure limit is hit; resets when the app restarts. */
  supported: boolean;
  consecutiveFailures: number;
  lastError?: string;
}

/**
 * Per-provider circuit breaker. Deliberately in-memory: a proxy that was down
 * at launch should get another chance next time the app starts.
 */
export class WebSocketBreaker {
  private readonly state = new Map<string, WebSocketStatus>();

  status(providerId: string): WebSocketStatus {
    return this.state.get(providerId) ?? { supported: true, consecutiveFailures: 0 };
  }

  allows(providerId: string): boolean {
    return this.status(providerId).supported;
  }

  recordSuccess(providerId: string): void {
    this.state.set(providerId, { supported: true, consecutiveFailures: 0 });
  }

  recordFailure(providerId: string, error: Error): void {
    const previous = this.status(providerId);
    const consecutiveFailures = previous.consecutiveFailures + 1;
    this.state.set(providerId, {
      supported: consecutiveFailures < WS_FAILURE_LIMIT,
      consecutiveFailures,
      lastError: error.message,
    });
    if (consecutiveFailures >= WS_FAILURE_LIMIT) {
      console.warn(
        `[${providerId}] websocket failed ${consecutiveFailures}x — using SSE until restart. Last error: ${error.message}`,
      );
    }
  }
}

function socketUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/responses`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

/**
 * Build the `response.create` payload, mirroring the fields pi's SSE
 * implementation sends so both transports behave the same.
 */
function buildParams(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Record<string, unknown> {
  // Same conservative defaults pi's getCompat() applies to unknown endpoints.
  const compat = model.compat as
    | { supportsStrictMode?: boolean; supportsOpenAIGrammarTools?: boolean }
    | undefined;
  const toolOptions = {
    supportsStrictMode: compat?.supportsStrictMode ?? false,
    supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
  };

  const params: Record<string, unknown> = {
    model: model.id,
    input: convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS, { toolOptions }),
    stream: true,
    store: false,
  };

  if (options?.maxTokens) {
    params.max_output_tokens = Math.max(options.maxTokens, MIN_OUTPUT_TOKENS);
  }
  if (options?.temperature !== undefined) params.temperature = options.temperature;
  if (context.tools && context.tools.length > 0) {
    params.tools = convertResponsesTools(context.tools, toolOptions);
  }

  const reasoning = options?.reasoning;
  if (model.reasoning && reasoning) {
    params.reasoning = {
      effort: model.thinkingLevelMap?.[reasoning] ?? reasoning,
      summary: "auto",
    };
    params.include = ["reasoning.encrypted_content"];
  }
  return params;
}

/** Open the socket, send the request, then yield frames until the response ends. */
async function* streamEvents(
  model: Model<Api>,
  params: Record<string, unknown>,
  options: SimpleStreamOptions | undefined,
): AsyncGenerator<any> {
  const url = socketUrl(model.baseUrl);
  const signal = options?.signal;
  const socket = new WebSocket(url, {
    headers: {
      ...(options?.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...(options?.headers as Record<string, string> | undefined),
    },
    handshakeTimeout: CONNECT_TIMEOUT_MS,
  });

  // Buffer frames so none are lost between consumer awaits.
  const pending: unknown[] = [];
  let finished = false;
  let failure: Error | undefined;
  let notify: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const wake = () => {
    notify?.();
    notify = undefined;
  };

  const abort = () => {
    failure = new Error("Request was aborted");
    finished = true;
    try {
      socket.close(1000, "aborted");
    } catch {
      /* already closing */
    }
    wake();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(new WebSocketUnavailableError(error.message, { cause: error }));
      socket.once("open", resolve);
      socket.once("error", (error: Error) => fail(new Error(`WebSocket connect failed: ${error.message}`)));
      socket.once("close", (code: number) => fail(new Error(`WebSocket closed during handshake (${code})`)));
      signal?.addEventListener("abort", () => fail(new Error("Request was aborted")), { once: true });
    });

    // Past the handshake, socket-level failures are transport errors the
    // caller may retry; only errors the server itself reports are final.
    let lastActivity = Date.now();
    socket.on("message", (data: unknown) => {
      lastActivity = Date.now();
      try {
        pending.push(JSON.parse(String(data)));
      } catch (error) {
        failure = new WebSocketTransportError(`Invalid JSON frame from ${url}: ${String(error)}`);
        finished = true;
      }
      wake();
    });
    socket.on("pong", () => {
      lastActivity = Date.now();
    });
    socket.on("error", (error: Error) => {
      failure = new WebSocketTransportError(`WebSocket error: ${error.message}`, { cause: error });
      finished = true;
      wake();
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (!failure) {
        failure = new WebSocketTransportError(
          `WebSocket closed before the response finished (${code} ${reason})`,
        );
      }
      finished = true;
      wake();
    });
    signal?.addEventListener("abort", abort, { once: true });

    keepalive = setInterval(() => {
      if (Date.now() - lastActivity > STALL_TIMEOUT_MS) {
        failure = new WebSocketTransportError(
          `WebSocket stalled: no frames or pongs for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`,
        );
        finished = true;
        socket.terminate();
        wake();
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, PING_INTERVAL_MS);

    socket.send(JSON.stringify({ type: "response.create", ...params }));

    while (true) {
      while (pending.length > 0) {
        const event = pending.shift() as { type?: string; error?: unknown };
        if (event?.type === "error") {
          const detail = event.error as { message?: string } | undefined;
          throw new Error(detail?.message ?? JSON.stringify(event.error ?? event));
        }
        yield event;
        if (event?.type && TERMINAL_EVENTS.has(event.type)) return;
      }
      if (failure) throw failure;
      if (finished) throw new WebSocketTransportError("WebSocket closed before the response finished");
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
    signal?.removeEventListener("abort", abort);
    try {
      socket.close(1000, "done");
    } catch {
      /* already closed */
    }
  }
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * `ProviderStreams` that prefers websockets and falls back to pi's stock SSE
 * implementation. Transport failures — including mid-stream drops like a 1006
 * close — retry the request: once more over websocket, then over SSE, all
 * within the same event stream. A restart is safe because every event carries
 * the full partial message and replaces the previous one downstream; only the
 * single `start` event must not repeat. The breaker turns chronic flakiness
 * into an outright switch to SSE.
 */
export function responsesApiWithWebSocket(
  breaker: WebSocketBreaker,
  isEnabled: (providerId: string) => boolean,
): ProviderStreams {
  const sse = openAIResponsesApi();

  const run = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const out = createAssistantMessageEventStream();

    void (async () => {
      const providerId = model.provider;
      let startEmitted = false;

      const emitFailure = (error: Error) => {
        const output = emptyAssistantMessage(model);
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error.message;
        out.push({ type: "error", reason: output.stopReason, error: output });
        out.end();
      };

      if (isEnabled(providerId) && breaker.allows(providerId)) {
        // The payload hook runs once so retries resend the identical request.
        let params: Record<string, unknown>;
        try {
          params = buildParams(model, context, options);
          const patched = await options?.onPayload?.(params, model);
          if (patched !== undefined) params = patched as Record<string, unknown>;
        } catch (error) {
          emitFailure(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        for (let attempt = 1; attempt <= WS_ATTEMPTS; attempt++) {
          const output = emptyAssistantMessage(model);
          try {
            const events = streamEvents(model, params, options);
            // Pull the first frame before emitting anything: a handshake
            // failure must stay invisible so the retry below is seamless.
            const first = await events.next();
            if (!startEmitted) {
              startEmitted = true;
              out.push({ type: "start", partial: output });
            }

            const all = (async function* () {
              if (!first.done) yield first.value;
              yield* events;
            })();
            await processResponsesStream(all, output, out, model);

            if (options?.signal?.aborted) throw new Error("Request was aborted");
            if (output.stopReason === "aborted" || output.stopReason === "error") {
              throw new Error(output.errorMessage ?? "An unknown error occurred");
            }

            breaker.recordSuccess(providerId);
            out.push({ type: "done", reason: output.stopReason, message: output });
            out.end();
            return;
          } catch (error) {
            const failed = error instanceof Error ? error : new Error(String(error));
            if (options?.signal?.aborted || !isTransportError(failed)) {
              // The user aborted, or the server itself rejected/failed the
              // response — retrying would re-pay for the same failure.
              emitFailure(failed);
              return;
            }
            breaker.recordFailure(providerId, failed);
            if (attempt < WS_ATTEMPTS && breaker.allows(providerId)) {
              console.warn(
                `[${providerId}] websocket attempt ${attempt} failed (${failed.message}) — retrying`,
              );
              await delay(RETRY_DELAY_MS, options?.signal);
              if (options?.signal?.aborted) {
                emitFailure(new Error("Request was aborted"));
                return;
              }
              continue;
            }
            console.warn(
              `[${providerId}] websocket failed (${failed.message}) — falling back to SSE for this request`,
            );
            break;
          }
        }
      }

      // SSE path: pi's own implementation, piped through untouched — except a
      // duplicate `start` when a websocket attempt already emitted one.
      try {
        for await (const event of sse.streamSimple(model, context, options)) {
          if (event.type === "start") {
            if (startEmitted) continue;
            startEmitted = true;
          }
          out.push(event as AssistantMessageEvent);
        }
        out.end();
      } catch (error) {
        emitFailure(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return out;
  };

  return { stream: run, streamSimple: run } as ProviderStreams;
}
