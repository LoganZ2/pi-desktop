import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";

// Main process: ESM, node_modules resolved at runtime.
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});

// Preload: CommonJS, required by the sandboxed renderer bridge.
await build({
  entryPoints: ["src/main/preload.cts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});

// Renderer: React bundle, no node access.
await build({
  entryPoints: ["src/renderer/main.tsx"],
  outfile: "dist/renderer/renderer.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  sourcemap: true,
  logLevel: "info",
});

mkdirSync("dist/renderer", { recursive: true });
cpSync("src/renderer/index.html", "dist/renderer/index.html");

execFileSync(
  process.execPath,
  [
    "node_modules/@tailwindcss/cli/dist/index.mjs",
    "-i",
    "src/renderer/app.css",
    "-o",
    "dist/renderer/app.css",
    "--minify",
  ],
  { stdio: "inherit" },
);

console.log("build complete");
