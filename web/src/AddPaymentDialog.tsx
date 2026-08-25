/**
 * Recording a payment from the header, without first navigating to a person.
 *
 * A payment is between two people, so unlike the add-expense dialog this one
 * cannot start from a blank form: it asks WHO first, then opens the ordinary
 * settle-up dialog on that person's real outstanding balances. That is the
 * whole reason this file exists rather than a fourth copy of the settle-up
 * plumbing - the second step is the same dialog the friend page opens.
 *
 * Both steps read the MIRROR (`useRelatedPeople`, `useFriend`), so this works
 * offline exactly like adding an expense does, and the write goes through the
 * outbox.
 *
 * The friend page's settle-up asks a follow-up question when a payment zeroes
 * a currency that a shared group still shows as owed. That is deliberately NOT
 * repeated here: it needs the group breakdown in front of the reader to make
 * sense, and it is one click away on the friend's own page.
 */
import { useEffect, useState } from "react";
import { Modal } from "./Modal.tsx";
import { Avatar, avatarFromRow } from "./Avatar.tsx";
import { SettleUpDialog, friendSettleChoices } from "./SettleUpDialog.tsx";
import { useAuth } from "./App.tsx";
import { useFriend, useRelatedPeople } from "./localData.ts";
import { useSync } from "./sync/SyncProvider.tsx";
import { useFormatMoney } from "./money.tsx";
import { displayName } from "./api.ts";
import { enqueuePayment } from "./recordPayment.ts";

export function AddPaymentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { engine } = useSync();
  const formatMoney = useFormatMoney();

  const [friendId, setFriendId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const friends = useRelatedPeople()?.people ?? [];
  const loaded = useFriend(friendId ?? undefined);

  useEffect(() => {
    if (open) {
      setFriendId(null);
      setQuery("");
    }
  }, [open]);

  if (!user) return null;

  // A mirror read, so this is a frame or two at most - but showing the empty
  // settle-up form in the meantime would flip to the currency picker under the
  // reader's hands the moment the balances land. Stay on the list instead.
  const pending = friendId !== null && loaded === undefined;
  const friend = loaded?.friend;
  const picking = friendId === null || pending;

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? friends.filter((p) =>
        [p.name, p.nickname, p.email].some((f) => f?.toLowerCase().includes(needle)),
      )
    : friends;

  const name = friend ? displayName(friend) : "";
  const balances = friend?.balances ?? [];

  return (
    <>
      <Modal open={open && picking} title="New payment" onClose={onClose}>
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            Who did you pay, or who paid you?
          </p>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your friends by name"
            aria-label="Search your friends by name"
            autoFocus
          />
          {friends.length === 0 ? (
            <p className="empty" style={{ margin: 0 }}>
              Nobody to pay yet. Add a friend first.
            </p>
          ) : matches.length === 0 ? (
            <p className="empty" style={{ margin: 0 }}>
              No one matches "{query.trim()}".
            </p>
          ) : (
            <ul className="payee-list">
              {matches.map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    className="payee-row"
                    onClick={() => setFriendId(person.id)}
                  >
                    <Avatar {...avatarFromRow(person)} size={30} />
                    <span className="payee-name">{displayName(person)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      <SettleUpDialog
        open={open && !picking}
        title={`New payment with ${name}`}
        people={[
          { id: user.id, label: "You" },
          { id: friendId ?? "", label: name },
        ]}
        currencies={[
          ...new Set([...balances.map((b) => b.currencyCode), user.defaultCurrency]),
        ]}
        choices={
          friendId
            ? friendSettleChoices(balances, user.id, friendId, name, formatMoney)
            : []
        }
        // Back to the list rather than shut: picking the wrong person is the
        // likeliest mistake in a two-step dialog, and Escape still closes.
        onClose={() => setFriendId(null)}
        onSubmit={async (payment) => {
          await enqueuePayment(engine, payment, null);
          onClose();
        }}
      />
    </>
  );
}
