import {
  useEffect,
  useState,
  createContext,
  useContext,
  useCallback,
  type ReactNode,
} from "react";
import { Routes, Route, Link, Navigate, useNavigate, useLocation } from "react-router-dom";
import { api, type ApiUser } from "./api.ts";
import { CurrencyProvider } from "./money.tsx";
import { Logo } from "./Logo.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Login } from "./pages/Login.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Groups } from "./pages/Groups.tsx";
import { GroupDetail } from "./pages/GroupDetail.tsx";
import { Friends } from "./pages/Friends.tsx";
import { FriendDetail } from "./pages/FriendDetail.tsx";
import { AllExpenses } from "./pages/AllExpenses.tsx";
import { Activity } from "./pages/Activity.tsx";
import { Join } from "./pages/Join.tsx";
import { Accept } from "./pages/Accept.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Verify } from "./pages/Verify.tsx";
import { EmailVerificationBanner } from "./EmailVerificationBanner.tsx";

interface AuthContextValue {
  user: ApiUser | null;
  setUser: (user: ApiUser | null) => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  setUser: () => {},
  loading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Lets any page tell the sidebar its group/friend lists are stale.
 *
 * The sidebar owns those lists so they survive navigation, but the screens that
 * change them are elsewhere in the tree. A bumped counter is enough — no shared
 * cache, no state library.
 */
const RefreshContext = createContext<{ version: number; refresh: () => void }>({
  version: 0,
  refresh: () => {},
});

export function useSidebarRefresh() {
  return useContext(RefreshContext).refresh;
}

export function useSidebarVersion() {
  return useContext(RefreshContext).version;
}

export function App() {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, loading }}>
      <RefreshContext.Provider value={{ version, refresh }}>
        <CurrencyProvider>
          <Shell />
        </CurrencyProvider>
      </RefreshContext.Provider>
    </AuthContext.Provider>
  );
}

function Shell() {
  const { user } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile drawer whenever the route changes, so tapping a group
  // doesn't leave the menu covering the screen you just asked for.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const routes = (
    <Routes>
      {/* Public: an invite link must work before you have an account. */}
      <Route path="/join/:token" element={<Join />} />
      {/* Public: emailed friend invites carry a recovery code. */}
      <Route path="/accept/:code" element={<Accept />} />
      {/* Public: the link is often opened in a different browser. */}
      <Route path="/verify/:token" element={<Verify />} />
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/groups" element={<Protected><Groups /></Protected>} />
      <Route path="/groups/:id" element={<Protected><GroupDetail /></Protected>} />
      <Route path="/friends" element={<Protected><Friends /></Protected>} />
      <Route path="/friends/:id" element={<Protected><FriendDetail /></Protected>} />
      <Route path="/expenses" element={<Protected><AllExpenses /></Protected>} />
      <Route path="/activity" element={<Protected><Activity /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="*" element={<p className="muted">Not found.</p>} />
    </Routes>
  );

  return (
    <>
      <TopBar menuOpen={menuOpen} onToggleMenu={() => setMenuOpen((v) => !v)} />
      <EmailVerificationBanner />
      {user ? (
        <div className="shell">
          <Sidebar className={menuOpen ? "rail open" : "rail"} />
          <main className="main">{routes}</main>
        </div>
      ) : (
        <main className="main" style={{ maxWidth: "none" }}>
          {routes}
        </main>
      )}
    </>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function TopBar({ menuOpen, onToggleMenu }: { menuOpen: boolean; onToggleMenu: () => void }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await api.logout().catch(() => {});
    setUser(null);
    navigate("/login");
  }

  return (
    <header className="topbar">
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        {user && (
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

      {user && (
        <div className="topbar-right">
          <Link to="/settings" className="muted" style={{ textDecoration: "none" }}>
            {user.firstName}
            {user.isGhost ? " (guest)" : ""}
          </Link>
          <button className="link" onClick={handleLogout}>
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
