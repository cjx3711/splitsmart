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
 *
 * Both questions are answered from the MIRROR, which is what makes adding an
 * expense work with no signal - the canonical case this whole feature exists for,
 * a restaurant or a trip. The practical limit falls out of the same fact: offline
 * you can only name people who are already in your local database, because adding
 * a person is a server-side identity and is online-only. The trip you are on is a
 * trip with people you have already added.
 */
import { useEffect, useState } from "react";
import { ExpenseDialog, expensePeople } from "./ExpenseDialog.tsx";
import { useAuth } from "./App.tsx";
import { useGroups, useGroupView, useRelatedPeople } from "./localData.ts";
import { useSync } from "./sync/SyncProvider.tsx";
import { useOnline } from "./OnlineOnly.tsx";
import { ulid } from "../../src/domain/ulid.ts";

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
  const { engine } = useSync();
  const online = useOnline();

  const [groupId, setGroupId] = useState<string | null>(initialGroupId);

  // Live queries against the mirror, so opening the dialog costs no request at
  // all - which also means it opens instantly and works offline.
  const friends = useRelatedPeople()?.people ?? [];
  const groups = useGroups()?.groups ?? [];
  const groupView = useGroupView(groupId ?? undefined);

  useEffect(() => {
    if (open) setGroupId(initialGroupId);
  }, [open, initialGroupId]);

  if (!user) return null;

  const candidates = expensePeople(user.id, groupId, groupView?.members, friends);

  const initialParticipantIds =
    groupId !== null
      ? candidates.map((p) => p.id)
      : initialFriendId !== null && candidates.some((p) => p.id === initialFriendId)
        ? [user.id, initialFriendId]
        : [user.id];

  return (
    <ExpenseDialog
      open={open}
      title={title}
      onClose={onClose}
      candidates={candidates}
      initialParticipantIds={initialParticipantIds}
      currentUserId={user.id}
      defaultCurrency={
        groups.find((g) => g.id === groupId)?.default_currency ?? user.defaultCurrency
      }
      groups={groups}
      groupId={groupId}
      onGroupChange={setGroupId}
      // Repeat is online-only: the scheduler owns next_repeat. Offline this
      // is off, so the form omits the field and an existing series is left
      // alone. The guest dialog never offers it at all.
      allowRepeat={online}
      onSubmit={async (input) => {
        // THE CLIENT MINTS THE ULID and it is the primary key. A retry of the
        // same id is a no-op that returns the stored row, which is the
        // lost-response case rather than a merge, and is why a create can never
        // conflict. See docs/OFFLINE.md, decision 1.
        if (!engine) throw new Error("Not ready to save yet.");
        await engine.enqueue({
          kind: "expense.create",
          id: ulid(),
          payload: { ...input, groupId },
        });
        await onCreated?.();
      }}
    />
  );
}
