/**
 * An affordance that cannot work without a connection.
 *
 * Not everything queues, and the ones that do not are a deliberate list rather
 * than an oversight (docs/OFFLINE.md, "What is offline-capable, and what is not"):
 *
 *   adding a friend, adding a group member, creating a group
 *     each mints a server-side USER or GROUP identity. Queueing one means the
 *     client inventing an identity that later has to be reconciled — by email, for
 *     friends, which is the single heuristic the Splitwise importer gates behind a
 *     named preview because a wrong match merges two people's money. The same
 *     placeholder created offline on two devices is two people where there should
 *     be one, and every expense attached to the loser is stranded.
 *
 *   starting or changing a repeat schedule
 *     the scheduler owns `next_repeat` and the server clock owns when it fires.
 *
 *   guest links, Splitwise import, email verification, API tokens, claiming
 *     all of them are conversations with something outside this app.
 *
 * So the control is disabled and SAYS WHY, rather than accepting a tap and losing
 * it. The practical consequence, worth being plain about: offline you can add
 * expenses among people who are already in your local database. The trip you are
 * on is a trip with people you have already added.
 */
import type { ReactNode } from "react";
import { useSync } from "./sync/SyncProvider.tsx";

export function useOnline(): boolean {
  const { status } = useSync();
  // Before the first status resolves, assume online: a false negative here would
  // disable a working button, which is worse than a tap that fails with an error.
  return status?.online ?? true;
}

/**
 * Wraps a control, disabling it and explaining itself when there is no connection.
 *
 * `what` is the action, capitalised, as it appears in the sentence: "Creating a
 * group needs a connection."
 */
export function OnlineOnly({
  what,
  children,
}: {
  what: string;
  children: ReactNode;
}) {
  const online = useOnline();
  if (online) return <>{children}</>;

  return (
    <span className="online-only" title={`${what} needs a connection.`}>
      <span
        className="online-only-control"
        aria-disabled="true"
        onClickCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </span>
      <span className="online-only-note muted">{what} needs a connection.</span>
    </span>
  );
}

/** A page that has nothing useful to show without a round trip. */
export function NeedsConnection({ what }: { what: string }) {
  return <p className="notice">{what} needs a connection.</p>;
}
