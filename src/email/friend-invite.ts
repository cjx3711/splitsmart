/**
 * Guest-link invite mail.
 *
 * Adding or editing a placeholder stores `invite_email`. It does not send.
 * The only send is POST /friends/:id/invite, which the owner has to click.
 *
 * Caps, both counted on email_sends type = 'invite':
 *   - one send per friend per rolling 24 hours
 *   - FRIEND_INVITES_PER_DAY per owner per UTC day
 */
import { friendInviteEmail } from "./templates.ts";
import { sendTrackedEmail, type EmailSendLimit } from "./sends.ts";

export const FRIEND_INVITES_PER_DAY = 3;
export const FRIEND_INVITE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const INVITE_LIMITS: EmailSendLimit[] = [
  { kind: "per_subject", windowMs: FRIEND_INVITE_COOLDOWN_MS, max: 1 },
  { kind: "per_actor_utc_day", max: FRIEND_INVITES_PER_DAY },
];

export async function deliverGhostInvite(input: {
  to: string;
  friendId: string;
  actorUserId: string;
  friendName: string;
  inviterName: string;
  inviteUrl: string;
}): Promise<
  | { ok: true; emailDelivered: boolean }
  | { ok: false; error: string; retryAfterSeconds: number }
> {
  const invite = friendInviteEmail({
    name: input.friendName,
    inviterName: input.inviterName,
    acceptUrl: input.inviteUrl,
    isNewAccount: true,
  });
  const result = await sendTrackedEmail({
    type: "invite",
    message: { to: input.to, ...invite },
    actorUserId: input.actorUserId,
    subjectUserId: input.friendId,
    limits: INVITE_LIMITS,
  });
  if (!result.ok) {
    return {
      ok: false,
      retryAfterSeconds: result.retryAfterSeconds,
      error:
        result.limit === "per_subject"
          ? "You already sent them an invite in the last 24 hours. Try again later."
          : "You can send 3 invites per day. Try again tomorrow.",
    };
  }
  return { ok: true, emailDelivered: result.delivered };
}
