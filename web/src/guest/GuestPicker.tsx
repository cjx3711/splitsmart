/**
 * "Which of these people are you?"
 *
 * Only shown for a general group link, which acts as whoever the holder picks
 * and lets them change their mind. The list is unclaimed ghosts only: someone
 * with a real account cannot be impersonated by a shared secret, and the server
 * would refuse the pick anyway (src/domain/access-links.ts).
 *
 * A guest cannot add themselves here. Names come from whoever owns the group;
 * if you are not on the list, the answer is to ask them, not to invent a person
 * and start owing them money. See docs/GUEST.md.
 */
import { useNavigate } from "react-router-dom";
import { Avatar } from "../Avatar.tsx";
import { useGuest, pickPerson } from "./GuestApp.tsx";
import { guestFullName } from "./guestApi.ts";

export function GuestPicker() {
  const { session, reload } = useGuest();
  const navigate = useNavigate();

  async function choose(userId: string) {
    pickPerson(userId);
    await reload();
    navigate(session.group ? `/groups/${session.group.id}` : "/", { replace: true });
  }

  if (session.people.length === 0) {
    return (
      <div className="auth stack">
        <h1>Nobody to pick</h1>
        <p className="muted">
          Everyone in {session.group?.name ?? "this group"} already has an account of their own, so
          there is no guest name left to use. Log in instead, or ask whoever
          shared this link to add you.
        </p>
        <p>
          <a href="/app/login" className="mkt-btn">
            Log in
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="auth stack">
      <h1>Which one are you?</h1>
      <p className="muted">
        {session.group ? `Everyone in ${session.group.name}. ` : ""}
        Pick your name to see what you owe. You can change this later.
      </p>

      <div className="list">
        {session.people.map((person) => (
          <button
            key={person.id}
            type="button"
            className="list-item guest-pick"
            onClick={() => void choose(person.id)}
          >
            <Avatar id={person.id} name={guestFullName(person)} />
            <div className="list-item-body">
              <div className="list-item-title">{guestFullName(person)}</div>
            </div>
          </button>
        ))}
      </div>

      <p className="field-hint">
        Not on this list? Ask whoever sent you the link to add you. Guests
        cannot add people.
      </p>
    </div>
  );
}
