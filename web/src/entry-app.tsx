/**
 * The logged-in shell, mounted under the /app basename.
 *
 * Two things happen here that do not happen in the guest shell:
 *
 *   1. A guest secret left in localStorage from an earlier visit is cleared.
 *      Same origin, so both shells can see each other's storage; a leftover
 *      link mixing with a real session is exactly the confusion the namespaced
 *      key exists to prevent, and the app is the side that knows a session has
 *      taken over.
 *   2. The service worker for /app/ is registered, claiming that scope before
 *      offline writes land. See docs/OFFLINE.md and web/public/app/sw.js.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { clearGuestLink } from "./guest/guestStorage.ts";
import "./styles.css";

clearGuestLink();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <App />
    </BrowserRouter>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {
      // A missing service worker costs an offline shell, not the app.
    });
  });
}
