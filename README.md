# pi desktop

A desktop coding agent built on the [pi agent framework](https://github.com/earendil-works/pi)
(`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`), Electron, and React.

The agent runs in the Electron main process on pi's `AgentHarness`, with pi's built-in
coding tools — `bash`, `read`, `edit`, `write` — executing against a workspace folder you
choose. Chats are persisted as JSONL transcripts by pi's session repository, and every
agent event streams to the renderer over IPC.

## Features

- **Chats with history** — sessions are stored as pi JSONL transcripts, auto-titled from
  your first message, and can be renamed, reopened, or deleted from the sidebar
- **Chats are projects** — creating a chat asks for its folder first: name a new project
  (created under `~/pi-desktop-projects`, with duplicate and invalid names rejected) or
  pick a folder already on disk. The folder is fixed for the life of the chat, so a
  transcript always matches where it ran
- **Per-chat approval policy** — whether shell commands need approval is saved in that
  chat's transcript and restored when you reopen it. Settings only sets the default for
  new chats
- **Bring your own models** — the app starts empty; add a model by picking a provider,
  entering a key, and choosing from that provider's catalog. Custom OpenAI-compatible,
  OpenAI Responses, or Anthropic Messages endpoints are supported too (Ollama, vLLM,
  LM Studio, gateways, proxies)
- **Responses over WebSocket** — custom providers using the OpenAI Responses format can
  stream over `wss` instead of SSE, matching what the Codex app does with
  `supports_websockets`. Falls back to SSE per request, and stops trying after 5
  consecutive connection failures until the app restarts
- **Real coding tools** from `pi-agent-core`, rooted at your workspace folder
- **Shell approval** — commands pause on a card in the chat with Run once / Always /
  Deny; "Always" applies to that chat only
- **Steering** — send a message while the agent works and it's injected at the next turn
  break (pi's steering queue)
- **Encrypted keys** — stored via Electron `safeStorage` in a pi `CredentialStore`, or
  read from environment variables like `ANTHROPIC_API_KEY`
- **Plain-file config** — everything the app remembers lives in `~/.pi-desktop/`
- **Token and cost tracking** per chat, read from the session's own stats

## Run

```bash
npm install
node node_modules/electron/install.js   # only if the Electron binary wasn't downloaded
npm start
```

On first launch, click **Add a model**, pick a provider, and paste an API key.

### Demo mode (no API key needed)

```bash
npm run build && PI_DESKTOP_FAUX=1 npx electron .
```

Registers pi's faux test provider with a scripted turn that exercises the whole pipeline:
streamed text → bash tool call → approval card → live output → final message. The faux
model is session-only and never written to your saved settings.

## Architecture

```
src/
  main/
    index.ts           Electron bootstrap + IPC handlers
    agent-service.ts   AgentHarness lifecycle, approval gate, app state
    session-manager.ts JsonlSessionRepo wrapper + sidebar index
    model-registry.ts  provider catalog, configured models, custom providers
    credentials.ts     safeStorage-backed pi CredentialStore
    settings.ts        behavior settings and persisted model list
    faux-demo.ts       PI_DESKTOP_FAUX=1 demo provider
    preload.cts        contextBridge → window.pi
  shared/ipc.ts        typed contract between main and renderer
  renderer/            React + Tailwind UI
```

- **`AgentHarness`** owns the turn loop and writes every message to the pi `Session`, so
  the transcript on disk is the source of truth. The renderer replays it on session
  switch and follows live events during a run.
- **`beforeToolCall`** is implemented through the harness's `tool_call` hook: it suspends
  the call until the renderer answers over IPC, and reports denials back to the model.
- **Custom providers** are built with `createProvider` from `pi-ai`, pairing a user-supplied
  base URL and model spec with the matching lazy API implementation.
- **`responses-ws.ts`** adds the websocket transport pi lacks for the Responses wire format.
  The framing follows OpenAI's own `openai/resources/responses/ws` client — connect to
  `<baseUrl>/responses` over `wss` with a bearer token, send one
  `{"type":"response.create", …}` frame, and read back the same `ResponseStreamEvent`s SSE
  delivers — so pi's `processResponsesStream` maps them unchanged and the SSE fallback is
  pi's stock implementation.
- **Per-chat settings** are appended to the session as pi *custom entries*, which persist in
  the transcript but are excluded from the model's context. The workspace is also the
  session's `cwd`; switching chats rebuilds the tools' `NodeExecutionEnv` against it.
- **Auth** flows through a single `CredentialStore`, so built-in and custom providers
  resolve keys the same way.

## Where your data lives

| Path | Contents |
|---|---|
| `~/.pi-desktop/models.json` | Models you added, the selected one, and custom provider definitions |
| `~/.pi-desktop/config.json` | Projects folder and app behavior (defaults for new chats, editor preferences) |
| `~/.pi-desktop/credentials.json` | API keys, encrypted with your OS keychain (mode `0600`) |
| Electron `userData` | Chat transcripts (`sessions/`) and their sidebar index |

`models.json` and `config.json` are plain JSON and safe to edit by hand while the app is
closed. Data written by earlier versions under Electron's `userData` directory is migrated
to `~/.pi-desktop/` automatically on first launch.

## Notes

- Tools run with your user account's permissions. Keep shell approval on unless you trust
  the task.
- Packaging: `npm i -D electron-builder` and add a target if you want a .app/.dmg; the
  build outputs everything needed under `dist/`. Point its `build.icon` at
  `assets/icon.icns`.

## Icon

`assets/icon.svg` is the source. It is drawn as plain shapes rather than text, so it needs
no font and stays crisp at every size. Regenerate the raster files after editing it:

```bash
npm run icon
```

That renders the SVG through Electron's Chromium (no image tooling to install) and writes
`assets/icon.png` for the Linux/Windows window icon and the dev dock icon, plus
`assets/icon.icns` for macOS packaging.
