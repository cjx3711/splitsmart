/**
 * The handful of inline SVG glyphs the chrome uses.
 *
 * Inline rather than an icon font or a package: there are two of them, they
 * inherit `currentColor` and the surrounding font-size, and a dependency for
 * that would be larger than the file. `aria-hidden` on both — every caller
 * pairs the glyph with a real word, so a screen reader that also announced
 * "plus" would be reading punctuation aloud.
 */

export function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="icon-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function SwapIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="icon-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 5.5h9.5M9.5 3l2.5 2.5L9.5 8" />
      <path d="M13.5 10.5H4M6.5 8 4 10.5 6.5 13" />
    </svg>
  );
}
