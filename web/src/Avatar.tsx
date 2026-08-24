/**
 * Person avatars.
 *
 * Letters, an optional emoji, and a geometric pattern. The pattern is a base
 * colour plus stacked chord bands, stored as HSLA on the user and painted here.
 * When nothing is stored, one is hashed from the user id so everyone looks
 * distinct without a write. There is no avatar upload (see CLAUDE.md).
 */
import {
  avatarInkCss,
  avatarPatternCss,
  resolveAvatarPattern,
  type AvatarPattern,
} from "../../src/domain/avatar-pattern.ts";
import { iconLettersOf } from "../../src/domain/person.ts";

export type AvatarPerson = {
  id: string;
  name: string;
  nickname?: string | null;
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
  iconPattern?: AvatarPattern | string | null;
};

export function Avatar({
  id,
  name,
  nickname = null,
  iconLetters = null,
  iconEmoji = null,
  iconHue = null,
  iconPattern = null,
  size = 34,
}: AvatarPerson & { size?: number }) {
  const pattern = resolveAvatarPattern({ id, iconHue, iconPattern });
  const emoji = iconEmoji?.trim();
  const letters = iconLettersOf({ name, nickname, iconLetters });

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: emoji ? size * 0.52 : size * 0.4,
        background: avatarPatternCss(pattern),
        color: avatarInkCss(pattern),
      }}
    >
      {emoji || letters}
    </span>
  );
}

/** Map a snake_case or camelCase person row onto Avatar props. */
export function avatarFromRow(person: {
  id: string;
  name: string;
  nickname?: string | null;
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
  iconPattern?: AvatarPattern | string | null;
  icon_letters?: string | null;
  icon_emoji?: string | null;
  icon_hue?: number | null;
  icon_pattern?: AvatarPattern | string | null;
}): AvatarPerson {
  return {
    id: person.id,
    name: person.name,
    nickname: person.nickname,
    iconLetters: person.iconLetters ?? person.icon_letters,
    iconEmoji: person.iconEmoji ?? person.icon_emoji,
    iconHue: person.iconHue ?? person.icon_hue,
    iconPattern: person.iconPattern ?? person.icon_pattern,
  };
}
