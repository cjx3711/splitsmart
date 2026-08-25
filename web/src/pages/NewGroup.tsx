import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { useAuth, useSidebarRefresh } from "../App.tsx";
import { CurrencySelect } from "../CurrencySelect.tsx";
import { GroupTypePicker, type GroupType } from "../groupTypes.tsx";
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
  // Your own preferred currency, not a hardcoded USD: most groups are in the
  // currency you already think in, and it stays editable here and in Options.
  const [currency, setCurrency] = useState(user?.defaultCurrency ?? "USD");
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
        defaultCurrency: currency,
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
          <label id="groupTypeLabel">Type and icon</label>
          <GroupTypePicker value={groupType} onChange={setGroupType} disabled={busy} />
        </div>
        <div style={{ maxWidth: "16rem" }}>
          <span className="label-with-help">
            <label htmlFor="groupCurrency">Default currency</label>
            <HelpTip label="About the group's default currency">
              What an expense in this group starts in. Starts from your preferred currency, and any
              bill can still be entered in another one. Changeable later in Options.
            </HelpTip>
          </span>
          <CurrencySelect id="groupCurrency" value={currency} onChange={setCurrency} />
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
                When on, friend totals and settle-up for this group collapse cycles through other
                people, the same way Splitwise does: you may be asked to pay someone you did not
                share a bill with. When off, both show one payment per recorded debt. Each bill
                still shows who paid, and your net never changes either way. You can change this
                later in group options.
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
