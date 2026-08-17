/**
 * The guest shell, mounted under the /guest basename.
 *
 * Imports nothing from the logged-in router, nothing from Dexie, and nothing
 * from sync. It shares the pieces that render an expense (ExpenseForm,
 * SplitEditor, money.tsx) and stops there.
 *
 * The service worker is registered in DEV TOO, unlike the app's. It is
 * network-only, so it costs nothing, and its whole job is to hold the /guest/
 * scope so that no wider-scoped worker can start answering guest requests from
 * a cache. That job matters most when a stale worker is already installed,
 * which is precisely the situation a production-only guard would skip.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { GuestApp } from "./guest/GuestApp.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/guest">
      <GuestApp />
    </BrowserRouter>
  </StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/guest/sw.js", { scope: "/guest/" }).catch(() => {
      // Without it the shell still works; it just loses the guarantee that no
      // other worker is caching these pages.
    });
  });
}
