import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { useAuth, useSidebarRefresh } from "../App.tsx";
import { GROUP_TYPE_LABELS, GROUP_TYPES, type GroupType } from "../groupTypes.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { NeedsConnection, useOnline } from "../OnlineOnly.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { ingestCreatedGroup, selfAsSyncUser, syncUserFromApiUser } from "../sync/localFirst.ts";

export function NewGroup() {
  const navigate = useNavigate();
  const refreshSidebar = useSidebarRefresh();
  const online = useOnline();
  const { user } = useAuth();
  const { db } = useSync();

  const [name, setName] = useState("");
  const [groupType, setGroupType] = useState<GroupType>("trip");
  const [simplifyDebts, setSimplifyDebts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const { group } = await api.createGroup({
        name: name.trim(),
        groupType,
        simplifyByDefault: simplifyDebts,
      });
      if (db && user) {
        await ingestCreatedGroup(db, group, await selfAsSyncUser(db, syncUserFromApiUser(user)));
      }
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
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={simplifyDebts}
            onChange={(e) => setSimplifyDebts(e.target.checked)}
          />
          <span>
            <span className="with-help">
              Simplify debts
              <HelpTip label="About simplify debts">
                When on, friend totals for this group collapse cycles through other people, the same
                way Splitwise does. Each bill still shows who paid. You can change this later on the
                group page.
              </HelpTip>
            </span>
            <span className="muted" style={{ display: "block", marginTop: "0.15rem" }}>
              A owes B, B owes C becomes A owes C. Your net in the group does not change.
            </span>
          </span>
        </label>
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
