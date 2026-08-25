/**
 * Absolute URLs for share cards. Crawlers will not fetch a relative og:image.
 *
 * The marketing HTML is built into the Docker image without knowing the public
 * URL, so `web/index.html` uses this placeholder and two places fill it:
 * Hono at request time in production, Vite's `transformIndexHtml` in `yarn
 * dev`. Keep those two on this helper so a rename cannot update one and miss
 * the other.
 */
export const APP_ORIGIN_PLACEHOLDER = "__APP_ORIGIN__";

export function applyAppOrigin(html: string, origin: string): string {
  return html.replaceAll(APP_ORIGIN_PLACEHOLDER, origin.replace(/\/$/, ""));
}
