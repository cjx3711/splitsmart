/// <reference lib="dom" />
/**
 * Shared helpers for the deterministic smoke suite.
 *
 * Capture, flows and compare all go through here so a login, a click, or a
 * normalisation rule cannot mean one thing in a screenshot and another in a
 * click-through test.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";

export const ROOT = resolve(import.meta.dirname, "..");
export const SMOKE_DB = join(ROOT, "data", "smoke.db");
export const DEFAULT_BASE = "http://localhost:5644";
export const BASELINE_PNG = join(ROOT, "smoke", "baselines", "png");
export const BASELINE_DOM = join(ROOT, "smoke", "baselines", "dom");

export const ACCOUNTS = {
  user: { email: "test@example.com", password: "password123" },
  jj: { email: "jj@example.com", password: "password123" },
} as const;

export type Account = keyof typeof ACCOUNTS;

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Everything that changes between two runs of an app that did not change.
 *
 * Amounts, names, counts and labels are left alone - those are the regression.
 */
const RULES: [RegExp, string][] = [
  [/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<ULID>"],
  [/\blink_[A-Za-z0-9_-]{16,}\b/g, "<LINK_SECRET>"],
  [/\/guest\/l\/[A-Za-z0-9_-]{16,}/g, "/guest/l/<LINK_SECRET>"],
  [/([?&]link=)[A-Za-z0-9_-]+/g, "$1<LINK_SECRET>"],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<TIMESTAMP>"],
  [/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>"],
  [
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(,? \d{4})?/g,
    "<DATE>",
  ],
  [/\b\d+ (second|minute|hour|day|week|month|year)s? ago\b/gi, "<AGO>"],
  [/\b(yesterday|today|tomorrow)\b/gi, "<RELDATE>"],
  [/\[ref_\d+\]/g, "[ref]"],
  [/\bref_\d+\b/g, "ref"],
];

/**
 * The dashboard's ≈ overall figure comes from live Exchange Rate API rates
 * (rule 2: display-only). Left alone it would diff every run. Capture also
 * hides the node in CSS; this is the belt for the aria dump.
 */
function blankFxEstimate(lines: string[]): string[] {
  return lines.map((line, i) =>
    lines[i - 1]?.includes("≈") ? line.replace(/-?[\d,]+(\.\d+)?/, "<FX_ESTIMATE>") : line,
  );
}

export function normalise(input: string): string {
  let out = input;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return `${blankFxEstimate(out.split("\n"))
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

export function guestUrl(kind: "group" | "friend", base: string): string {
  if (!existsSync(SMOKE_DB)) {
    throw new Error(`No smoke database at ${SMOKE_DB}. Run yarn smoke:reset first.`);
  }
  const sqlite = new Database(SMOKE_DB, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite
      .prepare(
        `SELECT token_secret FROM access_links
         WHERE kind = ? AND revoked_at IS NULL AND token_secret IS NOT NULL
         LIMIT 1`,
      )
      .get(kind) as { token_secret: string } | undefined;
    if (!row?.token_secret) {
      throw new Error(`No live ${kind} guest link in ${SMOKE_DB}. Re-run yarn smoke:reset.`);
    }
    return `${base.replace(/\/$/, "")}/guest/l/${row.token_secret}`;
  } finally {
    sqlite.close();
  }
}

export async function newContext(
  browser: Browser,
  viewport: { width: number; height: number },
  params: {
    deviceScaleFactor: number;
    colorScheme: "dark" | "light";
    locale: string;
    timezoneId: string;
    reducedMotion: "reduce" | "no-preference";
  },
): Promise<BrowserContext> {
  return browser.newContext({ viewport, ...params });
}

export async function signIn(page: Page, account: Account, base: string): Promise<void> {
  const { email, password } = ACCOUNTS[account];
  await page.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("heading", { name: "Dashboard" }).waitFor({ timeout: 15_000 });
}

/**
 * Click by accessible name, falling back to exact visible text.
 *
 * Expense rows have role=link but an accessible name that includes the date
 * and "paid", so a substring match on "Rent" would also hit "Trader Joe's run".
 * Exact role name first, exact text second.
 */
export async function clickNamed(
  page: Page,
  name: string | { text: string; near: string },
): Promise<void> {
  // On mobile the sidebar is `display: none` unless the menu is open. A hidden
  // rail link still matches getByRole, and clicking it times out. Visible only.
  if (typeof name !== "string") {
    await page
      .locator('[role="link"], button')
      .filter({ hasText: name.text })
      .filter({ hasText: name.near })
      .filter({ visible: true })
      .first()
      .click({ timeout: 15_000 });
    return;
  }
  const target = page
    .getByRole("link", { name, exact: true })
    .or(page.getByRole("button", { name, exact: true }))
    .or(page.getByText(name, { exact: true }));
  await target.filter({ visible: true }).first().click({ timeout: 15_000 });
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement) el.blur();
  });
  await page.waitForTimeout(200);
}

export async function dumpDom(page: Page): Promise<string> {
  const body = page.locator("body");
  let raw: string;
  try {
    raw = await body.ariaSnapshot();
  } catch {
    raw = await body.innerText();
  }
  return normalise(raw);
}

export function chromiumHint(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return `${message}\n\nPlaywright's Chromium is not installed. Run:\n  yarn playwright install chromium`;
  }
  return message;
}
