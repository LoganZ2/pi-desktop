/**
 * `web_fetch` tool — an enhanced curl that goes through the approval model.
 *
 * Like the bash tool, every fetch waits for the user's approval when the chat
 * is in "ask" mode. On top of plain curl it validates and blocks private
 * network targets (SSRF), follows redirects safely, renders HTML into readable
 * text, pretty-prints JSON, and truncates large responses for the model.
 */
import { isIP } from "node:net";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const MAX_BODY_BYTES = 512 * 1024;
const MODEL_LIMIT_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

const webFetchSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch (http or https)" }),
  method: Type.Optional(
    Type.Unsafe<(typeof METHODS)[number]>({
      type: "string",
      enum: [...METHODS],
      description: "HTTP method, default GET",
    }),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Extra request headers, e.g. Authorization",
    }),
  ),
  body: Type.Optional(
    Type.String({ description: "Request body for POST/PUT/PATCH, sent as UTF-8 text" }),
  ),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds, default 30, max 120" })),
});

type WebFetchInput = {
  url: string;
  method?: (typeof METHODS)[number];
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
};

export interface WebFetchDetails {
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  redirected: boolean;
  bodyChars: number;
  truncated: boolean;
}

// ---------- SSRF guard ----------

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || // 10.0.0.0/8
      a === 127 || // loopback
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) || // link-local (cloud metadata)
      a === 0 ||
      a >= 224 // multicast + reserved
    );
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80")
    );
  }
  return false;
}

/** Throws on anything that isn't a plain public http(s) URL. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be fetched, got "${url.protocol}"`);
  }
  // URL keeps the brackets around IPv6 literals; strip them for the IP checks.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`Refusing to fetch local address "${hostname}"`);
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Refusing to fetch private address "${hostname}"`);
    return url;
  }
  // Resolve DNS once so hostnames pointing at internal networks are caught too.
  const { lookup } = await import("node:dns/promises");
  try {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length > 0 && addresses.every((entry) => isPrivateIp(entry.address))) {
      throw new Error(`"${hostname}" only resolves to private addresses`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("private addresses")) throw error;
    // DNS failure here is fine — fetch will surface a clearer error.
  }
  return url;
}

// ---------- content extraction ----------

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** Very small HTML → readable text renderer: strips noise, keeps structure cues. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg[\s\S]*?<\/svg\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|figure|table|ul|ol|blockquote|pre|form)\s*>/gi, "\n\n")
    .replace(/<\/(h[1-6])\s*>/gi, "\n\n")
    .replace(/<li(\s[^>]*)?>/gi, "\n- ")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const clean = label.replace(/<[^>]+>/g, "").trim();
      return clean ? `[${clean}](${href})` : href;
    })
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHtml(body: string, contentType: string): boolean {
  if (contentType.includes("text/html")) return true;
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test(body.slice(0, 500));
}

// ---------- tool ----------

async function readCappedBody(response: Response): Promise<{ text: string; truncated: boolean }> {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const truncated = bytes.byteLength > MAX_BODY_BYTES;
  return { text: new TextDecoder().decode(bytes.subarray(0, MAX_BODY_BYTES)), truncated };
}

export function createWebFetchTool(): AgentHarnessTool<
  { env: unknown },
  typeof webFetchSchema,
  WebFetchDetails
> {
  return {
    name: "web_fetch",
    label: "web fetch",
    description:
      "Fetch a URL over HTTP(S) — a curl that goes through the approval model. " +
      "HTML pages are rendered into readable text, JSON is pretty-printed, and large " +
      "responses are truncated. Follows redirects. Only public internet addresses are " +
      "allowed; localhost, private and link-local addresses are refused. Prefer this " +
      "over running curl in bash.",
    parameters: webFetchSchema,
    async execute(_toolCallId, params: WebFetchInput, signal, _onUpdate, _context) {
      let current = await assertPublicUrl(params.url.trim());
      const method = (params.method ?? "GET").toUpperCase();
      const timeoutMs = Math.min(
        Math.max((params.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, 1000),
        MAX_TIMEOUT_MS,
      );

      let response: Response | null = null;
      let redirected = false;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        if (signal) {
          if (signal.aborted) controller.abort();
          else signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        try {
          response = await fetch(current, {
            method,
            redirect: "manual",
            signal: controller.signal,
            headers: {
              "user-agent": "pi-desktop web_fetch (+https://github.com/LoganZ2/pi-desktop)",
              accept: "text/html,application/json,text/plain,*/*",
              ...(hop === 0 ? (params.headers ?? {}) : {}),
              ...(hop === 0 && params.body !== undefined
                ? { "content-type": (params.headers ?? {})["content-type"] ?? "text/plain" }
                : {}),
            },
            ...(hop === 0 && params.body !== undefined ? { body: params.body } : {}),
          });
        } catch (error) {
          const reason =
            controller.signal.aborted && !signal?.aborted
              ? `Request timed out after ${Math.round(timeoutMs / 1000)}s`
              : error instanceof Error
                ? error.message
                : String(error);
          throw new Error(`Could not fetch ${current}: ${reason}`);
        } finally {
          clearTimeout(timer);
        }

        const location = response.headers.get("location");
        const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && location;
        if (!isRedirect) break;
        if (hop === MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${params.url}`);
        }
        // Redirects become plain GETs (like 303) except 307/308 which keep the method;
        // bodies almost never matter for this tool's read-oriented use.
        const next = new URL(location, current);
        await assertPublicUrl(next.toString());
        current = next;
        redirected = true;
      }

      const res = response!;
      const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const { text: rawBody, truncated } = await readCappedBody(res);

      let rendered: string;
      if (looksLikeHtml(rawBody, contentType)) {
        rendered = htmlToText(rawBody) || "(page contained no readable text)";
      } else if (contentType.includes("json") || /^[\s[{]/.test(rawBody.slice(0, 20))) {
        try {
          rendered = JSON.stringify(JSON.parse(rawBody), null, 2);
        } catch {
          rendered = rawBody;
        }
      } else {
        rendered = rawBody;
      }

      const overLimit = rendered.length > MODEL_LIMIT_CHARS;
      const bodyForModel = overLimit ? rendered.slice(0, MODEL_LIMIT_CHARS) : rendered;

      const header =
        `HTTP ${res.status} ${res.statusText} · ${contentType || "unknown type"}` +
        (redirected ? ` · redirected to ${current.toString()}` : "");
      const notes = [
        truncated ? `body truncated at ${MAX_BODY_BYTES / 1024}KB` : "",
        overLimit ? `content truncated to ${MODEL_LIMIT_CHARS} chars` : "",
      ]
        .filter(Boolean)
        .join("; ");

      return {
        content: [
          {
            type: "text",
            text: `${header}\n${"—".repeat(24)}\n${bodyForModel}${notes ? `\n[${notes}]` : ""}`,
          },
        ],
        details: {
          finalUrl: current.toString(),
          status: res.status,
          statusText: res.statusText,
          contentType,
          redirected,
          bodyChars: rendered.length,
          truncated: truncated || overLimit,
        } satisfies WebFetchDetails,
      };
    },
  };
}
