import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { useSidebarRefresh } from "../App.tsx";
import { GROUP_TYPE_LABELS, GROUP_TYPES, type GroupType } from "../groupTypes.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { NeedsConnection, useOnline } from "../OnlineOnly.tsx";

export function NewGroup() {
  const navigate = useNavigate();
  const refreshSidebar = useSidebarRefresh();
  const online = useOnline();

  const [name, setName] = useState("");
  const [groupType, setGroupType] = useState<GroupType>("trip");
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
      <Breadcrumbs trail={[{ label: "Groups", to: "/groups" }, { label: "New group" }]} />

      <div className="page-head">
        <h1>New group</h1>
      </div>

      {!online ? (
        <NeedsConnection what="Creating a group" />
      ) : (
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
              onChange={(e) => setGroupType(e.target.value as GroupType)}
            >
              {GROUP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {GROUP_TYPE_LABELS[type]}
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
      )}
    </>
  );
}
