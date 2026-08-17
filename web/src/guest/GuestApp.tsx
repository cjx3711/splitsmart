/**
 * The guest shell.
 *
 * One session load at the top, one of four outcomes underneath it:
 *
 *   the landing route      /l/:token, which stashes the secret and gets out of
 *                          the URL before anyone screenshots it
 *   a dead link            401. "Ask for a new one", or "log in" when the
 *                          person has since claimed their account
 *   no name picked yet     409 on a general group link. Show the picker
 *   the app                the ordinary screens, with owner-only controls gone
 *
 * There is no Dexie here, no sync, and no offline. A link is revocable and a
 * local copy is not, so losing the network is a needs-connection screen rather
 * than last week's balances. See docs/GUEST.md.
 */
import { useCallback, useEffect, useState, createContext, useContext } from "react";
import { Routes, Route, Navigate, Link, useNavigate, useParams } from "react-router-dom";
import { CurrencyProvider } from "../money.tsx";
import { Logo } from "../Logo.tsx";
import { Footer } from "../Footer.tsx";
import {
  guestApi,
  GuestLinkError,
  GuestOfflineError,
  GuestPickerError,
  type GuestSession,
} from "./guestApi.ts";
import {
  clearGuestLink,
  readActingAs,
  readGuestLink,
  writeActingAs,
  writeGuestLink,
} from "./guestStorage.ts";
import { GuestGroup } from "./GuestGroup.tsx";
import { GuestFriend } from "./GuestFriend.tsx";
import { GuestExpense } from "./GuestExpense.tsx";
import { GuestPicker } from "./GuestPicker.tsx";
import { ClaimBanner } from "./ClaimBanner.tsx";

interface GuestContextValue {
  session: GuestSession;
  /**
   * Where the logo goes, and the root of every breadcrumb trail.
   *
   * A guest has no dashboard, so "home" depends on what the link is: the bound
   * group for a group link, the you-and-them page for a friend link. Computed
   * once here so the header, the trails and the landing redirect cannot
   * disagree about it.
   */
  homePath: string;
  reload: () => Promise<void>;
}

const GuestContext = createContext<GuestContextValue | null>(null);

export function useGuest(): GuestContextValue {
  const value = useContext(GuestContext);
  if (!value) throw new Error("useGuest outside the guest shell");
  return value;
}

type State =
  | { status: "loading" }
  | { status: "ready"; session: GuestSession }
  | { status: "dead"; message: string; claimed: boolean }
  | { status: "offline" };

export function GuestApp() {
  return (
    <CurrencyProvider>
      <Routes>
        {/* The secret arrives here and leaves the URL immediately. */}
        <Route path="/l/:token" element={<Landing />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </CurrencyProvider>
  );
}

/**
 * `/guest/l/:token`: take the secret out of the URL and put it in storage.
 *
 * `history.replaceState` rather than a push, so Back does not walk into the
 * secret again, and so a screenshot or a Referer header does not carry it. The
 * cost is that bookmarking this page bookmarks a URL without the credential;
 * the original link is what gets you back on a new device, which is the
 * trade docs/GUEST.md names explicitly.
 */
function Landing() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    writeGuestLink(token);

    let live = true;
    void guestApi
      .session()
      .then((session) => {
        if (!live) return;
        navigate(landingTarget(session), { replace: true });
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof GuestLinkError) {
          clearGuestLink();
          setError(err.message);
        } else if (err instanceof GuestOfflineError) {
          setError("You need a connection to open this link.");
        } else {
          setError("Something went wrong opening this link.");
        }
      });

    return () => {
      live = false;
    };
  }, [token, navigate]);

  if (error) {
    return (
      <Standalone>
        <h1>This link</h1>
        <p className="error">{error}</p>
      </Standalone>
    );
  }

  return (
    <Standalone>
      <p className="muted">Opening…</p>
    </Standalone>
  );
}

/** Where a freshly-opened link should land, once we know what it is. */
function landingTarget(session: GuestSession): string {
  if (session.needsPicker) return "/pick";
  if (session.kind === "friend") return "/friend";
  return session.group ? `/groups/${session.group.id}` : "/pick";
}

