/**
 * Every group you are in.
 *
 * Read from the offline mirror, so this screen works with no network. Creating a
 * group is online-only (docs/OFFLINE.md): it mints a server-side id that two
 * devices could not agree on, so the button says so rather than queueing.
 */
import { Link, useNavigate } from "react-router-dom";
import { groupTypeLabel } from "../groupTypes.tsx";
import { useGroups, useMirrorReady } from "../localData.ts";
import { OnlineOnly } from "../OnlineOnly.tsx";

export function Groups() {
  const data = useGroups();
  const ready = useMirrorReady();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-head">
        <h1>Groups</h1>
        <div className="page-actions">
          <OnlineOnly what="Creating a group">
            <button onClick={() => navigate("/groups/new")}>+ Add group</button>
          </OnlineOnly>
        </div>
      </div>

      {data === undefined ? (
        <p className="muted">Loading…</p>
      ) : data.groups.length === 0 ? (
        <p className="empty">
          {ready ? (
            <>
              No groups yet. <Link to="/groups/new">Create one</Link>.
            </>
          ) : (
            "Waiting for the first sync."
          )}
        </p>
      ) : (
        <div className="list">
          {data.groups.map((group) => (
            <Link key={group.id} to={`/groups/${group.id}`} className="list-item">
              <div className="list-item-body">
                <div className="list-item-title">{group.name}</div>
                <div className="muted">
                  {groupTypeLabel(group.group_type)} · default {group.default_currency}
                </div>
              </div>
              <span className="muted">›</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
