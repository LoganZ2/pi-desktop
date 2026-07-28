import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { PiBridge } from "../shared/ipc.js";
import { App } from "./App.js";

declare global {
  interface Window {
    pi: PiBridge;
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