function Shell() {
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    if (!readGuestLink()) {
      setState({ status: "dead", message: "There is no link on this device.", claimed: false });
      return;
    }
    try {
      setState({ status: "ready", session: await guestApi.session() });
    } catch (err) {
      if (err instanceof GuestLinkError) {
        setState({ status: "dead", message: err.message, claimed: err.reason === "claimed" });
      } else if (err instanceof GuestOfflineError) {
        setState({ status: "offline" });
      } else if (err instanceof GuestPickerError) {
        // /session answers without a pick, so this should not happen; treat it
        // as "go and pick" rather than as a dead link.
        setState({ status: "dead", message: "Pick who you are to continue.", claimed: false });
      } else {
        setState({
          status: "dead",
          message: err instanceof Error ? err.message : "Something went wrong.",
          claimed: false,
        });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <Standalone>
        <p className="muted">Loading…</p>
      </Standalone>
    );
  }

  if (state.status === "offline") return <NeedsConnection onRetry={load} />;
  if (state.status === "dead") return <DeadLink message={state.message} claimed={state.claimed} />;

  const { session } = state;

  return (
    <GuestContext.Provider value={{ session, homePath: landingTarget(session), reload: load }}>
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {/* Same as the app: the mark is the way home. */}
          <Link
            to={landingTarget(session)}
            style={{ textDecoration: "none", color: "inherit" }}
            aria-label="Home"
          >
            <Logo />
          </Link>
          <span className="guest-chip">Guest</span>
        </div>
        <div className="topbar-right">
          {session.actingAs && (
            <span className="muted">
              {session.actingAs.firstName}
              {session.canRepick && (
                <>
                  {" "}
                  <Link to="/pick" className="link">
                    not you?
                  </Link>
                </>
              )}
            </span>
          )}
        </div>
      </header>

      <ClaimBanner />

      <main className="main">
        <Routes>
          <Route path="/pick" element={<GuestPicker />} />
          <Route
            path="/"
            element={<Navigate to={landingTarget(session)} replace />}
          />
          <Route path="/groups/:id" element={<Guarded><GuestGroup /></Guarded>} />
          <Route path="/friend" element={<Guarded><GuestFriend /></Guarded>} />
          <Route path="/expenses/:id" element={<Guarded><GuestExpense /></Guarded>} />
          {/*
            The shared ExpenseList links people to /friends/:id, which is a
            logged-in screen. Send those back somewhere that exists here rather
            than rendering a dead end.
          */}
          <Route path="/friends/:id" element={<Navigate to={landingTarget(session)} replace />} />
          <Route path="*" element={<p className="muted">Not found.</p>}
          />
        </Routes>
      </main>

      <Footer />
    </GuestContext.Provider>
  );
}

/** Nothing but the picker renders until a name has been settled. */
function Guarded({ children }: { children: React.ReactNode }) {
  const { session } = useGuest();
  if (session.needsPicker) return <Navigate to="/pick" replace />;
  return <>{children}</>;
}

function Standalone({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <Logo />
      </header>
      <main className="main">
        <div className="auth stack">{children}</div>
      </main>
      <Footer />
    </>
  );
}

function DeadLink({ message, claimed }: { message: string; claimed: boolean }) {
  return (
    <Standalone>
      <h1>{claimed ? "You have an account now" : "This link no longer works"}</h1>
      <p className="muted">{message}</p>
      <p>
        {claimed ? (
          <a href="/app/login" className="mkt-btn">
            Log in
          </a>
        ) : (
          <button
            className="secondary"
            onClick={() => {
              clearGuestLink();
              window.location.href = "/";
            }}
          >
            Start over
          </button>
        )}
      </p>
    </Standalone>
  );
}

/**
 * The offline screen, and the reason the guest shell has one.
 *
 * A logged-in user gets their own copy of their data. A guest gets a view that
 * the owner can withdraw, so there is nothing here to fall back on: showing a
 * cached balance would be showing data the owner may have revoked access to
 * ten minutes ago. See docs/GUEST.md, "Deliberately not doing".
 */
function NeedsConnection({ onRetry }: { onRetry: () => void | Promise<void> }) {
  return (
    <Standalone>
      <h1>You need a connection</h1>
      <p className="muted">
        Guest links are checked with the server every time, so this page has
        nothing saved on your device. It will work again as soon as you are
        back online.
      </p>
      <p>
        <button onClick={() => void onRetry()}>Try again</button>
      </p>
    </Standalone>
  );
}

/** Exported for the picker: writing the pick reloads the whole session. */
export function pickPerson(userId: string): void {
  writeActingAs(userId);
}

export { readActingAs };
