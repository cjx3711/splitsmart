/**
 * Queueing a payment, and the note somebody typed with it.
 *
 * The note is not a column: a payment's description is always "Payment", and
 * "cash at dinner" belongs on the bill where it is read. So it goes out as an
 * ordinary comment on the expense just enqueued, which is why the expense id
 * is minted HERE rather than inside `enqueue` - the comment has to name it.
 *
 * Ordering is the outbox's problem, not ours: creates are sent before comments
 * (see `sync/outbox.ts`), so the comment cannot arrive at a bill the server has
 * not been told about yet.
 *
 * Written once because three screens offer the same payment now (a friend, a
 * group, and the header), and a note that silently vanished on one of them
 * would be indistinguishable from a sync bug.
 */
import { paymentAsExpense } from "./SettleUpDialog.tsx";
import type { SettlePayment } from "./SettleUpForm.tsx";
import type { LocalWrite } from "./sync/outbox.ts";
import { ulid } from "../../src/domain/ulid.ts";

export interface PaymentQueue {
  enqueue: (write: LocalWrite) => Promise<void>;
}

/** Enqueues the payment (and its note, if any). Returns the new expense id. */
export async function enqueuePayment(
  engine: PaymentQueue | null | undefined,
  payment: SettlePayment,
  groupId: string | null,
): Promise<string> {
  if (!engine) throw new Error("Not ready to save yet.");
  const id = ulid();
  await engine.enqueue({
    kind: "payment.create",
    id,
    payload: paymentAsExpense(payment, groupId),
  });
  const note = payment.note?.trim();
  if (note) {
    await engine.enqueue({
      kind: "comment.create",
      id: ulid(),
      payload: { expenseId: id, content: note },
    });
  }
  return id;
}
