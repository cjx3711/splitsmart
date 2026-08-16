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
  id: number;
  size?: number;
}) {
  // Golden-angle stepping spreads consecutive ids far apart in hue, so the
  // first handful of people in a group never look alike.
  const hue = (id * 137.508) % 360;

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
