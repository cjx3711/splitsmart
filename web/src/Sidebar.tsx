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
 *
 * A friend can be crossed off this rail without leaving the roster. That
 * hide is local (`hiddenFriends.ts`): they come back if you search, or if
 * a newer shared expense lands.
 */
import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { LuSettings, LuSmartphone } from "react-icons/lu";
import { compareByLastExpense } from "../../src/domain/friend-recency.ts";
import { displayName } from "./api.ts";
import { useAuth } from "./App.tsx";
import { useGroups, useRelatedPeople } from "./localData.ts";
import {
  friendIsHidden,
  hideFriend,
  loadHiddenFriends,
  saveHiddenFriends,
} from "./db/hiddenFriends.ts";
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
  const lastByFriend = friendsQuery?.last ?? {};
  const [hiddenFriends, setHiddenFriends] = useState<Record<string, string>>({});
  const groupsLoading = groupsQuery === undefined;
  const friendsLoading = friendsQuery === undefined;

  useEffect(() => {
    setHiddenFriends(user?.id ? loadHiddenFriends(user.id) : {});
  }, [user?.id]);

  const query = filter.trim().toLowerCase();
  const searching = query.length > 0;
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
  const visibleFriends = useMemo(
    () =>
      filteredFriends.filter(
        (f) => !friendIsHidden(hiddenFriends[f.id], lastByFriend[f.id] ?? "", searching),
      ),
    [filteredFriends, hiddenFriends, lastByFriend, searching],
  );
  const sidebarFriends = useMemo(
    () => (searching ? visibleFriends : visibleFriends.slice(0, SIDEBAR_FRIEND_LIMIT)),
    [visibleFriends, searching],
  );
  const hasMoreGroups = !query && filteredGroups.length > SIDEBAR_GROUP_LIMIT;
  const hasMoreFriends = !searching && friends.length > sidebarFriends.length;

  function hideFromRail(friendId: string) {
    if (!user) return;
    const next = hideFriend(hiddenFriends, friendId, lastByFriend[friendId] ?? "");
    saveHiddenFriends(user.id, next);
    setHiddenFriends(next);
  }

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
          friends.length === 0 ? (
            <p className="nav-empty">No friends yet.</p>
          ) : searching ? (
            <p className="nav-empty">No matches.</p>
          ) : null
        ) : (
          sidebarFriends.map((f) => (
            <div key={f.id} className="nav-friend">
              <NavLink to={`/friends/${f.id}`} className={navClass}>
                <span className={f.is_ghost === 0 ? "dot dot--joined" : "dot"} />
                <span className="nav-item-label">{displayName(f)}</span>
              </NavLink>
              <button
                type="button"
                className="icon nav-hide"
                onClick={() => hideFromRail(f.id)}
                aria-label={`Hide ${displayName(f)} from sidebar`}
                title="Hide from sidebar"
              >
                ✕
              </button>
            </div>
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
