/**
 * Operator usage list: search real accounts, pin the chart window with as_of.
 * Counts only — never ledger contents. Online-only.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type AdminUserUsage } from "../api.ts";
import { HelpTip } from "../HelpTip.tsx";
import { NeedsConnection, useOnline } from "../OnlineOnly.tsx";
import { UsageChart } from "../UsageChart.tsx";
import { AdminNav } from "./AdminNav.tsx";
import { Skeleton } from "../Skeleton.tsx";

export function Admin() {
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const asOf = params.get("as_of") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(q);
  const [users, setUsers] = useState<AdminUserUsage[] | null>(null);
  const [resolvedAsOf, setResolvedAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    if (!online) return;
    try {
      setError(null);
      const res = await api.adminUsers({
        q: debouncedQ.trim() || undefined,
        asOf: asOf || undefined,
      });
      setUsers(res.users);
      setResolvedAsOf(res.asOf);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load users");
      setUsers(null);
    }
  }, [online, debouncedQ, asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  function setAsOf(next: string) {
    const nextParams = new URLSearchParams(params);
    if (next) nextParams.set("as_of", next);
    else nextParams.delete("as_of");
    setParams(nextParams, { replace: true });
  }

  if (!online) {
    return (
      <>
        <AdminNav current="usage" />
        <div className="page-head">
          <h1 className="with-help">
            Usage
            <HelpTip label="About the usage panel">
              Counts of expenses, groups, friends, recurring series, guest links
              and ghost placeholders — not a ledger browser. No amounts, titles,
              or link secrets are shown.
            </HelpTip>
          </h1>
        </div>
        <NeedsConnection what="The usage panel" />
      </>
    );
  }

  return (
    <>
      <AdminNav current="usage" />
      <div className="page-head">
        <h1 className="with-help">
          Usage
          <HelpTip label="About the usage panel">
            Counts of expenses, groups, friends, recurring series, guest links
            and ghost placeholders — not a ledger browser. No amounts, titles,
            or link secrets are shown.
          </HelpTip>
        </h1>
      </div>

      <div className="admin-toolbar">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search users"
          aria-label="Search users"
        />
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

      {error && <p className="error">{error}</p>}

      {!users ? (
        <Skeleton kind="admin" />
      ) : users.length === 0 ? (
        <p className="muted">No accounts match.</p>
      ) : (
        <div className="list">
          {users.map((u) => (
            <div key={u.id} className="list-item admin-user-row">
              <div className="admin-user-main">
                <strong>{u.name}</strong>
                <div className="muted">{u.email ?? "—"}</div>
                <div className="muted admin-user-counts">
                  {u.counts.expensesCreated} created · {u.counts.groups} groups ·{" "}
                  {u.counts.friends} friends
                </div>
              </div>
              <UsageChart series={u.series} height={40} compact />
              <Link
                className="inline"
                to={`/admin/users/${u.id}${asOf ? `?as_of=${asOf}` : resolvedAsOf ? `?as_of=${resolvedAsOf}` : ""}`}
              >
                View
              </Link>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
