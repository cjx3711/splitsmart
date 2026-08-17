/**
 * The logged-in shell, everything under the /app basename.
 *
 * The marketing pages moved out to their own document (see MarketingApp.tsx),
 * so every route here is for someone who has, or is about to have, a session.
 * Paths below are relative to /app: `/groups` renders at /app/groups.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Routes, Route, Link, Navigate, useLocation } from "react-router-dom";
import { CurrencyProvider } from "./money.tsx";
import { SyncProvider, useSync } from "./sync/SyncProvider.tsx";
import { SyncStatusBar } from "./SyncStatusBar.tsx";
import { Conflicts } from "./pages/Conflicts.tsx";
import { Logo } from "./Logo.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Login } from "./pages/Login.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Groups } from "./pages/Groups.tsx";
import { NewGroup } from "./pages/NewGroup.tsx";
import { GroupDetail } from "./pages/GroupDetail.tsx";
import { Friends } from "./pages/Friends.tsx";
import { NewFriend } from "./pages/NewFriend.tsx";
import { FriendDetail } from "./pages/FriendDetail.tsx";
import { AllExpenses } from "./pages/AllExpenses.tsx";
import { ExpenseDetail } from "./pages/ExpenseDetail.tsx";
import { Activity } from "./pages/Activity.tsx";
import { Claim } from "./pages/Claim.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Import } from "./pages/Import.tsx";
import { Verify } from "./pages/Verify.tsx";
import { EmailVerificationBanner } from "./EmailVerificationBanner.tsx";
import { AddExpenseDialog } from "./AddExpenseDialog.tsx";
import { Footer } from "./Footer.tsx";

/**
 * The session, as every screen has always read it.
 *
 * Now a view onto `SyncProvider`, which owns it along with the mirror the user id
 * namespaces and the loop that fills it — see web/src/sync/SyncProvider.tsx for
 * why those three cannot be resolved apart. Kept under this name and shape so the
 * pages did not all have to change to gain an offline session.
 */
export function useAuth() {
  const { user, setUser, loading } = useSync();
  return { user, setUser, loading };
}

/**
 * "I have just changed something the server owns; catch up."
 *
 * The sidebar's lists used to be state a page had to invalidate by bumping a
 * counter. They are Dexie live queries now, so anything that reaches the mirror
 * shows up on its own and no page has to say so. What still needs saying is the
 * opposite: the ONLINE-ONLY writes — adding a friend, creating a group, adding a
 * member — land on the server and would otherwise not appear until the next
 * five-minute tick. This pulls immediately instead.
 *
 * Kept under the old name because the call sites mean exactly what they always
 * meant; only the mechanism underneath is different.
 */
export function useSidebarRefresh() {
  return useSync().syncNow;
}

export function App() {
  return (
    <SyncProvider>
      <CurrencyProvider>
        <Shell />
      </CurrencyProvider>
    </SyncProvider>
  );
}

function Shell() {
  const { user } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const appChrome = Boolean(user);

  // Close the mobile drawer whenever the route changes, so tapping a group
  // doesn't leave the menu covering the screen you just asked for.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const routes = (
    <Routes>
      {/* Public: the link is often opened in a different browser. */}
      <Route path="/verify/:token" element={<Verify />} />
      <Route path="/login" element={<Login />} />
      {/*
        Reached from the guest shell, holding a link secret, once you have an
        account. Not protected: arriving here logged out is the normal case,
        and the page sends you to register and comes back.
      */}
      <Route path="/claim" element={<Claim />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/groups" element={<Protected><Groups /></Protected>} />
      <Route path="/groups/new" element={<Protected><NewGroup /></Protected>} />
      <Route path="/groups/:id" element={<Protected><GroupDetail /></Protected>} />
      <Route path="/friends" element={<Protected><Friends /></Protected>} />
      <Route path="/friends/new" element={<Protected><NewFriend /></Protected>} />
      <Route path="/friends/:id" element={<Protected><FriendDetail /></Protected>} />
      <Route path="/expenses" element={<Protected><AllExpenses /></Protected>} />
      <Route path="/expenses/:id" element={<Protected><ExpenseDetail /></Protected>} />
      <Route path="/activity" element={<Protected><Activity /></Protected>} />
      {/* Writes the server refused or overtook. Non-negotiable: an expense that
          silently vanishes between devices is worse than an error message. */}
      <Route path="/conflicts" element={<Protected><Conflicts /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/import" element={<Protected><Import /></Protected>} />
      <Route path="*" element={<p className="muted">Not found.</p>} />
    </Routes>
  );

  return (
    <>
      <TopBar
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        appChrome={appChrome}
      />
      {appChrome && <EmailVerificationBanner />}
      {appChrome && <SyncStatusBar />}
      {appChrome ? (
        <div className="shell">
          <Sidebar className={menuOpen ? "rail open" : "rail"} />
          <main className="main">{routes}</main>
        </div>
      ) : (
        <main className="main" style={{ maxWidth: "none" }}>
          {routes}
        </main>
      )}
      <Footer />
    </>
  );
}

/**
 * The gate.
 *
 * `loading` is now only the moment before the CACHED profile answers, which offline
 * is a few milliseconds of IndexedDB rather than a round trip. And `!user` really
 * does mean "no session and nothing cached": a failed or 401'd `/auth/me` while a
 * profile exists locally is `reconnecting`, not a logout, because throwing the
 * outbox away over a dropped connection would lose somebody's unsynced dinner.
 * See web/src/sync/SyncProvider.tsx.
 */
function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">Loading…</p>;
  if (!user) {
    // Carry where they were going, so logging in lands them there rather than
    // on the dashboard. Guest claim links depend on this.
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/** Group and friend detail screens carry their own add-expense action. */
function pageHasAddExpense(pathname: string): boolean {
  return /^\/groups\/[^/]+$/.test(pathname) || /^\/friends\/[^/]+$/.test(pathname);
}

function TopBar({
  menuOpen,
  onToggleMenu,
  appChrome,
}: {
  menuOpen: boolean;
  onToggleMenu: () => void;
  appChrome: boolean;
}) {
  const { user } = useAuth();
  const location = useLocation();
  const [adding, setAdding] = useState(false);
  const showAddExpense = appChrome && !pageHasAddExpense(location.pathname);

  return (
    <header className="topbar">
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        {appChrome && (
          <button
            className="icon menu-toggle"
            onClick={onToggleMenu}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Hide menu" : "Show menu"}
          >
            ☰
          </button>
        )}
        <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
          <Logo />
        </Link>
      </div>

      <div className="topbar-right">
        {!appChrome && (
          <nav className="topbar-public">
            {/* Another document; a route would 404 inside this shell. */}
            <a href="/about">About</a>
            <a href="/docs">API</a>
          </nav>
        )}
        {showAddExpense && (
          <>
            <button className="inline" onClick={() => setAdding(true)}>
              Add Expense
            </button>
            <AddExpenseDialog open={adding} onClose={() => setAdding(false)} />
          </>
        )}
        {!user && location.pathname !== "/login" && (
          <Link to="/login" className="mkt-btn mkt-btn-sm">
            Log in
          </Link>
        )}
      </div>
    </header>
  );
}
