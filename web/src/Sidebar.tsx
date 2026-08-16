/**
 * The left rail: dashboard, activity, all expenses, then groups and friends.
 *
 * It owns the group and friend lists rather than each page fetching its own,
 * because they are visible on every screen. Pages that change either list call
 * useSidebarRefresh() — see App.tsx.
 */
import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, fullName, type Group, type Friend } from "./api.ts";
import { useSidebarVersion } from "./App.tsx";

export function Sidebar({ className }: { className: string }) {
  const version = useSidebarVersion();
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void api.listGroups().then((r) => setGroups(r.groups)).catch(() => {});
    void api.listFriends().then((r) => setFriends(r.friends)).catch(() => {});
  }, [version]);

  const query = filter.trim().toLowerCase();
  const shownGroups = useMemo(
    () => groups.filter((g) => g.name.toLowerCase().includes(query)),
    [groups, query],
  );
  const shownFriends = useMemo(
    () => friends.filter((f) => fullName(f).toLowerCase().includes(query)),
    [friends, query],
  );

  return (
    <nav className={className} aria-label="Main">
      <NavLink to="/" end className={navClass}>
        <span className="dot" />
        <span className="nav-item-label">Dashboard</span>
      </NavLink>
      <NavLink to="/activity" className={navClass}>
        <span className="dot" />
        <span className="nav-item-label">Recent activity</span>
      </NavLink>
      <NavLink to="/expenses" className={navClass}>
        <span className="dot" />
        <span className="nav-item-label">All expenses</span>
      </NavLink>

      <div className="nav-section">
        <div className="nav-filter">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name"
            aria-label="Filter groups and friends by name"
          />
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-heading">
          <span>Groups</span>
          <NavLink to="/groups" className="link" style={{ textDecoration: "none" }}>
            + add
          </NavLink>
        </div>
        {shownGroups.length === 0 ? (
          <p className="nav-empty">{groups.length === 0 ? "No groups yet." : "No matches."}</p>
        ) : (
          shownGroups.map((g) => (
            <NavLink key={g.id} to={`/groups/${g.id}`} className={navClass}>
              <span className="dot" />
              <span className="nav-item-label">{g.name}</span>
            </NavLink>
          ))
        )}
      </div>

      <div className="nav-section">
        <div className="nav-heading">
          <span>Friends</span>
          <NavLink to="/friends" className="link" style={{ textDecoration: "none" }}>
            + add
          </NavLink>
        </div>
        {shownFriends.length === 0 ? (
          <p className="nav-empty">{friends.length === 0 ? "No friends yet." : "No matches."}</p>
        ) : (
          shownFriends.map((f) => (
            <NavLink key={f.id} to={`/friends/${f.id}`} className={navClass}>
              <span className="dot" />
              <span className="nav-item-label">{fullName(f)}</span>
            </NavLink>
          ))
        )}
      </div>
    </nav>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? "nav-item active" : "nav-item";
}
