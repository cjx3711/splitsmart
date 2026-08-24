/**
 * Group options: name, type (the sidebar icon), simplify debts, members.
 *
 * Any logged-in member can change these. Guest-link holders never reach this
 * page — the guest shell has no settings routes (docs/GUEST.md). Adding,
 * editing a placeholder, and removing a member stay online-only.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, displayName, type GroupMember } from "../api.ts";
import { AddMemberDialog } from "../AddMemberDialog.tsx";
import { avatarFromRow } from "../Avatar.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { FriendListItem, friendHref } from "../FriendListItem.tsx";
import { GroupTypePicker, isGroupType, type GroupType } from "../groupTypes.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { useAuth } from "../App.tsx";
import { useGroupView } from "../localData.ts";
import { NeedsConnection, OnlineOnly, useOnline } from "../OnlineOnly.tsx";
import { PersonIdentityDialog } from "../PersonIdentityDialog.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { markMemberLeft, patchGroup, patchPerson, restoreMember, revertPerson } from "../sync/localFirst.ts";
import { Skeleton } from "../Skeleton.tsx";

export function GroupOptions() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const online = useOnline();
  const { db, syncNow } = useSync();
  const view = useGroupView(id);

  const [name, setName] = useState("");
  const [groupType, setGroupType] = useState<GroupType>("other");
  const [busy, setBusy] = useState(false);
  const [simplifyBusy, setSimplifyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [identityMember, setIdentityMember] = useState<GroupMember | null>(null);
  const [removingMember, setRemovingMember] = useState<GroupMember | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);

  const group = view && view !== null ? view.group : null;
  const members = view && view !== null ? view.members : [];

  useEffect(() => {
    if (!group) return;
    setName(group.name);
    setGroupType(isGroupType(group.group_type) ? group.group_type : "other");
  }, [group?.id, group?.name, group?.group_type]);

  if (view === undefined || !user) return <Skeleton kind="form" />;
  if (view === null || !group) return <p className="empty">This group is not on this device.</p>;

  const current = group;
  const dirty = name.trim() !== current.name || groupType !== current.group_type;
  const simplifyOn = current.simplify_by_default === 1;
  const isOwner = view.role === "owner";

  async function saveIdentity(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !db) return;
    setError(null);
    setBusy(true);
    const previous = await patchGroup(db, current.id, { name: trimmed, groupType });
    try {
      await api.updateGroup(current.id, { name: trimmed, groupType });
      syncNow();
    } catch (err) {
      if (previous) {
        await patchGroup(db, current.id, {
          name: previous.name,
          groupType: previous.groupType,
        });
      }
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function setSimplify(on: boolean) {
    if (!db) return;
    setSimplifyBusy(true);
    const previous = await patchGroup(db, current.id, { simplifyByDefault: on });
    try {
      await api.updateGroup(current.id, { simplifyByDefault: on });
      syncNow();
    } catch {
      if (previous) {
        await patchGroup(db, current.id, {
          simplifyByDefault: previous.simplifyByDefault !== false,
        });
      }
    } finally {
      setSimplifyBusy(false);
    }
  }

  return (
    <>
      <Breadcrumbs
        trail={[
          { label: "Groups", to: "/groups" },
          { label: group.name, to: `/groups/${group.id}` },
          { label: "Options" },
        ]}
      />

      <div className="page-head">
        <h1>Options</h1>
      </div>

      {error && <p className="error">{error}</p>}

      {!online ? (
        <NeedsConnection what="Changing group options" />
      ) : (
        <>
          <form onSubmit={saveIdentity} className="card stack">
            <div>
              <label htmlFor="groupName">Name</label>
              <input
                id="groupName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
              />
            </div>
            <div>
              <span className="label-with-help">
                <label id="groupTypeLabel">Type and icon</label>
                <HelpTip label="About the group icon">
                  The type picks the icon in the sidebar and on friend pages. There is no separate
                  image upload.
                </HelpTip>
              </span>
              <GroupTypePicker value={groupType} onChange={setGroupType} disabled={busy} />
            </div>
            <div>
              <button type="submit" className="inline" disabled={busy || !dirty || !name.trim()}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>

          <div className="card" style={{ marginTop: "1rem" }}>
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={simplifyOn}
                disabled={simplifyBusy}
                onChange={(event) => void setSimplify(event.target.checked)}
              />
              <span>
                <span className="with-help">
                  Simplify debts
                  <HelpTip label="About simplify debts">
                    When on, friend totals for this group match Splitwise: cycles through other
                    people collapse. Your net in the group does not change, and each bill still
                    shows who paid. Imported groups keep the Splitwise setting.
                  </HelpTip>
                </span>
                <span className="muted" style={{ display: "block", marginTop: "0.15rem" }}>
                  {simplifyOn
                    ? "Friend balances in this group are simplified."
                    : "Friend balances show the raw who-owes-whom from each bill."}
                </span>
              </span>
            </label>
          </div>
        </>
      )}

      <div className="section-head">
        <h2>Members</h2>
        <OnlineOnly what="Adding someone to a group">
          <button type="button" className="link" onClick={() => setAddMemberOpen(true)}>
            + Add member
          </button>
        </OnlineOnly>
      </div>
      <div className="list">
        {members.map((m) => (
          <FriendListItem
            key={m.id}
            to={friendHref(m.id, user.id)}
            avatar={avatarFromRow(m)}
            title={m.id === user.id ? "You" : displayName(m)}
            subtitle={
              <span className="muted">
                {m.role}
                {m.is_ghost === 1 && (
                  <>
                    {" "}
                    <span className="tag muted">guest</span>
                  </>
                )}
              </span>
            }
            actions={
              m.is_ghost === 1 || (isOwner && m.id !== user.id) ? (
                <>
                  {m.is_ghost === 1 && (
                    <OnlineOnly what="Editing a placeholder's name">
                      <button
                        type="button"
                        className="link"
                        onClick={() => setIdentityMember(m)}
                      >
                        Edit
                      </button>
                    </OnlineOnly>
                  )}
                  {isOwner && m.id !== user.id && (
                    <OnlineOnly what="Removing someone from a group">
                      <button
                        type="button"
                        className="link"
                        onClick={() => setRemovingMember(m)}
                      >
                        Remove
                      </button>
                    </OnlineOnly>
                  )}
                </>
              ) : undefined
            }
          />
        ))}
      </div>
      <p className="muted" style={{ marginTop: "0.6rem" }}>
        Anyone with an account in this group can add people. Guest-link holders cannot.
        Only the owner can remove someone.
      </p>

      <PersonIdentityDialog
        open={identityMember !== null}
        person={identityMember}
        onClose={() => setIdentityMember(null)}
        onSave={async (id, payload) => {
          if (!db) {
            await api.updateFriend(id, payload);
            syncNow();
            return;
          }
          const previous = await patchPerson(db, id, payload);
          try {
            await api.updateFriend(id, payload);
            syncNow();
          } catch (err) {
            if (previous) await revertPerson(db, previous);
            throw err;
          }
        }}
      />

      <ConfirmDialog
        open={removingMember !== null}
        title={
          removingMember
            ? `Remove ${displayName(removingMember)} from ${group.name}?`
            : "Remove member?"
        }
        confirmLabel="Remove member"
        busyLabel="Removing…"
        busy={removingBusy}
        onClose={() => setRemovingMember(null)}
        onConfirm={async () => {
          if (!removingMember) return;
          setRemovingBusy(true);
          try {
            if (!db) {
              await api.removeGroupMember(group.id, removingMember.id);
              syncNow();
              setRemovingMember(null);
              return;
            }
            const previous = await markMemberLeft(db, group.id, removingMember.id);
            try {
              await api.removeGroupMember(group.id, removingMember.id);
              syncNow();
              setRemovingMember(null);
            } catch (err) {
              if (previous) await restoreMember(db, previous);
              throw err;
            }
          } finally {
            setRemovingBusy(false);
          }
        }}
      >
        <p style={{ margin: 0 }}>
          They will leave this group. Their guest link for this group is turned
          off. Balances and past expenses are unchanged.
        </p>
      </ConfirmDialog>

      <OnlineOnly what="Adding someone to a group">
        <AddMemberDialog
          open={addMemberOpen}
          onClose={() => setAddMemberOpen(false)}
          groupId={group.id}
          existingIds={members.map((m) => m.id)}
          onAdded={syncNow}
        />
      </OnlineOnly>
    </>
  );
}
