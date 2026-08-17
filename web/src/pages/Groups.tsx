import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Group } from "../api.ts";
import { groupTypeLabel } from "../groupTypes.tsx";

export function Groups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void api
      .listGroups()
      .then((data) => setGroups(data.groups))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load groups"));
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Groups</h1>
        <div className="page-actions">
          <button onClick={() => navigate("/groups/new")}>+ Add group</button>
        </div>
      </div>

      {error && <p className="error" style={{ marginBottom: "1rem" }}>{error}</p>}

      {groups === null ? (
        <p className="muted">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="empty">
          No groups yet. <Link to="/groups/new">Create one</Link>.
        </p>
      ) : (
        <div className="list">
          {groups.map((group) => (
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
