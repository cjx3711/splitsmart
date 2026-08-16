import { useEffect, useState, createContext, useContext, type ReactNode } from "react";
import { Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import { api, type ApiUser } from "./api.ts";
import { Login } from "./pages/Login.tsx";
import { Groups } from "./pages/Groups.tsx";
import { GroupDetail } from "./pages/GroupDetail.tsx";
import { Join } from "./pages/Join.tsx";
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

export function App() {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, loading }}>
      <Header />
      <EmailVerificationBanner />
      <div className="container">
        <Routes>
          {/* Public: an invite link must work before you have an account. */}
          <Route path="/join/:token" element={<Join />} />
          {/* Public: the link is often opened in a different browser. */}
          <Route path="/verify/:token" element={<Verify />} />
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Protected><Groups /></Protected>} />
          <Route path="/groups/:id" element={<Protected><GroupDetail /></Protected>} />
          <Route path="/settings" element={<Protected><Settings /></Protected>} />
          <Route path="*" element={<p>Not found.</p>} />
        </Routes>
      </div>
    </AuthContext.Provider>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Header() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await api.logout().catch(() => {});
    setUser(null);
    navigate("/login");
  }

  return (
    <header className="app">
      <Link to="/">SplitSmart</Link>
      {user && (
        <span className="row" style={{ gap: "1rem" }}>
          <Link to="/settings" className="muted">
            {user.firstName}
            {user.isGhost ? " (guest)" : ""}
          </Link>
          <button className="link" onClick={handleLogout}>
            Log out
          </button>
        </span>
      )}
    </header>
  );
}
