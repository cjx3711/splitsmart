/**
 * The screens the pixel + DOM snapshots cover, and the capture settings they
 * are captured under.
 *
 * ONE list, used by both `smoke:baseline` and `smoke:capture`. A baseline and a
 * run that disagree about the viewport, the colour scheme or the locale would
 * diff on every pixel for no reason, and the only way to guarantee they agree
 * is for neither to own the settings.
 *
 * Every screen is captured at both desktop and mobile. Routes that need a
 * ULID are reached by clicking names from `scripts/seed-demo.ts`, not by URL.
 */

import type { Account } from "./smoke-lib.ts";

export type Viewport = "desktop" | "mobile";

export type ScreenAuth =
  | { kind: "none" }
  | { kind: "user"; account?: Account }
  | { kind: "guest"; link: "group" | "friend" };

export type ScreenDef = {
  /** File name, without extension or viewport suffix. */
  id: string;
  auth: ScreenAuth;
  /** Where to land first. Relative to the web origin. Ignored for guest auth. */
  path: string;
  /** Accessible names / exact text to click, in order, after landing. */
  click?: Array<string | { text: string; near: string }>;
  /** Text that must be on screen before the shutter opens. */
  waitForText: string;
  /** Extra selectors to make invisible for this screen only. */
  hide?: string[];
  fullPage?: boolean;
};

export type Screen = ScreenDef & {
  id: string;
  viewport: Viewport;
};

export const VIEWPORTS: Record<Viewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 375, height: 812 },
};

/**
 * Capture parameters that must match between a baseline and a run. Written into
 * each capture's manifest.json; `smoke:compare` refuses to call a diff a
 * regression when these differ, because then it isn't one.
 */
export const CAPTURE_PARAMS = {
  deviceScaleFactor: 1,
  colorScheme: "dark" as const,
  locale: "en-US",
  timezoneId: "UTC",
  reducedMotion: "reduce" as const,
};

/**
 * Injected into every page before the shutter opens.
 *
 * Everything here is a value that is random or live by design. Neutralising
 * them in CSS beats masking: the box keeps its size, so layout still compares.
 *
 *   .avatar     hue is hashed from the user's ULID; every smoke:reset mints new ones.
 *   .estimate   the ≈ overall figure, converted at live Frankfurter rates.
 *   .comment-time  system comments are stamped at seed time, not SEED_TODAY.
 *   .sync-badge / .syncbar  pending vs synced is a race against the outbox.
 */
export const STABILISE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  *:focus, *:focus-visible {
    outline: none !important;
    box-shadow: none !important;
  }
  .avatar { background: #55606e !important; }
  /* Live FX estimate: presence is a race against Frankfurter. Drop the node
     from layout rather than hiding it in place, or a late fetch shifts pixels. */
  .estimate { display: none !important; }
  .comment-time, .sync-badge, .syncbar { visibility: hidden !important; }
`;

const DEFS: ScreenDef[] = [
  {
    id: "marketing-home",
    auth: { kind: "none" },
    path: "/",
    waitForText: "Keep track of who paid for dinner.",
    fullPage: true,
  },
  {
    id: "login",
    auth: { kind: "none" },
    path: "/app",
    waitForText: "Sent a guest link?",
  },
  {
    id: "dashboard",
    auth: { kind: "user" },
    path: "/app",
    waitForText: "You are owed",
  },
  {
    id: "groups",
    auth: { kind: "user" },
    path: "/app/groups",
    waitForText: "Weekend in Tokyo",
  },
  {
    id: "group-tokyo",
    auth: { kind: "user" },
    path: "/app/groups",
    click: ["Weekend in Tokyo"],
    waitForText: "Ramen at Ichiran",
  },
  {
    id: "group-apartment",
    auth: { kind: "user" },
    path: "/app/groups",
    click: ["Apartment 4B"],
    waitForText: "Trader Joe's run",
  },
  {
    id: "friends",
    auth: { kind: "user" },
    path: "/app/friends",
    waitForText: "Ah Beng",
  },
  {
    id: "friend-ahbeng",
    auth: { kind: "user" },
    path: "/app/friends",
    click: ["Ah Beng"],
    waitForText: "JJ",
  },
  {
    id: "all-expenses",
    auth: { kind: "user" },
    path: "/app/expenses",
    waitForText: "Trader Joe's run",
  },
  {
    id: "expense-detail",
    auth: { kind: "user" },
    path: "/app/expenses",
    click: ["Trader Joe's run"],
    waitForText: "Did this include the laundry stuff?",
  },
  {
    id: "expense-rent",
    auth: { kind: "user" },
    path: "/app/groups",
    click: ["Apartment 4B", { text: "Rent", near: "repeats" }],
    waitForText: "will be created soon",
  },
  {
    id: "expense-series",
    auth: { kind: "user" },
    path: "/app/groups",
    click: [
      "Apartment 4B",
      { text: "Rent", near: "repeats" },
      "View all bills in this series",
    ],
    waitForText: "Monthly series",
  },
  {
    id: "expense-rent-stop",
    auth: { kind: "user" },
    path: "/app/groups",
    click: [
      "Apartment 4B",
      { text: "Rent", near: "repeats" },
      "Stop repeating",
    ],
    waitForText: "Stop repeating this series?",
  },
  {
    id: "add-expense-dialog",
    auth: { kind: "user" },
    path: "/app",
    click: ["Add Expense"],
    waitForText: "Equally",
  },
  {
    id: "settings",
    auth: { kind: "user" },
    path: "/app/settings",
    waitForText: "API tokens",
  },
  {
    id: "admin",
    auth: { kind: "user" },
    path: "/app/admin?as_of=2026-08-18",
    waitForText: "Lee Jin Jie",
  },
  {
    id: "admin-user",
    auth: { kind: "user" },
    path: "/app/admin?as_of=2026-08-18",
    click: [{ text: "View", near: "Lee Jin Jie" }],
    waitForText: "Expenses created",
  },
  {
    id: "jj-dashboard",
    auth: { kind: "user", account: "jj" },
    path: "/app",
    waitForText: "You are owed",
  },
  {
    id: "jj-tokyo",
    auth: { kind: "user", account: "jj" },
    path: "/app/groups",
    click: ["Weekend in Tokyo"],
    waitForText: "Ramen at Ichiran",
  },
  {
    id: "jj-apartment",
    auth: { kind: "user", account: "jj" },
    path: "/app/groups",
    click: ["Apartment 4B"],
    waitForText: "Trader Joe's run",
  },
  {
    id: "guest-picker",
    auth: { kind: "guest", link: "group" },
    path: "/",
    waitForText: "Which one are you?",
  },
  {
    id: "guest-group",
    auth: { kind: "guest", link: "group" },
    path: "/",
    click: ["Hana"],
    waitForText: "Ramen at Ichiran",
  },
];

/** Desktop and mobile for every screen. The id carries the viewport suffix for mobile. */
export const SCREENS: Screen[] = DEFS.flatMap((def) => [
  { ...def, viewport: "desktop" as const },
  { ...def, id: `${def.id}-mobile`, viewport: "mobile" as const },
]);

export function authKey(screen: Screen): string {
  if (screen.auth.kind === "none") return "none";
  if (screen.auth.kind === "guest") return `guest:${screen.auth.link}`;
  return `user:${screen.auth.account ?? "user"}`;
}
