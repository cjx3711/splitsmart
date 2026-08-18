/**
 * How a person is named and shown.
 *
 * PURE. Imported by the frontend the same way split.ts is, so avatar letters
 * and the display-name rule cannot drift from the server.
 *
 * There is no first/last split. That is an America-centric shape Splitwise
 * had; the native model has one `name`, an optional `nickname` used in lists
 * when set, and optional icon overrides (letters, emoji, colour). Nothing
 * financial reads the icon fields.
 */

export const MAX_NAME_LENGTH = 100;
export const MAX_NICKNAME_LENGTH = 40;
export const MAX_ICON_LETTERS = 2;
export const MAX_ICON_EMOJI = 1;

/** Hues offered in the picker. "Auto" is null and hashes from the user id. */
export const ICON_HUES = [12, 32, 48, 72, 145, 168, 188, 205, 230, 262, 292, 328] as const;

export interface PersonName {
  name: string;
  nickname?: string | null;
}

export interface PersonAppearance extends PersonName {
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
}

/** Columns every person payload needs so avatars can render without a second fetch. */
export const PERSON_COLUMNS = [
  "name",
  "nickname",
  "icon_letters",
  "icon_emoji",
  "icon_hue",
] as const;

export function personCamel(row: {
  name: string;
  nickname: string | null;
  icon_letters: string | null;
  icon_emoji: string | null;
  icon_hue: number | null;
}) {
  return {
    name: row.name,
    nickname: row.nickname,
    iconLetters: row.icon_letters,
    iconEmoji: row.icon_emoji,
    iconHue: row.icon_hue,
  };
}

export function personSnake(row: {
  name: string;
  nickname: string | null;
  icon_letters: string | null;
  icon_emoji: string | null;
  icon_hue: number | null;
}) {
  return {
    name: row.name,
    nickname: row.nickname,
    icon_letters: row.icon_letters,
    icon_emoji: row.icon_emoji,
    icon_hue: row.icon_hue,
  };
}

export function graphemes(value: string): string[] {
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].map(
    (part) => part.segment,
  );
}

/** What lists, comments, and emails call them. Nickname wins when set. */
export function displayName(person: PersonName): string {
  const nick = person.nickname?.trim();
  return nick || person.name;
}

/**
 * Letters drawn when no custom `iconLetters` is set.
 *
 * Two words → first grapheme of each (`Tanaka Yuki` → `TY`). One word → the
 * first grapheme only (`Madonna` → `M`, `田中雪` → `田`). Never splits a
 * name on a guessed "last name".
 */
export function defaultIconLetters(person: PersonName): string {
  const source = displayName(person).trim();
  if (!source) return "?";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const a = graphemes(words[0]!)[0] ?? "";
    const b = graphemes(words[1]!)[0] ?? "";
    return upperGrapheme(a) + upperGrapheme(b) || "?";
  }
  return upperGrapheme(graphemes(source)[0] ?? "") || "?";
}

export function iconLettersOf(person: PersonAppearance): string {
  const custom = person.iconLetters?.trim();
  if (custom) return custom;
  return defaultIconLetters(person);
}

/** Same hash Avatar used before colour was stored, so unset hues stay stable. */
export function hueFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export function avatarHue(person: { id: string; iconHue?: number | null }): number {
  return person.iconHue ?? hueFromId(person.id);
}

export function avatarBackground(hue: number): string {
  return `linear-gradient(150deg, hsl(${hue} 62% 68%), hsl(${(hue + 26) % 360} 58% 52%))`;
}

function upperGrapheme(value: string): string {
  const upper = value.toLocaleUpperCase();
  return graphemes(upper)[0] ?? value;
}
