import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type Group } from "../api.ts";
import { useSidebarRefresh } from "../App.tsx";

const GROUP_TYPES = ["trip", "home", "couple", "event", "project", "other"] as const;

export function Groups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshSidebar = useSidebarRefresh();

  async function load() {
    try {
      const data = await api.listGroups();
      setGroups(data.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load groups");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Groups</h1>
      </div>

      {error && <p className="error" style={{ marginBottom: "1rem" }}>{error}</p>}

      {groups === null ? (
        <p className="muted">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="empty">No groups yet. Create one below.</p>
      ) : (
        <div className="list">
          {groups.map((group) => (
            <Link key={group.id} to={`/groups/${group.id}`} className="list-item">
              <div className="list-item-body">
                <div className="list-item-title">{group.name}</div>
                <div className="muted">
                  {group.group_type} · default {group.default_currency}
                </div>
              </div>
              <span className="muted">›</span>
            </Link>
          ))}
        </div>
      )}

      <NewGroup
        onCreated={() => {
          void load();
          refreshSidebar();
        }}
      />
    </>
  );
}

function NewGroup({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [groupType, setGroupType] = useState<(typeof GROUP_TYPES)[number]>("trip");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await api.createGroup({ name: name.trim(), groupType });
      setName("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create group");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>New group</h2>
      <form onSubmit={handleSubmit} className="card stack">
        {error && <p className="error">{error}</p>}
        <div className="form-grid">
          <div>
            <label htmlFor="groupName">Name</label>
            <input
              id="groupName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Trip to Tokyo"
              required
            />
          </div>
          <div>
            <label htmlFor="groupType">Type</label>
            <select
              id="groupType"
              value={groupType}
              onChange={(e) => setGroupType(e.target.value as (typeof GROUP_TYPES)[number])}
            >
              {GROUP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <button type="submit" disabled={busy || !name.trim()} className="inline">
            {busy ? "Creating…" : "Create group"}
          </button>
        </div>
      </form>
    </>
  );
}
