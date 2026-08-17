/**
 * The SplitSmart mark: a disc split along an off-centre cut, with the pieces
 * pulled apart. Colours come from CSS variables (see styles.css) so the mark
 * tracks the light/dark theme.
 */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label="SplitSmart"
      focusable="false"
    >
      <path
        d="M176.706 132.159C164.072 169.564 125.48 192.884 85.588 185.319C66.1606 181.635 49.7007 171.248 38.1499 157.006L176.706 132.159Z"
        fill="var(--logo-bright)"
      />
      <path
        d="M177.266 77.4246C180.794 89.3118 181.617 102.195 179.148 115.217C178.491 118.68 177.62 122.048 176.554 125.311L25.8112 130.829C20.0619 116.891 18.1614 101.18 21.1799 85.2622C21.6269 82.9052 22.1732 80.5922 22.8124 78.3261L177.266 77.4246Z"
        fill="var(--logo-deep)"
      />
      <path
        d="M116.765 14.9607C139.236 19.2218 157.736 32.4516 169.262 50.242L24.7196 71.0486C36.2866 31.9415 75.8419 7.20066 116.765 14.9607Z"
        fill="var(--logo-bright)"
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
