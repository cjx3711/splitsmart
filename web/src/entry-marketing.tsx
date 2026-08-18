/**
 * The public shell: landing, about, changelog, API docs.
 *
 * Nothing here registers a service worker. A peek at `splitsmart.lastUserId`
 * is enough to swap "Log in" for "Open app"; there is no `/auth/me` and no Dexie.
 * The app is a separate document at /app, so moving between them is an
 * ordinary navigation rather than a client-side route. See docs/GUEST.md.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MarketingApp } from "./MarketingApp.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <MarketingApp />
    </BrowserRouter>
  </StrictMode>,
);
