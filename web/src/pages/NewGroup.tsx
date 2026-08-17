import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { useSidebarRefresh } from "../App.tsx";

const GROUP_TYPES = ["trip", "home", "couple", "event", "project", "other"] as const;

export function NewGroup() {
  const navigate = useNavigate();
  const refreshSidebar = useSidebarRefresh();

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
      const { group } = await api.createGroup({ name: name.trim(), groupType });
      refreshSidebar();
      navigate(`/groups/${group.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create group");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>New group</h1>
      </div>

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
              autoFocus
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
