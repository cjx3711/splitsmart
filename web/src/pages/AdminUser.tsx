/**
 * One account's usage counts and 30-day chart. Counts only.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, type AdminUserUsage, type UsageCounts } from "../api.ts";
import { HelpTip } from "../HelpTip.tsx";
import { NeedsConnection, useOnline } from "../OnlineOnly.tsx";
import { UsageChart } from "../UsageChart.tsx";

const COUNT_LABELS: Array<{ key: keyof UsageCounts; label: string }> = [
  { key: "expensesCreated", label: "Expenses created" },
  { key: "expensesParticipated", label: "Expenses on" },
  { key: "groups", label: "Groups" },
  { key: "friends", label: "Friends" },
  { key: "recurring", label: "Recurring series" },
  { key: "guestLinks", label: "Guest links" },
  { key: "ghosts", label: "Ghost placeholders" },
];

export function AdminUser() {
  const { id } = useParams<{ id: string }>();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const asOf = params.get("as_of") ?? "";
  const [user, setUser] = useState<AdminUserUsage | null>(null);
  const [resolvedAsOf, setResolvedAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!online || !id) return;
    try {
      setError(null);
      setNotFound(false);
      const res = await api.adminUser(id, { asOf: asOf || undefined });
      setUser(res.user);
      setResolvedAsOf(res.asOf);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
        setUser(null);
      } else {
        setError(err instanceof Error ? err.message : "Could not load user");
        setUser(null);
      }
    }
  }, [online, id, asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  function setAsOf(next: string) {
    const nextParams = new URLSearchParams(params);
    if (next) nextParams.set("as_of", next);
    else nextParams.delete("as_of");
    setParams(nextParams, { replace: true });
  }

  const backQs = asOf || resolvedAsOf ? `?as_of=${asOf || resolvedAsOf}` : "";

  if (!online) {
    return (
      <>
        <p className="crumbs">
          <Link to={`/admin${backQs}`}>Usage</Link>
        </p>
        <div className="page-head">
          <h1>Usage</h1>
        </div>
        <NeedsConnection what="Usage detail" />
      </>
    );
  }

  return (
    <>
      <p className="crumbs">
        <Link to={`/admin${backQs}`}>Usage</Link>
      </p>

      <div className="page-head">
        <h1 className="with-help">
          {user?.name ?? (notFound ? "Not found" : "…")}
          <HelpTip label="About usage counts">
            These are integers only: how many expenses, groups, friends, and
            guest links this account has. No bill titles, amounts, or secrets.
          </HelpTip>
        </h1>
      </div>

      {error && <p className="error">{error}</p>}
      {notFound && <p className="muted">No such account.</p>}

      {user && (
        <>
          <div className="card stack" style={{ marginBottom: "1rem" }}>
            <div className="muted">{user.email ?? "No email"}</div>
            <label className="admin-as-of">
              <span className="muted">As of</span>
              <input
                type="date"
                value={asOf || resolvedAsOf || ""}
                aria-label="As of date"
                onChange={(e) => setAsOf(e.target.value)}
              />
            </label>
          </div>

          <h2>Expenses added (30 days)</h2>
          <div className="card" style={{ marginBottom: "1rem", overflowX: "auto" }}>
            <UsageChart series={user.series} height={120} />
          </div>

          <h2>Counts</h2>
          <div className="summary admin-counts">
            {COUNT_LABELS.map(({ key, label }) => (
              <div key={key}>
                <span className="eyebrow">{label}</span>
                <strong>{user.counts[key]}</strong>
              </div>
            ))}
          </div>
        </>
      )}

      {!user && !notFound && !error && <p className="muted">Loading…</p>}
    </>
  );
}
