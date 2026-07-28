// Minimal, safe markdown renderer. All input is HTML-escaped before any
// formatting is applied, so model output can never inject markup or scripts.

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(escaped: string): string {
  let out = escaped;
  // `code`
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // **bold**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // *italic* (kept after bold so ** is consumed first)
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  // [text](https://url) — http(s) only
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  return out;
}

export function renderMarkdown(source: string): string {
  const lines = source.split("\n");
  const html: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let codeLang = "";
  let listMode: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join("<br>"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listMode) {
      html.push(`</${listMode}>`);
      listMode = null;
    }
  };

  for (const rawLine of lines) {
    if (rawLine.trimStart().startsWith("```")) {
      if (inCode) {
        html.push(
          `<pre data-lang="${escapeHtml(codeLang)}"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeLines = [];
      } else {
        flushParagraph();
        flushList();
        inCode = true;
        codeLang = rawLine.trim().slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    const line = escapeHtml(rawLine);
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (listMode !== "ul") {
        flushList();
        html.push("<ul>");
        listMode = "ul";
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      if (listMode !== "ol") {
        flushList();
        html.push("<ol>");
        listMode = "ol";
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }

    if (trimmed.startsWith("&gt;")) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(trimmed.slice(4).trim())}</blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (inCode) {
    html.push(
      `<pre data-lang="${escapeHtml(codeLang)}"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
    );
  }
  flushParagraph();
  flushList();
  return html.join("\n");
}

export { escapeHtml };
