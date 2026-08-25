/**
 * Name, nickname, and icon editor.
 *
 * Shared by Settings (yourself) and the friend/group screens (placeholder
 * people). The parent owns the value and the save; this is just the fields.
 * Pattern bands and letters/emoji open in modals so the form stays simple.
 */
import { useState } from "react";
import {
  defaultIconLetters,
  type AvatarPattern,
} from "../../src/domain/person.ts";
import {
  avatarPatternFromId,
  parseAvatarPattern,
  randomizeAvatarPattern,
} from "../../src/domain/avatar-pattern.ts";
import { Avatar } from "./Avatar.tsx";
import { AvatarPatternEditor } from "./AvatarPatternEditor.tsx";
import { HelpTip } from "./HelpTip.tsx";
import { Modal } from "./Modal.tsx";

export type IdentityDraft = {
  name: string;
  nickname: string;
  iconLetters: string;
  iconEmoji: string;
  iconHue: number | null;
  iconPattern: AvatarPattern | null;
};

const EMOJIS = [
  "😀", "😎", "🤓", "🥳", "👻", "🤖",
  "🐱", "🐶", "🦊", "🐼", "🐸", "🐙",
  "🌸", "🍀", "⭐", "🔥", "🌈", "🌊",
  "🍕", "🍣", "☕", "🍺", "✈️", "🏠",
  "🎵", "⚽", "🎮", "📚", "💚", "💙",
];

export function emptyIdentityDraft(): IdentityDraft {
  return {
    name: "",
    nickname: "",
    iconLetters: "",
    iconEmoji: "",
    iconHue: null,
    iconPattern: null,
  };
}

export function draftFromPerson(person: {
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
}): IdentityDraft {
  return {
    name: person.name,
    nickname: person.nickname ?? "",
    iconLetters: person.iconLetters ?? person.icon_letters ?? "",
    iconEmoji: person.iconEmoji ?? person.icon_emoji ?? "",
    iconHue: person.iconHue ?? person.icon_hue ?? null,
    iconPattern: parseAvatarPattern(person.iconPattern ?? person.icon_pattern),
  };
}

export function identityPayload(draft: IdentityDraft): {
  name: string;
  nickname: string | null;
  iconLetters: string | null;
  iconEmoji: string | null;
  iconHue: number | null;
  iconPattern: AvatarPattern | null;
} {
  return {
    name: draft.name.trim(),
    nickname: draft.nickname.trim() || null,
    iconLetters: draft.iconLetters.trim() || null,
    iconEmoji: draft.iconEmoji.trim() || null,
    iconHue: draft.iconPattern ? Math.round(draft.iconPattern.base.h) % 360 : draft.iconHue,
    iconPattern: draft.iconPattern,
  };
}

export function PersonIdentityForm({
  id,
  value,
  onChange,
  idPrefix = "identity",
  inviteEmail,
}: {
  id: string;
  value: IdentityDraft;
  onChange: (next: IdentityDraft) => void;
  idPrefix?: string;
  /** Invite address for a placeholder. Omitted when editing your own profile. */
  inviteEmail?: { value: string; onChange: (next: string) => void };
}) {
  const [patternOpen, setPatternOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const previewName = value.nickname.trim() || value.name.trim() || "Name";
  const autoLetters = defaultIconLetters({
    name: value.name,
    nickname: value.nickname.trim() || null,
  });
  const iconPreview = value.iconEmoji.trim() || value.iconLetters.trim() || autoLetters;

  function setPattern(iconPattern: AvatarPattern | null) {
    onChange({
      ...value,
      iconPattern,
      iconHue: iconPattern ? Math.round(iconPattern.base.h) % 360 : null,
    });
  }

  function randomisePattern() {
    const current = value.iconPattern ?? avatarPatternFromId(id, value.iconHue);
    setPattern(randomizeAvatarPattern(current));
  }

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
          iconPattern={value.iconPattern}
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

      {inviteEmail && (
        <div>
          <div className="label-with-help">
            <label htmlFor={`${idPrefix}-email`}>Email (optional)</label>
            <HelpTip label="About the email">
              The address we can send their guest link to. It does not give them
              a login; they still join by opening the link or creating their own
              account and claiming it. Saving does not send mail.
            </HelpTip>
          </div>
          <input
            id={`${idPrefix}-email`}
            type="email"
            value={inviteEmail.value}
            onChange={(e) => inviteEmail.onChange(e.target.value)}
            placeholder="grace@example.com"
            autoComplete="off"
          />
        </div>
      )}

      <div className="identity-row">
        <div className="label-with-help">
          <span className="identity-pattern-label">Profile image</span>
          <HelpTip label="About the profile image">
            A geometric pattern of coloured bands. Randomise for a new one, or
            edit the bands, colours, and rotation.
          </HelpTip>
        </div>
        <div className="identity-row-actions">
          <button type="button" className="secondary inline" onClick={randomisePattern}>
            Randomise
          </button>
          <button type="button" className="secondary inline" onClick={() => setPatternOpen(true)}>
            Edit
          </button>
        </div>
      </div>

      <div className="identity-row">
        <div className="label-with-help">
          <span className="identity-pattern-label">Icon</span>
          <HelpTip label="About icon letters and emoji">
            Up to two characters, or an emoji, drawn on top of the pattern.
            Leave the letters blank to derive them from the name.
          </HelpTip>
        </div>
        <div className="identity-row-actions">
          <span className="identity-icon-chip" aria-hidden="true">
            {iconPreview}
          </span>
          <button type="button" className="secondary inline" onClick={() => setIconOpen(true)}>
            Edit
          </button>
        </div>
      </div>

      <Modal
        open={patternOpen}
        title="Profile image"
        onClose={() => setPatternOpen(false)}
        className="modal-wide"
      >
        <AvatarPatternEditor
          id={id}
          name={value.name}
          nickname={value.nickname.trim() || null}
          iconLetters={value.iconLetters.trim() || null}
          iconEmoji={value.iconEmoji.trim() || null}
          iconHue={value.iconHue}
          value={value.iconPattern}
          onChange={setPattern}
        />
      </Modal>

      <Modal open={iconOpen} title="Icon letters and emoji" onClose={() => setIconOpen(false)}>
        <div className="stack">
          <div>
            <label htmlFor={`${idPrefix}-letters`}>Icon letters</label>
            <input
              id={`${idPrefix}-letters`}
              value={value.iconLetters}
              onChange={(e) => onChange({ ...value, iconLetters: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              maxLength={8}
              placeholder={autoLetters}
            />
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
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              placeholder="Or paste any emoji"
              maxLength={16}
            />
          </fieldset>
        </div>
      </Modal>
    </div>
  );
}
