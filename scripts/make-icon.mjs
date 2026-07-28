// Rasterizes assets/icon.svg into the PNG/ICNS files Electron needs.
// Chromium does the rendering, so no image tooling has to be installed.
//
//   npm run icon
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const ICONSET = path.join(ASSETS, "icon.iconset");
const RENDER_SIZE = 1024;

/** macOS iconset slots: [file name, pixel size]. */
const ICONSET_SLOTS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = readFileSync(path.join(ASSETS, "icon.svg"), "utf-8");
  const page = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:100vw;height:100vh}</style>${svg}`;

  const win = new BrowserWindow({
    width: RENDER_SIZE,
    height: RENDER_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true, sandbox: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  // One frame for fonts/filters to settle before capturing.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const master = await win.webContents.capturePage();
  win.destroy();

  const captured = master.getSize();
  if (captured.width < RENDER_SIZE) {
    console.warn(`captured ${captured.width}px, expected ${RENDER_SIZE}px — icon may be soft`);
  }

  mkdirSync(ASSETS, { recursive: true });
  rmSync(ICONSET, { recursive: true, force: true });
  mkdirSync(ICONSET, { recursive: true });

  for (const [name, size] of ICONSET_SLOTS) {
    const resized = master.resize({ width: size, height: size, quality: "best" });
    writeFileSync(path.join(ICONSET, name), resized.toPNG());
  }

  // Standalone PNG used for the Linux/Windows window icon and the dev dock icon.
  writeFileSync(
    path.join(ASSETS, "icon.png"),
    master.resize({ width: 512, height: 512, quality: "best" }).toPNG(),
  );

  if (process.platform === "darwin") {
    execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", path.join(ASSETS, "icon.icns")]);
    rmSync(ICONSET, { recursive: true, force: true });
    console.log("wrote assets/icon.icns and assets/icon.png");
  } else {
    console.log(`wrote assets/icon.png and ${ICONSET} (run iconutil on macOS for .icns)`);
  }

  app.quit();
});
