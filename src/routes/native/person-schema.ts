/**
 * Shared identity fields on native user writes.
 *
 * Used by PATCH /me (yourself) and PATCH /friends/:id (a ghost you can see).
 * Empty strings become null so the form can clear a nickname or icon without
 * a separate "clear" flag.
 */
import { z } from "zod";
import {
  graphemes,
  MAX_ICON_EMOJI,
  MAX_ICON_LETTERS,
  MAX_NAME_LENGTH,
  MAX_NICKNAME_LENGTH,
} from "../../domain/person.ts";
import {
  parseAvatarPattern,
  stringifyAvatarPattern,
  type AvatarPattern,
} from "../../domain/avatar-pattern.ts";

function emptyToNull(max: number) {
  return z
    .union([z.string().max(max), z.null()])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    });
}

const iconLetters = emptyToNull(16).superRefine((value, ctx) => {
  if (value === undefined || value === null) return;
  if (graphemes(value).length > MAX_ICON_LETTERS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Icon letters can be at most ${MAX_ICON_LETTERS} characters.`,
    });
  }
});

const iconEmoji = emptyToNull(32).superRefine((value, ctx) => {
  if (value === undefined || value === null) return;
  if (graphemes(value).length > MAX_ICON_EMOJI) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Pick a single emoji for the icon.",
    });
  }
});

const iconPattern = z
  .union([z.null(), z.unknown()])
  .optional()
  .transform((value, ctx): AvatarPattern | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const parsed = parseAvatarPattern(value);
    if (!parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid icon pattern." });
      return z.NEVER;
    }
    return parsed;
  });

export const identityPatchSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  nickname: emptyToNull(MAX_NICKNAME_LENGTH),
  iconLetters,
  iconEmoji,
  iconHue: z.number().int().min(0).max(359).nullable().optional(),
  iconPattern,
});

export type IdentityPatch = z.infer<typeof identityPatchSchema>;

/**
 * Invite address on a ghost. Empty/null clears it. Absent leaves it alone.
 *
 * Not on identityPatchSchema: PATCH /auth/me must not be able to write
 * invite_email (real accounts never have one), and a login email is a
 * different column.
 */
const inviteEmail = emptyToNull(254).superRefine((value, ctx) => {
  if (value === undefined || value === null) return;
  if (!z.string().email().safeParse(value).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid email address.",
    });
  }
});

export const friendPatchSchema = identityPatchSchema.extend({
  email: inviteEmail,
});

export type FriendPatch = z.infer<typeof friendPatchSchema>;

/** Columns to SET on `users` from a validated patch. Absent keys are left alone. */
export function identityColumns(patch: IdentityPatch): {
  name?: string;
  nickname?: string | null;
  icon_letters?: string | null;
  icon_emoji?: string | null;
  icon_hue?: number | null;
  icon_pattern?: string | null;
} {
  const set: {
    name?: string;
    nickname?: string | null;
    icon_letters?: string | null;
    icon_emoji?: string | null;
    icon_hue?: number | null;
    icon_pattern?: string | null;
  } = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.nickname !== undefined) set.nickname = patch.nickname;
  if (patch.iconLetters !== undefined) set.icon_letters = patch.iconLetters;
  if (patch.iconEmoji !== undefined) set.icon_emoji = patch.iconEmoji;
  if (patch.iconHue !== undefined) set.icon_hue = patch.iconHue;
  if (patch.iconPattern !== undefined) {
    set.icon_pattern = patch.iconPattern === null ? null : stringifyAvatarPattern(patch.iconPattern);
    if (patch.iconHue === undefined && patch.iconPattern) {
      set.icon_hue = Math.round(patch.iconPattern.base.h) % 360;
    }
  }
  return set;
}

export function hasIdentityPatch(patch: IdentityPatch): boolean {
  return (
    patch.name !== undefined ||
    patch.nickname !== undefined ||
    patch.iconLetters !== undefined ||
    patch.iconEmoji !== undefined ||
    patch.iconHue !== undefined ||
    patch.iconPattern !== undefined
  );
}

export function hasFriendPatch(patch: FriendPatch): boolean {
  return hasIdentityPatch(patch) || patch.email !== undefined;
}
