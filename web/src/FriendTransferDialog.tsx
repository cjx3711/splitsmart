import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, displayName, type Friend } from "./api.ts";
import { useAuth } from "./App.tsx";
import { useGroups, useRelatedPeople } from "./localData.ts";
import { Modal } from "./Modal.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { useSync } from "./sync/SyncProvider.tsx";
import type { FriendTransferInput } from "../../src/domain/friend-transfer.ts";

type Preview = Awaited<ReturnType<typeof api.previewFriendTransfer>>;

/** Mounted only while open, so each operation starts with a fresh selection. */
export function FriendTransferDialog({ friend, onClose }: { friend: Friend; onClose: () => void }) {
  const { user } = useAuth();
  const { engine } = useSync();
  const navigate = useNavigate();
  const people = useRelatedPeople()?.people ?? [];
  const groups = useGroups()?.groups ?? [];
  const [targetId, setTargetId] = useState("");
  const [mode, setMode] = useState<"merge" | "transfer">(friend.is_ghost === 1 ? "merge" : "transfer");
  const [scope, setScope] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const input: FriendTransferInput = {
    targetId, mode,
    scope: mode === "merge" || scope === "all" ? "all" : scope === "personal" ? "personal" : "group",
    ...(mode === "transfer" && scope !== "all" && scope !== "personal" ? { groupId: scope } : {}),
  };
  const close = () => { if (!busy) onClose(); };

  async function syncBeforeReview() {
    if (!engine) throw new Error("Wait for your expenses to finish loading.");
    await engine.sync({ queueIfBusy: false });
    const status = await engine.status();
    if (!status.online || status.lastError || !status.bootstrapped || status.pending || status.conflicts || status.rejected) {
      throw new Error("Sync your changes and resolve any conflicts before merging or transferring expenses.");
    }
  }

  async function review() {
    setBusy(true);
    setError(null);
    try {
      await syncBeforeReview();
      setPreview(await api.previewFriendTransfer(friend.id, input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not preview changes.");
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await syncBeforeReview();
      await api.transferFriend(friend.id, { ...input, confirmed: true, fingerprint: preview.fingerprint });
      await engine?.sync();
      onClose();
      if (mode === "merge") navigate(targetId === user?.id ? "/friends" : `/friends/${targetId}`);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "Could not save changes.");
    } finally { setBusy(false); }
  }

  const scopeName = input.scope === "all" ? "all your groups and personal expenses" :
    input.scope === "personal" ? "personal expenses only" : groups.find((g) => g.id === input.groupId)?.name ?? "the selected group";
  return <>
    <Modal open={!preview} title="Merge or transfer expenses" onClose={close}>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void review(); }}>
        <p style={{ margin: 0 }}>Move expenses from <strong>{displayName(friend)}</strong> to another person.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <label>Move to
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} required disabled={busy}>
            <option value="">Choose a person</option>
            {user && <option value={user.id}>{displayName(user)} (you)</option>}
            {people.filter((p) => p.id !== friend.id && p.id !== user?.id).map((p) => <option key={p.id} value={p.id}>{displayName(p)}</option>)}
          </select>
        </label>
        <label>What should happen?
          <select value={mode} onChange={(e) => setMode(e.target.value as "merge" | "transfer")} disabled={busy}>
            {friend.is_ghost === 1 && <option value="merge">Fully merge into one person</option>}
            <option value="transfer">Transfer expenses; keep friend</option>
          </select>
        </label>
        <p className="muted" style={{ margin: 0 }}>{mode === "merge"
          ? "All expenses and group memberships move to the selected person. The original friend is removed and their guest links are revoked. The selected person's name and profile stay the same."
          : "The original friend and their group memberships stay. Only their expense shares move to the selected person."}</p>
        {friend.is_ghost !== 1 && <p className="muted" style={{ margin: 0 }}>This person has their own account, so they can only have expenses transferred.</p>}
        {mode === "transfer" && <label>Expenses to transfer
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={busy}>
            <option value="all">All groups and personal expenses</option>
            <option value="personal">Personal expenses only</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>}
        <p className="error" style={{ margin: 0 }}>This is destructive and cannot be undone. Paid and owed shares are combined when both people appear on a bill. Original split rules become exact amounts. Payments, recurring expenses, and deleted expense history are included.</p>
        {mode === "transfer" && <p className="muted" style={{ margin: 0 }}>Only history you can access is transferred. The selected person will be added to affected groups if needed, giving them access to those groups.</p>}
        <button type="submit" disabled={busy || !targetId}>{busy ? "Reviewing…" : "Review changes"}</button>
      </form>
    </Modal>
    <ConfirmDialog open={preview !== null} title={mode === "merge" ? "Permanently merge people?" : "Permanently transfer expenses?"}
      confirmLabel={mode === "merge" ? "Merge people" : "Transfer expenses"} busyLabel="Applying changes…" busy={busy}
      onClose={() => { if (!busy) setPreview(null); }} onConfirm={confirm}>
      {preview && <>
        <p style={{ margin: 0 }}><strong>{displayName(preview.source)} → {displayName(preview.target)}</strong></p>
        <p style={{ margin: 0 }}>{preview.expenseCount} {preview.expenseCount === 1 ? "expense" : "expenses"} in {scopeName}, including {preview.deletedCount} deleted. Shares will be combined on {preview.overlappingCount} {preview.overlappingCount === 1 ? "expense" : "expenses"} where both people appear.</p>
        <p style={{ margin: 0 }}>{mode === "merge" ? `${displayName(preview.source)} will be removed and their guest links revoked.` : `${displayName(preview.source)} will remain in your friends.`}</p>
        {preview.groupsToJoin.length > 0 && <p style={{ margin: 0 }}>The selected person will join: {preview.groupsToJoin.map((g) => g.name).join(", ")}. They will have access to these groups.</p>}
        <p className="error" style={{ margin: 0 }}>This is destructive and cannot be undone.</p>
      </>}
    </ConfirmDialog>
  </>;
}
