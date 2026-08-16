/**
 * The SplitSmart mark.
 *
 * A disc cut by an off-centre diagonal and pulled apart along the cut. The two
 * pieces are deliberately UNEQUAL — this app splits by exact amounts, percents,
 * shares and adjustments, not just down the middle, and a 50/50 mark would say
 * the opposite.
 *
 * Geometry is hand-computed rather than clipped so the component carries no
 * element ids: it can be rendered many times on a page without colliding.
 * Colours come from CSS variables (see styles.css) so the mark tracks the
 * light/dark theme instead of fighting it.
 */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="SplitSmart"
      focusable="false"
    >
      {/* Minor segment — the smaller share, lifted up and to the left. */}
      <path
        d="M1.814 16.624 A14.2 14.2 0 0 1 25.956 5.876 Z"
        transform="translate(-0.529 -1.188)"
        fill="var(--logo-bright)"
      />
      {/* Major segment. */}
      <path
        d="M25.956 5.876 A14.2 14.2 0 1 1 1.814 16.624 Z"
        transform="translate(0.529 1.188)"
        fill="var(--logo-deep)"
      />
    </svg>
  );
}

/** Mark plus wordmark, for the top bar and the sign-in screen. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word">SplitSmart</span>
    </span>
  );
}
