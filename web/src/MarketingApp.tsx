/**
 * The public site. No auth, no sidebar, no service worker.
 *
 * Split out of the app shell when /app and /guest became their own documents
 * (docs/GUEST.md, "Two shells"): the marketing pages have no business shipping
 * the expense editor, and the app has no business shipping the landing page.
 */
import { Routes, Route, Link } from "react-router-dom";
import { Logo } from "./Logo.tsx";
import { Footer } from "./Footer.tsx";
import { Home } from "./pages/Home.tsx";
import { About } from "./pages/About.tsx";
import { ApiDocs } from "./pages/ApiDocs.tsx";

export function MarketingApp() {
  return (
    <>
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
            <Logo />
          </Link>
        </div>
        <div className="topbar-right">
          <nav className="topbar-public">
            <Link to="/about">About</Link>
            <Link to="/docs">API</Link>
          </nav>
          {/* A different document, so a real navigation rather than a route. */}
          <a href="/app/login" className="mkt-btn mkt-btn-ghost mkt-btn-sm">
            Log in
          </a>
        </div>
      </header>

      <main className="mkt-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/docs" element={<ApiDocs />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <Footer />
    </>
  );
}

function NotFound() {
  return (
    <div className="auth stack">
      <h1>Not found</h1>
      <p className="muted">
        Looking for the app? It lives at <a href="/app">/app</a>.
      </p>
    </div>
  );
}
