// Dev/demo mode: PI_DESKTOP_FAUX=1 registers pi's faux test provider with a
// scripted conversation, so the whole pipeline — streamed text, every tool
// card, approval, live output — can be exercised without an API key. The tools
// really run, so this doubles as a visual smoke test for the transcript.
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";

const DEMO_FILE = "pi-demo.txt";
const DEMO_CONTENT = [
  "hello from pi desktop",
  "this file was written by the demo provider",
  "line three",
  "line four",
  "",
].join("\n");

export function maybeRegisterFauxDemo(models: MutableModels): Model<Api> | undefined {
  if (process.env.PI_DESKTOP_FAUX !== "1") return undefined;

  const faux = fauxProvider({ tokensPerSecond: 240 });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking(
          [
            "Let me plan this out.",
            "",
            "**Steps:**",
            "",
            "1. `write` a small file",
            "2. `read` it back to confirm",
            "3. `edit` one line",
            "",
            "The file only needs a few lines:",
            "",
            "```text",
            "hello from pi desktop",
            "line three",
            "```",
            "",
            "That should be enough to show each tool.",
          ].join("\n"),
        ),
        fauxText("I'll create a small file to work with."),
        fauxToolCall("write", { path: DEMO_FILE, content: DEMO_CONTENT }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("read", { path: DEMO_FILE })], { stopReason: "toolUse" }),
    fauxAssistantMessage(
      [
        fauxText("Now a small edit:"),
        fauxToolCall("edit", {
          path: DEMO_FILE,
          edits: [{ oldText: "line three", newText: "line three (edited by the demo)" }],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: `wc -l ${DEMO_FILE} && echo done` })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      "All set — I wrote `pi-demo.txt`, read it back, edited one line, and counted the lines.\n\n" +
        "```bash\nwc -l pi-demo.txt\n```\n\nAnything else?",
    ),
    fauxAssistantMessage("Still here — this is the faux demo provider, so replies are scripted."),
  ]);
  return faux.getModel() as Model<Api>;
}
