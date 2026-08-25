/**
 * "Is this already installed?" plus the captured `beforeinstallprompt` event.
 *
 * Chrome/Edge/etc fire `beforeinstallprompt` once, early, and only if you called
 * `preventDefault()` on it can you replay it later from a button click instead of
 * the browser's own mini-infobar. That means it has to be caught at module load
 * (entry-app.tsx does that) and stashed somewhere a page mounted later can still
 * reach it — a React state variable born after the event fired would miss it.
 *
 * Safari (desktop and iOS) never fires this event at all; there is no
 * programmatic install there, only the manual Share-sheet / File-menu flow the
 * install page walks through instead.
 */
import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

export function hasInstallPrompt(): boolean {
  return deferredPrompt !== null;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replays the captured prompt. Resolves to whether the user accepted it. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  notify();
  void prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome === "accepted";
}

/**
 * True once the app is running as an installed app rather than a browser tab:
 * standalone display mode (Chrome/Edge/Android, and desktop after install), or
 * `navigator.standalone` (iOS Safari's older, non-standard flag — it has no
 * `display-mode` media query support).
 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true
  );
}

/**
 * `isStandalone()` as a live value: the query is read once at mount and again
 * whenever the media query flips, which happens when the OS finishes installing
 * this same page without a reload (Chrome/Edge do this on desktop).
 */
export function useIsStandalone(): boolean {
  const [standalone, setStandalone] = useState(isStandalone);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(display-mode: standalone)");
    const update = () => setStandalone(isStandalone());
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return standalone;
}
