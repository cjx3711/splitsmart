/**
 * Initial avatars.
 *
 * Colour is derived from the user id, so the same person is the same colour on
 * every screen and across reloads without storing anything. There is no avatar
 * upload in this codebase (see CLAUDE.md, "No file uploads") and this is not a
 * placeholder for one.
 */
export function Avatar({
  name,
  id,
  size = 34,
}: {
  name: string;
  id: string;
  size?: number;
}) {
  // Hash the ULID so the same person is the same colour on every screen
  // without storing anything. Consecutive integer ids used to be spread with
  // the golden angle; a string hash of the randomness bits does the same job.
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;

  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(150deg, hsl(${hue} 62% 68%), hsl(${(hue + 26) % 360} 58% 52%))`,
      }}
    >
      {initials}
    </span>
  );
}
