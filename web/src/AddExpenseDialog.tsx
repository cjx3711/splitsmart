/**
 * The add-expense dialog: one entry point, opened from anywhere.
 *
 * ExpenseForm is deliberately ignorant of where its people come from; this is
 * the piece that knows. It answers two questions and passes the answers down:
 *
 *   who can be on the expense: the chosen group's members, or your friends
 *   who starts on it: everyone in the group, or you and one friend
 *
 * Picking a group therefore REPLACES the candidate pool rather than adding to
 * it, because a group expense may only involve that group's members (the server
 * enforces it in createExpense, and an offer the server will refuse is worse
 * than no offer).
 */
import { useEffect, useState } from "react";
import { api, fullName, type Friend, type Group } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { ExpenseForm } from "./ExpenseForm.tsx";
import type { Person } from "./PeoplePicker.tsx";
import { useAuth, useSidebarRefresh } from "./App.tsx";

export function AddExpenseDialog({
  open,
  onClose,
  initialGroupId = null,
  initialFriendId = null,
  title = "Add Expense",
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  initialGroupId?: string | null;
  /** Pre-selects one friend, for the friend screen. */
  initialFriendId?: string | null;
  title?: string;
  onCreated?: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const refreshSidebar = useSidebarRefresh();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string | null>(initialGroupId);
  const [members, setMembers] = useState<Person[] | null>(null);

  // Everything is loaded when the dialog opens rather than on mount: this
  // component is rendered by every screen with an "Add an expense" button, and
  // two requests per page load for a dialog nobody opened is rude.
  useEffect(() => {
    if (!open) return;
    setGroupId(initialGroupId);
    void api.listFriends().then((r) => setFriends(r.friends)).catch(() => setFriends([]));
    void api.listGroups().then((r) => setGroups(r.groups)).catch(() => setGroups([]));
  }, [open, initialGroupId]);

  useEffect(() => {
    if (!open || groupId === null || !user) {
      setMembers(null);
      return;
    }
    let live = true;
    void api
      .getGroup(groupId)
      .then((r) => {
        if (!live) return;
        setMembers(
          r.members.map((m) => ({ id: m.id, label: m.id === user.id ? "You" : fullName(m) })),
        );
      })
      .catch(() => live && setMembers([]));
    return () => {
      live = false;
    };
  }, [open, groupId, user]);

  if (!user) return null;

  const you: Person = { id: user.id, label: "You" };
  const candidates: Person[] =
    groupId !== null
      ? (members ?? [you])
      : [you, ...friends.map((f) => ({ id: f.id, label: fullName(f) }))];

  const initialParticipantIds =
    groupId !== null
      ? candidates.map((p) => p.id)
      : initialFriendId !== null && candidates.some((p) => p.id === initialFriendId)
        ? [user.id, initialFriendId]
        : [user.id];

  return (
    <Modal open={open} title={title} onClose={onClose}>
      <ExpenseForm
        className="stack"
        candidates={candidates}
        initialParticipantIds={initialParticipantIds}
        currentUserId={user.id}
        defaultCurrency={
          groups.find((g) => g.id === groupId)?.default_currency ?? user.defaultCurrency
        }
        groups={groups}
        groupId={groupId}
        onGroupChange={setGroupId}
        // A logged-in account may start a recurring series here. The guest
        // dialog deliberately does not offer it; see ExpenseForm's `allowRepeat`.
        allowRepeat
        onSubmit={async (input) => {
          await api.createAnyExpense({ ...input, groupId });
          onClose();
          refreshSidebar();
          await onCreated?.();
        }}
      />
    </Modal>
  );
}
