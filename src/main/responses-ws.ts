// Responses API over WebSocket, with automatic fallback to SSE.
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
/** Consecutive connect failures before a provider stops trying websockets. */
export const WS_FAILURE_LIMIT = 5;

/** Terminal server events, after which the response is finished. */
const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete"]);

/** Raised only for failures before any output — the safe point to retry over SSE. */
class WebSocketUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebSocketUnavailableError";
  }
}

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

    // Past the handshake, failures are ordinary errors: retrying over SSE would
    // duplicate whatever the model already streamed.
    socket.on("message", (data: unknown) => {
      try {
        pending.push(JSON.parse(String(data)));
      } catch (error) {
        failure = new Error(`Invalid JSON frame from ${url}: ${String(error)}`);
        finished = true;
      }
      wake();
    });
    socket.on("error", (error: Error) => {
      failure = error;
      finished = true;
      wake();
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (!failure) {
        failure = new Error(`WebSocket closed before the response finished (${code} ${reason})`);
      }
      finished = true;
      wake();
    });
    signal?.addEventListener("abort", abort, { once: true });

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
      if (finished) throw new Error("WebSocket closed before the response finished");
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
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
 * implementation — per request when a connection fails, and outright once the
 * breaker trips.
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

      if (isEnabled(providerId) && breaker.allows(providerId)) {
        const output = emptyAssistantMessage(model);
        let started = false;
        try {
          let params = buildParams(model, context, options);
          const patched = await options?.onPayload?.(params, model);
          if (patched !== undefined) params = patched as Record<string, unknown>;

          const events = streamEvents(model, params, options);
          // Pull the first frame before emitting anything: a handshake failure
          // must stay invisible so the SSE retry below is seamless.
          const first = await events.next();
          started = true;
          out.push({ type: "start", partial: output });

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
          if (!started && failed instanceof WebSocketUnavailableError) {
            breaker.recordFailure(providerId, failed);
            // Fall through to SSE — nothing has been emitted yet.
          } else {
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = failed.message;
            out.push({ type: "error", reason: output.stopReason, error: output });
            out.end();
            return;
          }
        }
      }

      // SSE path: pi's own implementation, piped through untouched.
      try {
        for await (const event of sse.streamSimple(model, context, options)) {
          out.push(event as AssistantMessageEvent);
        }
        out.end();
      } catch (error) {
        const output = emptyAssistantMessage(model);
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        out.push({ type: "error", reason: output.stopReason, error: output });
        out.end();
      }
    })();

    return out;
  };

  return { stream: run, streamSimple: run } as ProviderStreams;
}
