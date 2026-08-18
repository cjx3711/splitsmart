/**
 * Writes the server would not take.
 *
 * NON-NEGOTIABLE, in the words of docs/OFFLINE.md, and the reason is the same one
 * the Splitwise importer surfaces its `skipped[]` instead of quietly dropping
 * rows: an expense that vanishes between two devices is worse than an error
 * message. Every entry here is money somebody entered and believes is recorded.
 *
 * Two kinds, and they need different words:
 *
 *   CONFLICT   somebody else changed the same bill first. Both versions exist and
 *              only a person knows which is right. There is deliberately no
 *              "merge": applying both edits would double the money, so the choice
 *              is keep theirs or resend mine.
 *   REJECTED   the server refused it outright - an unknown currency, a group you
 *              have since left, shares that do not add up. Usually needs the
 *              expense re-entered rather than resent, so the reason is shown
 *              verbatim.
 */
import { Link } from "react-router-dom";
import { Amount } from "../money.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { useLocal } from "../sync/useLocal.ts";
import type { LocalExpense, OutboxOp } from "../db/local.ts";

interface Entry {
  op: OutboxOp;
  local: LocalExpense | undefined;
}

export function Conflicts() {
  const { engine } = useSync();

  const entries = useLocal<Entry[]>(async (db) => {
    const stuck = (await db.outbox.toArray()).filter((op) => op.status !== "pending");
    return Promise.all(
      stuck.map(async (op) => ({ op, local: await db.expenses.get(op.id) })),
    );
  });

  if (entries === undefined) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="page-head">
        <h1>Unsaved changes</h1>
      </div>

      {entries.length === 0 ? (
        <p className="empty">
          Everything has been saved. Changes that the server cannot accept show up here
          rather than disappearing.
        </p>
      ) : (
        <div className="list">
          {entries.map(({ op, local }) => (
            <div key={op.seq} className="list-item conflict-item">
              <div className="list-item-body">
                <div className="list-item-title">
                  {local ? local.description : describeKind(op.kind)}
                  {local && (
                    <>
                      {" - "}
                      <Amount minor={local.costMinor} currency={local.currencyCode} />
                    </>
                  )}
                </div>

                <p className={op.status === "conflict" ? "muted" : "error"}>
                  {op.status === "conflict"
                    ? (op.reason ??
                      "Somebody else changed this while your edit was waiting to sync.")
                    : (op.reason ?? "The server could not accept this change.")}
                </p>

                {/* Both versions, side by side, for a conflict. Never a merged
                    third one: the amounts are not additive and guessing would be
                    the one mistake this screen exists to prevent. */}
                {op.status === "conflict" && local?.conflictWith && (
                  <div className="conflict-versions">
                    <div>
                      <span className="eyebrow">On the server</span>
                      <div>{local.conflictWith.description}</div>
                      <Amount
                        minor={local.conflictWith.costMinor}
                        currency={local.conflictWith.currencyCode}
                      />
                    </div>
                    <div>
                      <span className="eyebrow">Your version</span>
                      <div>{local.description}</div>
                      <Amount minor={local.costMinor} currency={local.currencyCode} />
                    </div>
                  </div>
                )}

                <div className="page-actions" style={{ marginTop: "0.5rem" }}>
                  <button
                    className="inline"
                    onClick={() => void engine?.retry(op.seq!)}
                    disabled={!engine}
                  >
                    {op.status === "conflict" ? "Keep mine" : "Try again"}
                  </button>
                  <button
                    className="secondary inline"
                    onClick={() => void engine?.discard(op.seq!)}
                    disabled={!engine}
                  >
                    {op.status === "conflict" ? "Keep theirs" : "Discard"}
                  </button>
                  {local && (
                    <Link to={`/expenses/${local.id}`}>
                      <button className="secondary inline">Open</button>
                    </Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function describeKind(kind: string): string {
  switch (kind) {
    case "expense.create":
      return "A new expense";
    case "payment.create":
      return "A payment";
    case "expense.update":
      return "An edited expense";
    case "expense.delete":
      return "A deleted expense";
    case "expense.restore":
      return "A restored expense";
    case "comment.create":
      return "A comment";
    case "comment.delete":
      return "A deleted comment";
    default:
      return "A change";
  }
}
