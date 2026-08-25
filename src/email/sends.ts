/**
 * Outbound mail log and optional per-type rate limits.
 *
 * send.ts is the transport. This module is the ledger: one row per attempt,
 * typed so invites, later reminders, and notifications share a table. Failed
 * or unconfigured sends still count; a broken provider must not be retried
 * into a quota burn.
 *
 * Limits are opt-in per call. Invite uses them; signup / verification / reset
 * record without capping.
 */
import { transaction } from "../db/index.ts";
import { ulid } from "../domain/ulid.ts";
import { sendEmail, type EmailMessage, type SendResult } from "./send.ts";

/**
 * Mail kinds we send today, plus the ones this table is for.
 * Adding a value is a code change, not a migration: `type` has no CHECK.
 */
export type EmailSendType =
  | "invite"
  | "signup"
  | "verification"
  | "reset"
  | "notification"
  | "reminder";

export type EmailSendLimit =
  | { kind: "per_subject"; windowMs: number; max: number }
  | { kind: "per_actor_utc_day"; max: number };

export type SendTrackedResult =
  | { ok: true; delivered: boolean }
  | { ok: false; limit: EmailSendLimit["kind"]; retryAfterSeconds: number };

function utcDayStart(now = new Date()): string {
  return `${now.toISOString().slice(0, 10)} 00:00:00`;
}

function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function parseSqliteUtc(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

function secondsUntil(epochMs: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((epochMs - now) / 1000));
}

/**
 * Sends `message` and records the attempt. When `limits` are set, a full
 * window refuses before the transport runs and writes nothing.
 */
export async function sendTrackedEmail(input: {
  type: EmailSendType;
  message: EmailMessage;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  limits?: EmailSendLimit[];
}): Promise<SendTrackedResult> {
  const claimed = await transaction(async (trx) => {
    for (const limit of input.limits ?? []) {
      const blocked = await checkLimit(trx, input, limit);
      if (blocked) return blocked;
    }
    const id = ulid();
    await trx
      .insertInto("email_sends")
      .values({
        id,
        type: input.type,
        to_address: input.message.to,
        actor_user_id: input.actorUserId ?? null,
        subject_user_id: input.subjectUserId ?? null,
        subject: input.message.subject,
        delivered: 0,
      })
      .execute();
    return { id };
  });

  if ("limit" in claimed) {
    return { ok: false, limit: claimed.limit, retryAfterSeconds: claimed.retryAfterSeconds };
  }

  const result = await sendEmail(input.message);
  await markSendResult(claimed.id, result);
  return { ok: true, delivered: result.delivered };
}

async function markSendResult(id: string, result: SendResult): Promise<void> {
  await transaction(async (trx) => {
    await trx
      .updateTable("email_sends")
      .set({
        delivered: result.delivered ? 1 : 0,
        reason: result.reason,
        provider_id: result.messageId ?? null,
      })
      .where("id", "=", id)
      .execute();
  });
}

type Trx = Parameters<Parameters<typeof transaction>[0]>[0];

async function checkLimit(
  trx: Trx,
  input: {
    type: EmailSendType;
    actorUserId?: string | null;
    subjectUserId?: string | null;
  },
  limit: EmailSendLimit,
): Promise<{ limit: EmailSendLimit["kind"]; retryAfterSeconds: number } | null> {
  if (limit.kind === "per_subject") {
    const subjectId = input.subjectUserId;
    if (!subjectId) {
      throw new Error("per_subject limit requires subjectUserId");
    }
    const cutoff = sqliteUtc(Date.now() - limit.windowMs);
    const rows = await trx
      .selectFrom("email_sends")
      .select("sent_at")
      .where("type", "=", input.type)
      .where("subject_user_id", "=", subjectId)
      .where("sent_at", ">=", cutoff)
      .orderBy("sent_at", "asc")
      .execute();
    if (rows.length >= limit.max) {
      const oldest = parseSqliteUtc(rows[0]!.sent_at);
      return {
        limit: "per_subject",
        retryAfterSeconds: secondsUntil(oldest + limit.windowMs),
      };
    }
    return null;
  }

  const actorId = input.actorUserId;
  if (!actorId) {
    throw new Error("per_actor_utc_day limit requires actorUserId");
  }
  const row = await trx
    .selectFrom("email_sends")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("type", "=", input.type)
    .where("actor_user_id", "=", actorId)
    .where("sent_at", ">=", utcDayStart())
    .executeTakeFirstOrThrow();
  if (Number(row.n) >= limit.max) {
    return { limit: "per_actor_utc_day", retryAfterSeconds: secondsUntilUtcMidnight() };
  }
  return null;
}
