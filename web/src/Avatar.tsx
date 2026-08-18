/**
 * Person avatars.
 *
 * Letters, an optional emoji, and a colour. Colour defaults to a hash of the
 * user id so the same person is the same colour on every screen without storing
 * anything. There is no avatar upload in this codebase (see CLAUDE.md, "No file
 * uploads") and this is not a placeholder for one.
 */
import {
  avatarBackground,
  avatarHue,
  iconLettersOf,
} from "../../src/domain/person.ts";

export type AvatarPerson = {
  id: string;
  name: string;
  nickname?: string | null;
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
};

export function Avatar({
  id,
  name,
  nickname = null,
  iconLetters = null,
  iconEmoji = null,
  iconHue = null,
  size = 34,
}: AvatarPerson & { size?: number }) {
  const hue = avatarHue({ id, iconHue });
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
        background: avatarBackground(hue),
      }}
    >
      {emoji || letters}
    </span>
  );
}

/** Map a snake_case person row onto Avatar props. */
export function avatarFromRow(person: {
  id: string;
  name: string;
  nickname?: string | null;
  icon_letters?: string | null;
  icon_emoji?: string | null;
  icon_hue?: number | null;
}): AvatarPerson {
  return {
    id: person.id,
    name: person.name,
    nickname: person.nickname,
    iconLetters: person.icon_letters,
    iconEmoji: person.icon_emoji,
    iconHue: person.icon_hue,
  };
}
