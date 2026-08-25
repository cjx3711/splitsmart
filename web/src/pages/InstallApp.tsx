/**
 * "Install the App" — a plain-language walkthrough of the three install paths
 * (iOS Safari, Android/Chrome, desktop), plus a real Install button on the
 * platforms that support one.
 *
 * The PWA plumbing this page describes (manifest, service worker, icons) is
 * already in place; see web/public/app/ and web/vite.config.ts. This page is
 * the missing piece — nothing told a user the option existed.
 *
 * `Sidebar.tsx` only links here when `useIsStandalone()` is false, so anyone
 * who arrives already has something to gain from reading it. This page still
 * has to handle the standalone case on its own: a bookmark, a shared link, or
 * simply hitting Back after installing can land here anyway.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LuCheck, LuDownload, LuShare, LuSquarePlus } from "react-icons/lu";
import {
  hasInstallPrompt,
  promptInstall,
  subscribeInstallPrompt,
  useIsStandalone,
} from "../pwaInstall.ts";

type Platform = "ios" | "android" | "desktop";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as "Macintosh" with a touch screen, unlike a real Mac.
  const isIPad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPod|iPad/.test(ua) || isIPad) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

const PLATFORM_LABEL: Record<Platform, string> = {
  ios: "iPhone or iPad",
  android: "Android",
  desktop: "Desktop",
};

export function InstallApp() {
  const standalone = useIsStandalone();
  const [platform, setPlatform] = useState<Platform>("desktop");
  const [canPrompt, setCanPrompt] = useState(hasInstallPrompt());
  const [installing, setInstalling] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => setPlatform(detectPlatform()), []);
  useEffect(() => subscribeInstallPrompt(() => setCanPrompt(hasInstallPrompt())), []);

  if (standalone) {
    return (
      <>
        <h1>You're already using the app</h1>
        <div className="card stack install-done">
          <LuCheck size={22} aria-hidden="true" />
          <p>
            This is running as an installed app, not a browser tab. Nothing left to do here.
          </p>
          <p className="muted">
            <Link to="/">Back to the dashboard</Link>
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Install the "App"</h1>
      <p className="muted install-intro">
        A{" "}
        <a
          href="https://en.wikipedia.org/wiki/Progressive_web_app"
          target="_blank"
          rel="noreferrer"
        >
          progressive web app
        </a>{" "}
        (PWA) is a website that can install like a normal app: its own icon, no address bar,
        and it opens straight to your dashboard. SplitSmart is one. It's still the same
        site. Nothing to download from a store, nothing to keep updated by hand.
      </p>

      {canPrompt && (
        <div className="card install-cta">
          <div>
            <strong>Ready to install</strong>
            <p className="muted">Your browser can add it for you right now.</p>
          </div>
          <button
            type="button"
            className="inline"
            disabled={installing}
            onClick={() => {
              setInstalling(true);
              setDeclined(false);
              void promptInstall()
                .then((accepted) => {
                  if (!accepted) setDeclined(true);
                })
                .finally(() => setInstalling(false));
            }}
          >
            <LuDownload aria-hidden="true" /> {installing ? "Opening…" : "Install SplitSmart"}
          </button>
        </div>
      )}
      {declined && <p className="muted">No changes made. The steps below still work anytime.</p>}

      <div className="install-platform-picker" role="tablist" aria-label="Choose your device">
        {(["ios", "android", "desktop"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={platform === p}
            className={platform === p ? "install-platform-btn active" : "install-platform-btn"}
            onClick={() => setPlatform(p)}
          >
            {PLATFORM_LABEL[p]}
          </button>
        ))}
      </div>

      {platform === "ios" && <IosSteps />}
      {platform === "android" && <AndroidSteps canPrompt={canPrompt} />}
      {platform === "desktop" && <DesktopSteps canPrompt={canPrompt} />}

      <h2>What you get</h2>
      <ul className="install-benefits">
        <li>An icon on your home screen or dock, like any other app.</li>
        <li>Opens full-screen, with no address bar or browser chrome.</li>
        <li>
          Your groups, friends and expenses still work offline; see{" "}
          <Link to="/settings">Settings</Link> for what stays on this device.
        </li>
        <li>No app store account, no separate download, no update prompts.</li>
      </ul>
    </>
  );
}

function IosSteps() {
  return (
    <ol className="install-steps card">
      <li>
        Open this page in <strong>Safari</strong>. Chrome and other browsers on iOS cannot
        install a home-screen app.
      </li>
      <li>
        Tap the <strong>Share</strong> icon <LuShare aria-hidden="true" className="icon-glyph" />{" "}
        in the toolbar.
      </li>
      <li>
        Scroll down and tap <strong>Add to Home Screen</strong>.
      </li>
      <li>
        Tap <strong>Add</strong> in the top-right corner.
      </li>
    </ol>
  );
}

function AndroidSteps({ canPrompt }: { canPrompt: boolean }) {
  return (
    <ol className="install-steps card">
      <li>
        Open this page in <strong>Chrome</strong> (or another Chromium browser).
      </li>
      {canPrompt ? (
        <li>Use the Install button above. Chrome offered it because it detected the app.</li>
      ) : (
        <>
          <li>
            Tap the <strong>⋮</strong> menu in the top-right corner.
          </li>
          <li>
            Tap <strong>Add to Home screen</strong>, then <strong>Install</strong>.
          </li>
        </>
      )}
    </ol>
  );
}

function DesktopSteps({ canPrompt }: { canPrompt: boolean }) {
  return (
    <ol className="install-steps card">
      <li>
        Open this page in <strong>Chrome</strong>, <strong>Edge</strong>, or another Chromium
        browser. Firefox and Safari on desktop don't support installing sites as apps.
      </li>
      {canPrompt ? (
        <li>Use the Install button above.</li>
      ) : (
        <li>
          Click the install icon <LuSquarePlus aria-hidden="true" className="icon-glyph" /> at
          the right of the address bar, or open the browser's menu and look for{" "}
          <strong>Install SplitSmart…</strong>.
        </li>
      )}
    </ol>
  );
}
