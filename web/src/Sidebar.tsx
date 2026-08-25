/**
 * The left rail: dashboard, activity, all expenses, then groups and friends.
 *
 * It reads the group and friend lists from the offline mirror, which is also why
 * it no longer needs telling when they change: a Dexie live query re-runs itself
 * when a sync lands or a write is queued. useSidebarRefresh() survives for the
 * screens that still do an online-only write (adding a friend, creating a group)
 * and want the rail to catch up before the next sync tick.
 *
 * Friends and groups are ordered by last expense, from the per-user
 * localStorage recency map, not from a full balance pass. Counts live on the
 * headings; "Show all" is a link, not a tally.
 */
import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { LuSettings, LuSmartphone } from "react-icons/lu";
import { compareByLastExpense } from "../../src/domain/friend-recency.ts";
import { displayName } from "./api.ts";
import { useAuth } from "./App.tsx";
import { useGroups, useRelatedPeople } from "./localData.ts";
import { Avatar } from "./Avatar.tsx";
import { GroupTypeIcon } from "./groupTypes.tsx";
import { NavSkeleton } from "./Skeleton.tsx";
import { useIsStandalone } from "./pwaInstall.ts";

const SIDEBAR_GROUP_LIMIT = 5;
const SIDEBAR_FRIEND_LIMIT = 10;

function withCount(label: string, count: number): string {
  return count > 0 ? `${label} (${count})` : label;
}

export function Sidebar({ className }: { className: string }) {
  const { user } = useAuth();
  const standalone = useIsStandalone();
  const [filter, setFilter] = useState("");
  const groupsQuery = useGroups();
  const friendsQuery = useRelatedPeople();
  const groups = groupsQuery?.groups ?? [];
  const friends = friendsQuery?.people ?? [];
  const lastByGroup = useMemo(
    () => new Map(Object.entries(friendsQuery?.lastByGroup ?? {})),
    [friendsQuery?.lastByGroup],
  );
  const groupsLoading = groupsQuery === undefined;
  const friendsLoading = friendsQuery === undefined;

  const query = filter.trim().toLowerCase();
  const filteredGroups = useMemo(
    () => groups.filter((g) => g.name.toLowerCase().includes(query)),
    [groups, query],
  );
  const filteredFriends = useMemo(
    () => friends.filter((f) => displayName(f).toLowerCase().includes(query)),
    [friends, query],
  );
  const sidebarGroups = useMemo(() => {
    const sorted = [...filteredGroups].sort((a, b) =>
      compareByLastExpense(a.id, b.id, lastByGroup, a.name, b.name),
    );
    return query ? sorted : sorted.slice(0, SIDEBAR_GROUP_LIMIT);
  }, [filteredGroups, lastByGroup, query]);
  const sidebarFriends = useMemo(() => {
    // Friends arrive from the mirror already ordered by last shared expense.
    return query ? filteredFriends : filteredFriends.slice(0, SIDEBAR_FRIEND_LIMIT);
  }, [filteredFriends, query]);
  const hasMoreGroups = !query && filteredGroups.length > SIDEBAR_GROUP_LIMIT;
  const hasMoreFriends = !query && filteredFriends.length > SIDEBAR_FRIEND_LIMIT;

  const shownName = user ? displayName(user) : "";

  return (
    <nav className={className} aria-label="Main">
      {user && (
        <div className="sidebar-user">
          <Avatar
            id={user.id}
            name={user.name}
            nickname={user.nickname}
            iconLetters={user.iconLetters}
            iconEmoji={user.iconEmoji}
            iconHue={user.iconHue}
            iconPattern={user.iconPattern}
            size={32}
          />
          <span className="sidebar-user-name">{shownName}</span>
          <NavLink
            to="/settings"
            className={({ isActive }) => (isActive ? "sidebar-settings active" : "sidebar-settings")}
            aria-label="Settings"
          >
            <LuSettings aria-hidden="true" />
          </NavLink>
        </div>
      )}

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
      {user?.isAdmin && (
        <NavLink to="/admin" end className={navClass}>
          <span className="dot" />
          <span className="nav-item-label">Usage</span>
        </NavLink>
      )}
      {!standalone && (
        <NavLink to="/install" className={navClass}>
          <LuSmartphone className="nav-item-icon" aria-hidden="true" />
          <span className="nav-item-label">Get the app</span>
        </NavLink>
      )}

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
            {withCount("Groups", groups.length)}
          </NavLink>
          <NavLink to="/groups/new" className="link" style={{ textDecoration: "none" }}>
            + add
          </NavLink>
        </div>
        {groupsLoading ? (
          <NavSkeleton rows={4} />
        ) : sidebarGroups.length === 0 ? (
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
            Show all
          </NavLink>
        )}
      </div>

      <div className="nav-section">
        <div className="nav-heading">
          <NavLink to="/friends" end style={{ textDecoration: "none", color: "inherit" }}>
            {withCount("Friends", friends.length)}
          </NavLink>
          <NavLink to="/friends/new" className="link" style={{ textDecoration: "none" }}>
            + add
          </NavLink>
        </div>
        {friendsLoading ? (
          <NavSkeleton rows={5} />
        ) : sidebarFriends.length === 0 ? (
          <p className="nav-empty">{friends.length === 0 ? "No friends yet." : "No matches."}</p>
        ) : (
          sidebarFriends.map((f) => (
            <NavLink key={f.id} to={`/friends/${f.id}`} className={navClass}>
              <span className={f.is_ghost === 0 ? "dot dot--joined" : "dot"} />
              <span className="nav-item-label">{displayName(f)}</span>
            </NavLink>
          ))
        )}
        {hasMoreFriends && (
          <NavLink to="/friends" className="nav-show-more">
            Show all
          </NavLink>
        )}
      </div>
    </nav>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? "nav-item active" : "nav-item";
}
