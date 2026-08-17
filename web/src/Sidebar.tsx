/**
 * The left rail: dashboard, activity, all expenses, then groups and friends.
 *
 * It owns the group and friend lists rather than each page fetching its own,
 * because they are visible on every screen. Pages that change either list call
 * useSidebarRefresh(). See App.tsx.
 */
import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, fullName, type Group, type Friend } from "./api.ts";
import { useSidebarVersion } from "./App.tsx";
import { GroupTypeIcon } from "./groupTypes.tsx";

const SIDEBAR_GROUP_LIMIT = 5;
const SIDEBAR_FRIEND_LIMIT = 10;

/** ULIDs sort in creation order, which is close enough to "latest" for the rail. */
function byNewestId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

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
  const filteredGroups = useMemo(
    () => groups.filter((g) => g.name.toLowerCase().includes(query)),
    [groups, query],
  );
  const filteredFriends = useMemo(
    () => friends.filter((f) => fullName(f).toLowerCase().includes(query)),
    [friends, query],
  );
  const sidebarGroups = useMemo(() => {
    const sorted = byNewestId(filteredGroups);
    return query ? sorted : sorted.slice(0, SIDEBAR_GROUP_LIMIT);
  }, [filteredGroups, query]);
  const sidebarFriends = useMemo(() => {
    const sorted = byNewestId(filteredFriends);
    return query ? sorted : sorted.slice(0, SIDEBAR_FRIEND_LIMIT);
  }, [filteredFriends, query]);
  const hasMoreGroups = !query && filteredGroups.length > SIDEBAR_GROUP_LIMIT;
  const hasMoreFriends = !query && filteredFriends.length > SIDEBAR_FRIEND_LIMIT;

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
          <NavLink to="/groups" end style={{ textDecoration: "none", color: "inherit" }}>
            Groups
          </NavLink>
          <NavLink to="/groups/new" className="link" style={{ textDecoration: "none" }}>
            + add
          </NavLink>
        </div>
        {sidebarGroups.length === 0 ? (
          <p className="nav-empty">{groups.length === 0 ? "No groups yet." : "No matches."}</p>
        ) : (
          sidebarGroups.map((g) => (
            <NavLink key={g.id} to={`/groups/${g.id}`} className={navClass}>
              <GroupTypeIcon type={g.group_type} className="nav-item-icon" />
              <span className="nav-item-label">{g.name}</span>
            </NavLink>
          ))
        )}
        {hasMoreGroups && (
          <NavLink to="/groups" className="nav-show-more">
            Show more ({filteredGroups.length - SIDEBAR_GROUP_LIMIT})
          </NavLink>
        )}
      </div>

      <div className="nav-section">
        <div className="nav-heading">
          <NavLink to="/friends" end style={{ textDecoration: "none", color: "inherit" }}>
            Friends
          </NavLink>
          <NavLink to="/friends/new" className="link" style={{ textDecoration: "none" }}>
            + add
          </NavLink>
        </div>
        {sidebarFriends.length === 0 ? (
          <p className="nav-empty">{friends.length === 0 ? "No friends yet." : "No matches."}</p>
        ) : (
          sidebarFriends.map((f) => (
            <NavLink key={f.id} to={`/friends/${f.id}`} className={navClass}>
              <span className={f.is_ghost === 0 ? "dot dot--joined" : "dot"} />
              <span className="nav-item-label">{fullName(f)}</span>
            </NavLink>
          ))
        )}
        {hasMoreFriends && (
          <NavLink to="/friends" className="nav-show-more">
            Show more ({filteredFriends.length - SIDEBAR_FRIEND_LIMIT})
          </NavLink>
        )}
      </div>
    </nav>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? "nav-item active" : "nav-item";
}
