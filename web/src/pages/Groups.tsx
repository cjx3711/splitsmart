import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, formatMoney, type Group, type CurrencyAmount } from "../api.ts";

export function Groups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [totalBalance, setTotalBalance] = useState<CurrencyAmount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  async function load() {
    try {
      const data = await api.listGroups();
      setGroups(data.groups);
      setTotalBalance(data.totalBalance);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load groups");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api.createGroup({ name: name.trim() });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create group");
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <h1>Groups</h1>
      {error && <p className="error">{error}</p>}

      {totalBalance.length > 0 && (
        <div className="card">
          <div className="muted">Overall</div>
          {/* One line per currency — balances are never converted or summed
              across currencies. */}
          {totalBalance.map((b) => (
            <div key={b.currencyCode} className={b.amountMinor >= 0 ? "positive" : "negative"}>
              {b.amountMinor >= 0 ? "you are owed " : "you owe "}
              {formatMoney(Math.abs(b.amountMinor))} {b.currencyCode}
            </div>
          ))}
        </div>
      )}

      {groups === null ? (
        <p className="muted">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="muted">No groups yet. Create one below.</p>
      ) : (
        <div className="stack">
          {groups.map((group) => (
            <Link key={group.id} to={`/groups/${group.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div className="card row">
                <div>
                  <strong>{group.name}</strong>
                  <div className="muted">
                    {group.group_type} · {group.default_currency}
                  </div>
                </div>
                <span className="muted">›</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <h2>New group</h2>
      <form onSubmit={handleCreate} className="stack">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Trip to Tokyo"
          aria-label="Group name"
        />
        <button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create group"}
        </button>
      </form>
    </>
  );
}
