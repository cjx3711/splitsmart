/**
 * Name, nickname, and icon editor.
 *
 * Shared by Settings (yourself) and the friend/group screens (placeholder
 * people). The parent owns the value and the save; this is just the fields.
 */
import { ICON_HUES, defaultIconLetters } from "../../src/domain/person.ts";
import { Avatar } from "./Avatar.tsx";

export type IdentityDraft = {
  name: string;
  nickname: string;
  iconLetters: string;
  iconEmoji: string;
  iconHue: number | null;
};

const EMOJIS = [
  "😀", "😎", "🤓", "🥳", "👻", "🤖",
  "🐱", "🐶", "🦊", "🐼", "🐸", "🐙",
  "🌸", "🍀", "⭐", "🔥", "🌈", "🌊",
  "🍕", "🍣", "☕", "🍺", "✈️", "🏠",
  "🎵", "⚽", "🎮", "📚", "💚", "💙",
];

export function emptyIdentityDraft(): IdentityDraft {
  return { name: "", nickname: "", iconLetters: "", iconEmoji: "", iconHue: null };
}

export function draftFromPerson(person: {
  name: string;
  nickname?: string | null;
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
  icon_letters?: string | null;
  icon_emoji?: string | null;
  icon_hue?: number | null;
}): IdentityDraft {
  return {
    name: person.name,
    nickname: person.nickname ?? "",
    iconLetters: person.iconLetters ?? person.icon_letters ?? "",
    iconEmoji: person.iconEmoji ?? person.icon_emoji ?? "",
    iconHue: person.iconHue ?? person.icon_hue ?? null,
  };
}

export function identityPayload(draft: IdentityDraft): {
  name: string;
  nickname: string | null;
  iconLetters: string | null;
  iconEmoji: string | null;
  iconHue: number | null;
} {
  return {
    name: draft.name.trim(),
    nickname: draft.nickname.trim() || null,
    iconLetters: draft.iconLetters.trim() || null,
    iconEmoji: draft.iconEmoji.trim() || null,
    iconHue: draft.iconHue,
  };
}

export function PersonIdentityForm({
  id,
  value,
  onChange,
  idPrefix = "identity",
}: {
  id: string;
  value: IdentityDraft;
  onChange: (next: IdentityDraft) => void;
  idPrefix?: string;
}) {
  const previewName = value.nickname.trim() || value.name.trim() || "Name";
  const autoLetters = defaultIconLetters({
    name: value.name,
    nickname: value.nickname.trim() || null,
  });

  return (
    <div className="identity-form">
      <div className="identity-preview">
        <Avatar
          id={id}
          name={previewName}
          nickname={value.nickname.trim() || null}
          iconLetters={value.iconLetters.trim() || null}
          iconEmoji={value.iconEmoji.trim() || null}
          iconHue={value.iconHue}
          size={64}
        />
        <div>
          <div className="identity-preview-name">{previewName}</div>
          {value.nickname.trim() && value.name.trim() && (
            <div className="muted">{value.name.trim()}</div>
          )}
        </div>
      </div>

      <div>
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          id={`${idPrefix}-name`}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          required
          maxLength={100}
          autoComplete="name"
        />
      </div>

      <div>
        <label htmlFor={`${idPrefix}-nickname`}>Nickname</label>
        <input
          id={`${idPrefix}-nickname`}
          value={value.nickname}
          onChange={(e) => onChange({ ...value, nickname: e.target.value })}
          maxLength={40}
          placeholder="Optional. Shown in lists instead of the full name."
        />
      </div>

      <div>
        <label htmlFor={`${idPrefix}-letters`}>Icon letters</label>
        <input
          id={`${idPrefix}-letters`}
          value={value.iconLetters}
          onChange={(e) => onChange({ ...value, iconLetters: e.target.value })}
          maxLength={8}
          placeholder={autoLetters}
        />
        <p className="field-hint">
          Up to two characters. Leave blank to derive them from the name.
        </p>
      </div>

      <fieldset className="identity-fieldset">
        <legend>Icon emoji</legend>
        <div className="identity-emoji-grid">
          <button
            type="button"
            className={!value.iconEmoji ? "identity-swatch selected" : "identity-swatch"}
            onClick={() => onChange({ ...value, iconEmoji: "" })}
            aria-pressed={!value.iconEmoji}
            aria-label="No emoji"
          >
            {value.iconLetters.trim() || autoLetters}
          </button>
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={
                value.iconEmoji === emoji ? "identity-swatch selected" : "identity-swatch"
              }
              onClick={() => onChange({ ...value, iconEmoji: emoji })}
              aria-pressed={value.iconEmoji === emoji}
              aria-label={`Use ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
        <label htmlFor={`${idPrefix}-emoji`} className="sr-only">
          Or paste any emoji
        </label>
        <input
          id={`${idPrefix}-emoji`}
          value={value.iconEmoji}
          onChange={(e) => onChange({ ...value, iconEmoji: e.target.value })}
          placeholder="Or paste any emoji"
          maxLength={16}
        />
      </fieldset>

      <fieldset className="identity-fieldset">
        <legend>Icon colour</legend>
        <div className="identity-hue-row">
          <button
            type="button"
            className={
              value.iconHue === null ? "identity-hue auto selected" : "identity-hue auto"
            }
            onClick={() => onChange({ ...value, iconHue: null })}
            aria-pressed={value.iconHue === null}
          >
            Auto
          </button>
          {ICON_HUES.map((hue) => (
            <button
              key={hue}
              type="button"
              className={value.iconHue === hue ? "identity-hue selected" : "identity-hue"}
              style={{
                background: `linear-gradient(150deg, hsl(${hue} 62% 68%), hsl(${(hue + 26) % 360} 58% 52%))`,
              }}
              onClick={() => onChange({ ...value, iconHue: hue })}
              aria-pressed={value.iconHue === hue}
              aria-label={`Hue ${hue}`}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}
