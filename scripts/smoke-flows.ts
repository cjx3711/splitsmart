/// <reference lib="dom" />
/**
 * Interactive smoke flows: the clicks a screenshot of a seeded page cannot
 * cover (adding an expense, the split editor refusing a bad split, posting a
 * comment, filters, the guest shell's network, a second member seeing the
 * write).
 *
 * Assertions, not opinions. A failure writes a PNG next to the result so a
 * model can look at it; the run itself does not.
 *
 * Usage:
 *   yarn smoke:flows -- --out <run-dir> [--base http://localhost:5644] [--only F1,F7]
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_PARAMS, STABILISE_CSS, VIEWPORTS } from "./smoke-screens.ts";
import {
  DEFAULT_BASE,
  arg,
  chooseCurrency,
  claimFriendLinkAsNewAccount,
  chromiumHint,
  clickNamed,
  expectedConversion,
  guestUrl,
  newContext,
  settle,
  signIn,
  stubExchangeRates,
} from "./smoke-lib.ts";

export type FlowVerdict = "pass" | "fail" | "blocked";

export type FlowResult = {
  id: string;
  title: string;
  verdict: FlowVerdict;
  evidence: string;
  observed?: string;
  screenshot?: string;
};

type FlowFn = (page: Page, ctx: FlowCtx) => Promise<string>;

type FlowCtx = {
  browser: Browser;
  base: string;
  shotDir: string;
};

function parseMoney(texts: string[]): number[] {
  return texts.map((t) => {
    const m = t.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!m) throw new Error(`no amount in ${JSON.stringify(t)}`);
    return Math.round(Number(m[0]) * 100);
  });
}

function dialog(page: Page) {
  return page.getByRole("dialog");
}

async function openGroupExpense(page: Page, group: string): Promise<void> {
  await clickNamed(page, "Groups");
  await clickNamed(page, group);
  await page.locator(".page-actions").getByRole("button", { name: "Expense", exact: true }).click();
  await dialog(page).getByLabel("Description").waitFor({ timeout: 10_000 });
}

async function openRentTemplate(page: Page): Promise<void> {
  await clickNamed(page, "Groups");
  await clickNamed(page, "Apartment 4B");
  await clickNamed(page, { text: "Rent", near: "first bill" });
  await page.getByRole("button", { name: "Stop repeating" }).waitFor({ timeout: 10_000 });
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Next-bill dates only - never the dates of bills already in the list. */
function nextBillDate(text: string): string | null {
  const match =
    text.match(/next bill will be (\d{4}-\d{2}-\d{2})/i) ??
    text.match(/Coming\s+(\d{4}-\d{2}-\d{2})/) ??
    text.match(/next on\s+(\d{4}-\d{2}-\d{2})/i) ??
    text.match(/The bill for (\d{4}-\d{2}-\d{2}) will be created soon/);
  return match?.[1] ?? null;
}

function requireFutureNextBill(label: string, text: string): string {
  const date = nextBillDate(text);
  if (!date) throw new Error(`${label} had no next-bill date: ${JSON.stringify(text.slice(0, 400))}`);
  const today = utcToday();
  if (date < today) {
    throw new Error(`${label} next bill ${date} is before ${today}; resume backfilled`);
  }
  return date;
}

async function seriesRentBillCount(page: Page): Promise<number> {
  return page.locator("main .list-item[role='link']").filter({ hasText: "Rent" }).count();
}

/** Only the two currencies the balance flows use. Keeps `decimals` honest. */
const DECIMALS: Record<string, number> = { USD: 2, JPY: 0 };
const decimalsFor = (code: string): number => {
  const d = DECIMALS[code.toUpperCase()];
  if (d === undefined) throw new Error(`smoke: no decimal count pinned for ${code}`);
  return d;
};

async function openGroup(page: Page, group: string): Promise<void> {
  await clickNamed(page, "Groups");
  await clickNamed(page, group);
  await page.getByRole("heading", { name: "Balances" }).waitFor({ timeout: 15_000 });
}

/** Every suggested transfer on a group page, as `{ minor, code }`. */
async function settleRows(page: Page): Promise<Array<{ minor: number; code: string }>> {
  const texts = await page.locator(".settle-list li .amount").allInnerTexts();
  return texts.map((t) => {
    const match = t.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*([A-Z]{3})/);
    if (!match) throw new Error(`no amount+code in ${JSON.stringify(t)}`);
    const code = match[2]!;
    return { minor: Math.round(Number(match[1]) * 10 ** decimalsFor(code)), code };
  });
}

/**
 * Add one expense to a group, split equally, paid by the signed-in user.
 * `currency` is only touched when it differs from the group's own, because the
 * picker is a listbox and opening it needlessly is a chance to get stuck.
 */
async function addGroupExpense(
  page: Page,
  group: string,
  description: string,
  amount: string,
  currency?: string,
): Promise<void> {
  await openGroupExpense(page, group);
  await dialog(page).getByLabel("Description").fill(description);
  await dialog(page).getByLabel("Amount").fill(amount);
  if (currency) await chooseCurrency(dialog(page), "currency", currency);
  await dialog(page).getByRole("button", { name: "Add expense" }).click();
  await dialog(page).waitFor({ state: "hidden", timeout: 15_000 });
  await page.getByText(description).filter({ visible: true }).first().waitFor({ timeout: 15_000 });
}

/**
 * The friend "Between you" card, once the mirror has actually filled it in.
 *
 * Waiting on the "Between you" heading is not enough: it renders as soon as the
 * person resolves, and for a beat the card underneath reads "You're settled up"
 * while the balances are still arriving. Reading innerText in that beat is a
 * flake that looks exactly like a missing balance.
 */
async function friendBalanceCard(page: Page, showing: string, whenMissing: string): Promise<string> {
  const card = page.locator(".friend-aside .card").first();
  try {
    await page.locator(".friend-aside .card").filter({ hasText: showing }).first().waitFor({ timeout: 20_000 });
  } catch {
    throw new Error(whenMissing);
  }
  return (await card.innerText()).trim();
}

function requireText(actual: string, needle: string, label: string): void {
  if (!actual.includes(needle)) {
    throw new Error(`${label} did not mention ${JSON.stringify(needle)}: ${JSON.stringify(actual.slice(0, 400))}`);
  }
}

async function screenshot(page: Page, ctx: FlowCtx, id: string): Promise<string> {
  await page.addStyleTag({ content: STABILISE_CSS }).catch(() => {});
  const path = join(ctx.shotDir, `${id}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled", caret: "hide", scale: "css" });
  return path;
}

const FLOWS: Array<{ id: string; title: string; viewport?: "desktop" | "mobile"; run: FlowFn }> = [
  {
    id: "F1",
    title: "Add an equal-split expense; leftover cent is allocated",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await openGroupExpense(page, "Book Club");
      await dialog(page).getByLabel("Description").fill("Smoke test lunch");
      await dialog(page).getByLabel("Amount").fill("31.00");
      await dialog(page).getByText("Who owes what").waitFor();
      const owed = await dialog(page).locator(".split-row-owed").allInnerTexts();
      const minors = parseMoney(owed.filter((t) => t.trim() !== ""));
      if (minors.length !== 3) {
        throw new Error(`expected 3 shares, got ${JSON.stringify(owed)}`);
      }
      const sum = minors.reduce((a, b) => a + b, 0);
      if (sum !== 3100) {
        throw new Error(`shares ${minors.join("+")} = ${sum}, expected 3100`);
      }
      const sorted = [...minors].sort((a, b) => b - a);
      if (sorted[0] !== 1034 || sorted[1] !== 1033 || sorted[2] !== 1033) {
        throw new Error(`expected 10.34 / 10.33 / 10.33, got ${minors.map((n) => (n / 100).toFixed(2)).join(" / ")}`);
      }
      await dialog(page).getByRole("button", { name: "Add expense" }).click();
      await page.getByText("Smoke test lunch").filter({ visible: true }).first().waitFor({ timeout: 15_000 });
      return `Preview shares ${sorted.map((n) => (n / 100).toFixed(2)).join(" / ")} USD summed to 31.00; saved row appeared in Book Club.`;
    },
  },
  {
    id: "F2",
    title: "Split editor calls out incomplete percent and exact totals",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await openGroupExpense(page, "Book Club");
      await dialog(page).getByLabel("Description").fill("Will not save");
      await dialog(page).getByLabel("Amount").fill("100.00");
      await dialog(page).getByRole("button", { name: "Percentages" }).click();

      await dialog(page).getByLabel("You: percentage").fill("50");
      await dialog(page).getByLabel("Jas: percentage").fill("20");
      await dialog(page).getByLabel("Danial: percentage").fill("0");
      await dialog(page).locator(".split-problem").waitFor({ timeout: 5_000 });
      const percentMsg = (await dialog(page).locator(".split-problem").innerText()).trim();
      if (!/expected 100/i.test(percentMsg)) {
        throw new Error(`percent problem was ${JSON.stringify(percentMsg)}`);
      }

      await dialog(page).getByLabel("Danial: percentage").fill("30");
      await dialog(page).locator(".split-problem").waitFor({ state: "hidden", timeout: 5_000 });

      await dialog(page).getByRole("button", { name: "Exact amounts" }).click();
      await dialog(page).getByLabel("You: exact amount").fill("10.00");
      await dialog(page).getByLabel("Jas: exact amount").fill("10.00");
      await dialog(page).getByLabel("Danial: exact amount").fill("10.00");
      await dialog(page).locator(".split-problem").waitFor({ timeout: 5_000 });
      const exactMsg = (await dialog(page).locator(".split-problem").innerText()).trim();
      if (!/add up/i.test(exactMsg)) {
        throw new Error(`exact problem was ${JSON.stringify(exactMsg)}`);
      }

      await dialog(page).getByRole("button", { name: "Close" }).click();
      await dialog(page).waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
      return `Percent 50/20/0 → ${percentMsg}; 50/20/30 cleared it. Exact 10+10+10 → ${exactMsg}. Form discarded.`;
    },
  },
  {
    id: "F3",
    title: "Comment on an expense appears without a reload",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await clickNamed(page, "All expenses");
      await clickNamed(page, "Trader Joe's run");
      await page.getByLabel("Add a comment").fill("smoke test comment");
      await page.getByRole("button", { name: "Post" }).click();
      await page.getByText("smoke test comment").waitFor({ timeout: 15_000 });
      const system = page.locator(".comment-system");
      if ((await system.count()) < 1) {
        throw new Error("expected a system comment on Trader Joe's run (the seed edits it)");
      }
      const deleteButtons = page.getByRole("button", { name: "Delete" });
      // Own user comments are deletable; system comments are not.
      if ((await deleteButtons.count()) < 1) {
        throw new Error("typed comment should offer Delete");
      }
      return "Typed comment appeared immediately; system comment present and not given a Delete control of its own.";
    },
  },
  {
    id: "F4",
    title: "Filters, literal percent search, CSV control",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await clickNamed(page, "All expenses");
      const search = page.getByLabel("Search descriptions");
      await search.fill("coffee");
      await page.getByText("Trader Joe's run").filter({ visible: true }).waitFor({ state: "hidden", timeout: 5_000 });
      await page.getByText("Coffee catch-up").filter({ visible: true }).waitFor({ timeout: 5_000 });
      await page.getByText("Friday coffee round").filter({ visible: true }).first().waitFor({ timeout: 5_000 });

      await search.fill("50%");
      await page.getByText("Nothing matches those filters.").waitFor({ timeout: 5_000 });

      await page.getByRole("button", { name: "Clear" }).click();
      await page.getByText("Trader Joe's run").waitFor({ timeout: 5_000 });

      await page.getByRole("button", { name: "More actions" }).click();
      const csv = page.getByRole("menuitem", { name: "Download CSV" });
      if (!(await csv.isEnabled())) throw new Error("Download CSV was disabled");
      return "coffee narrowed to coffee expenses; 50% matched nothing (literal percent); CSV item enabled in the more menu.";
    },
  },
  {
    id: "F5",
    title: "Guest link: group only, no /api/v1/ outside /guest/",
    run: async (page, ctx) => {
      const leaked: string[] = [];
      page.on("request", (req) => {
        const url = req.url();
        const path = url.replace(ctx.base, "");
        if (path.startsWith("/api/v1/") && !path.startsWith("/api/v1/guest/")) leaked.push(path);
      });
      await page.goto(guestUrl("group", ctx.base), { waitUntil: "domcontentloaded" });
      await page.getByText("Which one are you?").waitFor({ timeout: 15_000 });
      await clickNamed(page, "Hana");
      await page.getByText("Ramen at Ichiran").waitFor({ timeout: 15_000 });
      await settle(page);
      if (leaked.length > 0) {
        throw new Error(`guest shell hit ${leaked.slice(0, 5).join(", ")}`);
      }
      const body = await page.locator("body").innerText();
      for (const forbidden of ["Settings", "Import", "Add a friend", "Office Lunch Club"]) {
        if (body.includes(forbidden)) {
          throw new Error(`guest shell leaked ${JSON.stringify(forbidden)}`);
        }
      }
      return "Hana saw Weekend in Tokyo expenses; no Settings/Import; no requests to /api/v1/ outside /guest/.";
    },
  },
  {
    id: "F6",
    title: "Mobile viewport: menu, no horizontal overflow",
    viewport: "mobile",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      const overflow = async () =>
        page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

      if (await overflow()) throw new Error("dashboard overflowed horizontally");

      await page.getByRole("button", { name: "Show menu" }).filter({ visible: true }).click();
      await page.getByRole("navigation", { name: "Main" }).waitFor();
      // Via the Groups list, not the rail: the rail shows the five most recent
      // groups, and the flows that run before this one bump Book Club and
      // Apartment 4B past Weekend in Tokyo. What this flow is testing is the
      // viewport, so it must not also depend on which groups were touched last.
      await clickNamed(page, "Groups");
      await clickNamed(page, "Weekend in Tokyo");
      await page.getByText("Ramen at Ichiran").waitFor({ timeout: 10_000 });
      if (await overflow()) throw new Error("Tokyo group overflowed horizontally");

      await clickNamed(page, "Ramen at Ichiran");
      await page.getByRole("heading", { name: /Ramen at Ichiran/ }).waitFor({ timeout: 10_000 });
      if (await overflow()) throw new Error("expense detail overflowed horizontally");

      return "375×812: sidebar behind Show menu, Tokyo group and ramen detail did not scroll sideways.";
    },
  },
  {
    id: "F7",
    title: "A second group member sees the expense the first one just added",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await openGroupExpense(page, "Apartment 4B");
      await dialog(page).getByLabel("Description").fill("Smoke test paint");
      await dialog(page).getByLabel("Amount").fill("40.00");
      await dialog(page).getByRole("button", { name: "Add expense" }).click();
      await page.getByText("Smoke test paint").first().waitFor({ timeout: 15_000 });

      const jjCtx = await newContext(ctx.browser, VIEWPORTS.desktop, CAPTURE_PARAMS);
      const jj = await jjCtx.newPage();
      try {
        await signIn(jj, "jj", ctx.base);
        await settle(jj);
        await clickNamed(jj, "Groups");
        await clickNamed(jj, "Apartment 4B");
        await jj.getByText("Smoke test paint").first().waitFor({ timeout: 15_000 });
        const body = await jj.locator("body").innerText();
        if (!/you owe|owes you|gets back/.test(body.toLowerCase())) {
          throw new Error("JJ's apartment page has no directed balances");
        }
        // Test User paid 40, split equally: JJ owes 20 more. The row should
        // not present the same "gets back" direction Test User just saw.
        const youRow = jj.locator(".list-item").filter({ hasText: "You" }).first();
        const youText = await youRow.innerText();
        if (/you get back|gets back/i.test(youText) && !/you owe/i.test(youText)) {
          throw new Error(`JJ (who did not pay) reads as creditor: ${youText.replace(/\s+/g, " ")}`);
        }
        return "Test User saved Smoke test paint (40.00 USD) in Apartment 4B; JJ's session listed it with a directed balance.";
      } finally {
        await jjCtx.close();
      }
    },
  },
  {
    id: "F8",
    title: "Stop a series warns; resume starts from today and does not backfill",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await openRentTemplate(page);

      await page.getByRole("button", { name: "Stop repeating" }).click();
      const stopDlg = dialog(page);
      await stopDlg.getByRole("heading", { name: "Stop repeating this series?" }).waitFor({ timeout: 5_000 });
      const stopCopy = (await stopDlg.innerText()).replace(/\s+/g, " ");
      if (!/missed while it was stopped will not be created/i.test(stopCopy)) {
        throw new Error(`stop warning omitted no-backfill copy: ${stopCopy}`);
      }
      if (!/bills already made stay/i.test(stopCopy)) {
        throw new Error(`stop warning omitted that existing bills stay: ${stopCopy}`);
      }

      await stopDlg.getByRole("button", { name: "Cancel" }).click();
      await stopDlg.waitFor({ state: "hidden", timeout: 5_000 });
      if (!(await page.getByRole("button", { name: "Stop repeating" }).isVisible())) {
        throw new Error("cancelling stop should leave the series live");
      }
      await page.getByText("will be created soon").waitFor({ timeout: 5_000 });

      await page.getByRole("button", { name: "Stop repeating" }).click();
      await dialog(page).getByRole("button", { name: "Stop repeating" }).click();
      await page.getByRole("button", { name: "Resume repeating" }).waitFor({ timeout: 15_000 });
      const stoppedBody = await page.locator("main").innerText();
      if (!/repeating is stopped/i.test(stoppedBody)) {
        throw new Error(`paused Rent page was ${JSON.stringify(stoppedBody.slice(0, 400))}`);
      }
      if (/will be created soon/i.test(stoppedBody)) {
        throw new Error("paused series still advertised a coming bill");
      }

      await clickNamed(page, "View all bills in this series");
      await page.getByText("This series has stopped").waitFor({ timeout: 10_000 });
      const seriesStopped = await page.locator("main").innerText();
      if (/\bComing\b/.test(seriesStopped)) {
        throw new Error("stopped series page still showed a Coming row");
      }
      const billsWhileStopped = await seriesRentBillCount(page);

      await page.getByRole("button", { name: "Resume repeating" }).click();
      const resumeDlg = dialog(page);
      await resumeDlg.getByRole("heading", { name: "Resume repeating?" }).waitFor({ timeout: 5_000 });
      const resumeCopy = (await resumeDlg.innerText()).replace(/\s+/g, " ");
      if (!/will not be created/i.test(resumeCopy)) {
        throw new Error(`resume dialog omitted no-backfill copy: ${resumeCopy}`);
      }
      const resumeOn = requireFutureNextBill("resume dialog", resumeCopy);

      await resumeDlg.getByRole("button", { name: "Cancel" }).click();
      await resumeDlg.waitFor({ state: "hidden", timeout: 5_000 });
      await page.getByText("This series has stopped").waitFor({ timeout: 5_000 });

      await page.getByRole("button", { name: "Resume repeating" }).click();
      await dialog(page).getByRole("button", { name: "Resume repeating" }).click();
      await page.getByRole("button", { name: "Stop repeating" }).waitFor({ timeout: 15_000 });
      const seriesLive = await page.locator("main").innerText();
      if (/this series has stopped/i.test(seriesLive)) {
        throw new Error("series page still said it was stopped after resume");
      }
      if (!/\bComing\b/.test(seriesLive) && !/next on/i.test(seriesLive)) {
        throw new Error("resumed series showed neither Coming nor a next date");
      }
      requireFutureNextBill("resumed series page", seriesLive);
      const billsAfterResume = await seriesRentBillCount(page);
      if (billsAfterResume > billsWhileStopped + 1) {
        throw new Error(
          `resume created ${billsAfterResume - billsWhileStopped} extra bills (had ${billsWhileStopped}); that is backfill`,
        );
      }

      return `Stop warning named missed months; cancel left Rent live; confirm paused it. Resume named ${resumeOn} and did not backfill (${billsWhileStopped} bills stayed ${billsAfterResume}).`;
    },
  },
  {
    id: "F9",
    title: "Clicking a friend opens their friend page",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);

      await clickNamed(page, "Groups");
      await clickNamed(page, "Weekend in Tokyo");
      await page.getByRole("heading", { name: "Balances", exact: true }).waitFor({ timeout: 10_000 });
      await page
        .getByRole("heading", { name: "Balances", exact: true })
        .locator("xpath=following-sibling::div[contains(@class,'list')][1]")
        .locator(".list-item")
        .filter({ hasText: "JJ" })
        .click();
      await page.getByRole("heading", { name: "JJ", exact: true }).waitFor({ timeout: 10_000 });
      const fromBalances = page.url();
      if (!/\/friends\/[^/]+$/.test(fromBalances.replace(ctx.base, ""))) {
        throw new Error(`group balance link landed on ${fromBalances}`);
      }

      await clickNamed(page, "Groups");
      await clickNamed(page, "Weekend in Tokyo");
      await clickNamed(page, "Options");
      await page.getByRole("heading", { name: "Members" }).waitFor({ timeout: 10_000 });
      await page
        .locator(".list-item")
        .filter({ hasText: "member" })
        .filter({ hasText: "JJ" })
        .click();
      await page.getByRole("heading", { name: "JJ", exact: true }).waitFor({ timeout: 10_000 });
      const fromGroup = page.url();
      if (!/\/friends\/[^/]+$/.test(fromGroup.replace(ctx.base, ""))) {
        throw new Error(`group member link landed on ${fromGroup}`);
      }

      await clickNamed(page, "All expenses");
      // Ungrouped; the row does not say "One-on-one" — that label is dashboard-only.
      await clickNamed(page, "Concert tickets");
      await page.getByRole("heading", { name: "Who paid, who owes" }).waitFor({ timeout: 10_000 });
      await page.locator(".list-item").filter({ hasText: "John" }).filter({ hasText: "owes" }).click();
      await page.getByRole("heading", { name: "John", exact: true }).waitFor({ timeout: 10_000 });
      const fromExpense = page.url();
      if (!/\/friends\/[^/]+$/.test(fromExpense.replace(ctx.base, ""))) {
        throw new Error(`expense participant link landed on ${fromExpense}`);
      }

      return "Tokyo balances JJ, Tokyo options member JJ, and Concert tickets participant John all opened /friends/:id.";
    },
  },
  {
    id: "F10",
    title: "Signed-in marketing offers Open app and Log out, not Log in",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await page.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: "Open app" }).first().waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Log out" }).waitFor({ timeout: 10_000 });
      if ((await page.getByRole("link", { name: "Log in" }).count()) > 0) {
        throw new Error("homepage still offered Log in after sign-in");
      }
      await page.getByRole("link", { name: "Open app" }).first().click();
      await page.getByRole("heading", { name: "Dashboard" }).waitFor({ timeout: 15_000 });
      await page.goto(`${ctx.base}/app/login`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Dashboard" }).waitFor({ timeout: 15_000 });
      if ((await page.getByRole("heading", { name: "Log in" }).count()) > 0) {
        throw new Error("/app/login still showed the form while signed in");
      }

      await page.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Log out" }).click();
      await page.getByRole("link", { name: "Log in" }).first().waitFor({ timeout: 10_000 });
      if ((await page.getByRole("button", { name: "Log out" }).count()) > 0) {
        throw new Error("homepage still offered Log out after logging out");
      }
      if ((await page.getByRole("link", { name: "Open app" }).count()) > 0) {
        throw new Error("homepage still offered Open app after logging out");
      }
      await page.goto(`${ctx.base}/app/login`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Log in" }).waitFor({ timeout: 15_000 });

      return "Homepage said Open app and Log out; /app/login redirected while signed in; Log out returned the homepage to Log in.";
    },
  },
  {
    id: "F11",
    title: "A group holding two currencies offers to convert into its default, and does it right",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);

      // Yosemite Camping starts empty and is used by no other flow, so this
      // builds its own mixed-currency group rather than depending on the seed.
      await addGroupExpense(page, "Yosemite Camping", "Smoke test camp food", "60.00");
      await addGroupExpense(page, "Yosemite Camping", "Smoke test onsen", "12000", "JPY");
      await openGroup(page, "Yosemite Camping");

      const before = await settleRows(page);
      const usdBefore = before.filter((r) => r.code === "USD");
      const jpyBefore = before.filter((r) => r.code === "JPY");
      if (usdBefore.length !== 3 || jpyBefore.length !== 3) {
        throw new Error(`expected 3 USD + 3 JPY transfers, got ${JSON.stringify(before)}`);
      }
      if (usdBefore.some((r) => r.minor !== 1500) || jpyBefore.some((r) => r.minor !== 3000)) {
        throw new Error(`expected 15.00 USD and 3000 JPY each, got ${JSON.stringify(before)}`);
      }

      const hint = page.locator(".settle-hints").filter({ hasText: "currencies to settle" });
      const hintText = (await hint.innerText()).trim();
      requireText(hintText, "2 currencies to settle separately", "the convert nudge");
      requireText(hintText, "USD, this group's default currency", "the convert nudge");

      await hint.getByRole("button", { name: "Convert the balances" }).click();
      const convert = dialog(page);
      await convert.getByRole("heading", { name: "Convert balance" }).waitFor({ timeout: 10_000 });
      requireText(
        (await convert.innerText()).trim(),
        "USD is this group's default currency.",
        "the convert dialog",
      );

      await convert.locator(".convert-preview-row").first().waitFor({ timeout: 15_000 });
      const legs = await convert.locator(".convert-preview-row").allInnerTexts();
      const expected = expectedConversion(3000, "JPY", "USD", decimalsFor);
      if (expected !== 2000) throw new Error(`stub rates drifted: 3000 JPY became ${expected}`);
      if (legs.length !== 3) throw new Error(`expected 3 conversion legs, got ${JSON.stringify(legs)}`);
      for (const leg of legs) {
        if (!/3000\s*JPY/.test(leg) || !/20\.00\s*USD/.test(leg)) {
          throw new Error(`leg did not read 3000 JPY → 20.00 USD: ${JSON.stringify(leg)}`);
        }
      }

      await convert.getByRole("button", { name: "Convert to USD" }).click();
      await convert.waitFor({ state: "hidden", timeout: 20_000 });

      // Each debt is now the USD one plus the converted JPY one: 15.00 + 20.00.
      await page
        .locator(".settle-list li")
        .filter({ hasText: "35.00" })
        .first()
        .waitFor({ timeout: 20_000 });
      const after = await settleRows(page);
      if (after.length !== 3 || after.some((r) => r.code !== "USD" || r.minor !== 3500)) {
        throw new Error(`expected 3 × 35.00 USD after converting, got ${JSON.stringify(after)}`);
      }
      if ((await page.locator(".settle-hints").filter({ hasText: "currencies to settle" }).count()) > 0) {
        throw new Error("the convert nudge survived a conversion that left one currency");
      }
      return "Mixed USD+JPY group named USD as its default in the nudge and the dialog; 3000 JPY → 20.00 USD each; settle-up collapsed to 3 × 35.00 USD and the nudge went away.";
    },
  },
  {
    id: "F12",
    title: "Simplify-debts nudge shortens a group's settle-up, and the toggle drives it both ways",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await openGroup(page, "Weekend in Tokyo");

      // Seeded with simplify off: two bills, four people, five per-pair debts.
      const raw = await settleRows(page);
      if (raw.length !== 5 || raw.some((r) => r.code !== "JPY")) {
        throw new Error(`expected 5 raw JPY debts in Tokyo, got ${JSON.stringify(raw)}`);
      }

      const nudge = page.locator(".settle-hints").filter({ hasText: "simplify debts" });
      requireText((await nudge.innerText()).trim(), "5 payments, one per recorded debt", "the simplify nudge");

      await nudge.getByRole("button", { name: "Turn on simplify debts" }).click();
      await page.locator(".settle-list li").nth(3).waitFor({ state: "detached", timeout: 20_000 });
      const simplified = await settleRows(page);
      if (simplified.length !== 3) {
        throw new Error(`simplify should have cut 5 debts to 3, got ${JSON.stringify(simplified)}`);
      }
      // Nets cannot move; only who hands money to whom.
      const rawTotal = raw.reduce((n, r) => n + r.minor, 0);
      const simpleTotal = simplified.reduce((n, r) => n + r.minor, 0);
      if (simpleTotal > rawTotal) {
        throw new Error(`simplifying moved MORE money: ${simpleTotal} vs ${rawTotal}`);
      }
      if ((await nudge.count()) > 0) {
        throw new Error("the simplify nudge stayed up after simplify was turned on");
      }

      // Put the group back the way the seed had it, so no later flow inherits
      // a toggle this one flipped.
      await clickNamed(page, "Options");
      const toggle = page.locator(".setting-toggle input[type=checkbox]");
      await toggle.waitFor({ timeout: 10_000 });
      if (!(await toggle.isChecked())) throw new Error("Options did not show simplify as on");
      // click(), not uncheck(): the write goes to the mirror and then the
      // server, and the checkbox re-renders from a live query when that lands.
      // uncheck() asserts the flip on its own schedule and gives up first.
      await toggle.click();
      await page
        .locator(".setting-toggle input[type=checkbox]:not(:checked)")
        .waitFor({ timeout: 20_000 });
      await openGroup(page, "Weekend in Tokyo");
      await page.locator(".settle-list li").nth(4).waitFor({ timeout: 20_000 });
      const restored = await settleRows(page);
      if (restored.length !== 5) {
        throw new Error(`turning simplify back off should restore 5 debts, got ${JSON.stringify(restored)}`);
      }
      return `Tokyo showed 5 recorded debts and the nudge; turning simplify on cut them to 3 (${simpleTotal} ≤ ${rawTotal} JPY moved) and removed the nudge; turning it off restored 5.`;
    },
  },
  {
    id: "F13",
    title: "A friend with two currencies gets the group page's offer, named as the default currency",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await clickNamed(page, "Friends");
      await clickNamed(page, "Ah Beng");
      await page.getByText("Between you").waitFor({ timeout: 15_000 });

      const owed = await friendBalanceCard(
        page,
        "1200",
        "Ah Beng's 1200 JPY balance never appeared; reset the smoke db",
      );
      requireText(owed, "149.25", "the Ah Beng balance");

      const hint = page.locator(".settle-hints").filter({ hasText: "currencies to settle" });
      const hintText = (await hint.innerText()).trim();
      requireText(hintText, "2 currencies to settle separately", "the friend convert nudge");
      requireText(hintText, "USD, your default currency", "the friend convert nudge");

      await hint.getByRole("button", { name: "Convert the balances" }).click();
      const convert = dialog(page);
      await convert.getByRole("heading", { name: "Convert balance" }).waitFor({ timeout: 10_000 });
      requireText((await convert.innerText()).trim(), "USD is your default currency.", "the convert dialog");

      await convert.locator(".convert-preview-row").first().waitFor({ timeout: 15_000 });
      const legs = await convert.locator(".convert-preview-row").allInnerTexts();
      if (legs.length !== 1 || !/1200\s*JPY/.test(legs[0]!) || !/8\.00\s*USD/.test(legs[0]!)) {
        throw new Error(`expected one leg 1200 JPY → 8.00 USD, got ${JSON.stringify(legs)}`);
      }
      // 149.25 already in USD, plus the 8.00 the yen becomes.
      requireText((await convert.innerText()).trim(), "157.25", "the convert dialog's result line");

      // Cancel: F14 needs this friend's JPY balance intact.
      await convert.getByRole("button", { name: "Cancel" }).click();
      await convert.waitFor({ state: "hidden", timeout: 10_000 });
      return "Ah Beng's page carried the same nudge as a group, naming USD as your default currency; 1200 JPY previewed as 8.00 USD for a 157.25 USD result. Cancelled without writing.";
    },
  },
  {
    id: "F14",
    title: "Settling a friend to zero offers to close the groups that now cancel out, and takes no for an answer",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await clickNamed(page, "Friends");
      await clickNamed(page, "Ah Beng");
      await page.getByText("Between you").waitFor({ timeout: 15_000 });
      await friendBalanceCard(
        page,
        "1200",
        "F14 needs Ah Beng's 1200 JPY balance; run F13 before it, or reset the smoke db",
      );

      await page.locator(".page-actions").getByRole("button", { name: "Payment", exact: true }).click();
      // Anchored on the choice itself, not the picker's intro sentence: the
      // wording there is presentation and has already been rewritten once,
      // while "there is a 1200 JPY balance to pick" is what this flow needs.
      const settleDialog = dialog(page);
      const jpyChoice = settleDialog.getByRole("button", { name: /1200\s*JPY/ });
      await jpyChoice.waitFor({ timeout: 15_000 });
      await jpyChoice.click();
      await settleDialog.getByRole("button", { name: /^Record / }).click();

      // The follow-up question, on top of the now-settled balance.
      const cascade = dialog(page);
      await cascade
        .getByRole("heading", { name: "Also settle your groups with Ah Beng?" })
        .waitFor({ timeout: 20_000 });
      const cascadeText = (await cascade.innerText()).trim();
      const rows = await cascade.locator(".ledger-row").allInnerTexts();
      if (rows.length !== 2) {
        throw new Error(`expected the one-on-one and Tokyo rows, got ${JSON.stringify(rows)}`);
      }
      if (!rows.some((r) => r.includes("One-on-one")) || !rows.some((r) => r.includes("Weekend in Tokyo"))) {
        throw new Error(`cascade rows did not name both buckets: ${JSON.stringify(rows)}`);
      }
      for (const row of rows) {
        if (!/1200\s*JPY/.test(row)) throw new Error(`cascade row was not 1200 JPY: ${JSON.stringify(row)}`);
      }
      // The invariant that matters: USD does NOT net to zero between these two,
      // so no USD transfer may be invented for it.
      if (/USD/.test(cascadeText)) {
        throw new Error(`cascade offered a USD transfer for an unsettled currency: ${JSON.stringify(cascadeText)}`);
      }

      // Declining must write nothing beyond the payment already recorded.
      await cascade.getByRole("button", { name: "Leave them for now" }).click();
      await cascade.waitFor({ state: "hidden", timeout: 10_000 });
      const pending = page.locator(".settle-hints").filter({ hasText: "cancel each other out" });
      await pending.waitFor({ timeout: 20_000 });
      const tokyoRow = page.locator(".breakdown-list .list-item").filter({ hasText: "Weekend in Tokyo" });
      if (!(await tokyoRow.innerText()).includes("1200")) {
        throw new Error("declining still settled the Tokyo balance");
      }

      // …and the same offer is still reachable from the page afterwards.
      await pending.getByRole("button", { name: "Close them out" }).click();
      const closeOut = dialog(page);
      await closeOut.getByRole("heading", { name: "Settle all with Ah Beng" }).waitFor({ timeout: 10_000 });
      await closeOut.getByRole("button", { name: "Settle all" }).click();
      await closeOut.waitFor({ state: "hidden", timeout: 20_000 });
      await pending.waitFor({ state: "hidden", timeout: 20_000 });

      const balance = await friendBalanceCard(
        page,
        "149.25",
        "the USD balance vanished along with the yen",
      );
      if (/\b1200\b/.test(balance)) throw new Error(`JPY survived the settle-all: ${JSON.stringify(balance)}`);
      return "Settling 1200 JPY zeroed the friend total and prompted for the two cancelling buckets, USD untouched. Declining left Tokyo at 1200 JPY; the page still offered it, and confirming cleared the yen while leaving 149.25 USD owed.";
    },
  },
  {
    id: "F15",
    title: "Admin usage: counts only, search narrows, View carries as_of",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await page.goto(`${ctx.base}/app/admin?as_of=2026-08-18`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Usage" }).waitFor({ timeout: 15_000 });
      const rows = page.locator("main .admin-user-row");
      await rows.first().waitFor({ timeout: 15_000 });
      const before = await rows.count();
      if (before < 2) throw new Error(`expected several accounts, got ${before}`);

      // The panel is a counter, not a ledger browser: an amount here would be
      // an operator reading other people's money. The sidebar has balances, so
      // this can only be asserted inside main.
      const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      const money = main.match(/-?\d[\d,]*\.\d{2}\b/);
      if (money) throw new Error(`amount in the usage panel: ${JSON.stringify(money[0])}`);

      const search = page.getByLabel("Search users");
      await search.fill("Lee");
      await page.getByText("Lee Jin Jie").filter({ visible: true }).first().waitFor({ timeout: 10_000 });
      await page.waitForFunction(
        (n) => document.querySelectorAll("main .admin-user-row").length < n,
        before,
        { timeout: 10_000 },
      );
      const narrowed = await rows.count();

      await search.fill("nobodyhere");
      await page.getByText("No accounts match.").waitFor({ timeout: 10_000 });

      await search.fill("Lee");
      await clickNamed(page, { text: "View", near: "Lee Jin Jie" });
      await page.getByText("Expenses created").waitFor({ timeout: 15_000 });
      const url = page.url();
      if (!/\/admin\/users\/[^/?]+\?as_of=2026-08-18$/.test(url)) {
        throw new Error(`detail URL dropped the pinned window: ${url}`);
      }
      const counts = page.locator("main .admin-counts");
      const labels = await counts.locator(".eyebrow").allInnerTexts();
      // The labels are small-caps in CSS, so innerText comes back uppercased.
      const seen = labels.map((l) => l.trim().toLowerCase());
      for (const wanted of ["expenses created", "guest links", "ghost placeholders"]) {
        if (!seen.includes(wanted)) {
          throw new Error(`counts panel missing ${wanted}: ${JSON.stringify(labels)}`);
        }
      }
      const values = (await counts.locator("strong").allInnerTexts()).map((t) => t.trim());
      if (!values.every((v) => /^\d+$/.test(v))) {
        throw new Error(`counts must be plain integers, got ${JSON.stringify(values)}`);
      }

      // The crumb, not the admin tab of the same name: the tab is a plain link
      // to /admin, while the crumb is the way back to the window you pinned.
      await page.locator(".crumbs").getByRole("link", { name: "Usage" }).click();
      await page.getByLabel("Search users").waitFor({ timeout: 10_000 });
      if (!page.url().includes("as_of=2026-08-18")) {
        throw new Error(`crumb back to the list dropped as_of: ${page.url()}`);
      }
      return `${before} accounts listed with no amounts anywhere in main; "Lee" narrowed to ${narrowed}, "nobodyhere" to none. View kept as_of=2026-08-18, showed integer counts (${values.join("/")}), and the crumb came back with the window still pinned.`;
    },
  },
  {
    id: "F16",
    title: "Admin backups: unconfigured says so, and Back up now records nothing",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await settle(page);
      await page.goto(`${ctx.base}/app/admin`, { waitUntil: "domcontentloaded" });
      await clickNamed(page, "Backups");
      await page.getByRole("heading", { name: "Backups" }).waitFor({ timeout: 15_000 });
      await page.getByText("Total stored").waitFor({ timeout: 15_000 });

      // The smoke server sets no BACKUP_* variables, so this is the
      // unconfigured panel: it must say why rather than look idle.
      const status = (await page.locator(".admin-backup-config summary").innerText()).trim();
      if (!/unconfigured|disabled/i.test(status)) {
        throw new Error(`expected an unconfigured/disabled config pill, got ${JSON.stringify(status)}`);
      }
      await page.getByText("No backup runs recorded yet.").waitFor({ timeout: 10_000 });
      // The config block is a table too, but only the runs table has a header
      // row, so this counts runs rather than configuration.
      if ((await page.locator(".admin-backup-table thead").count()) > 0) {
        throw new Error("a runs table appeared on a server with no runs");
      }

      await page.getByRole("button", { name: "Back up now" }).click();
      await page.locator(".notice").waitFor({ timeout: 15_000 });
      const notice = (await page.locator(".notice").innerText()).trim();
      if (!/not configured/i.test(notice)) {
        throw new Error(`Back up now said ${JSON.stringify(notice)}`);
      }
      await page.getByText("No backup runs recorded yet.").waitFor({ timeout: 10_000 });

      await clickNamed(page, "Usage");
      await page.getByLabel("Search users").waitFor({ timeout: 10_000 });
      return `Backups tab reported "${status}", offered no runs, and "Back up now" answered "${notice}" without inventing a run. The tabs go back to Usage.`;
    },
  },
  {
    id: "F17",
    title: "A non-admin gets no admin tab, no admin page, and a 403 from the API",
    run: async (page, ctx) => {
      await signIn(page, "jj", ctx.base);
      await settle(page);
      const adminLinks = await page.getByRole("link", { name: "Admin" }).count();
      if (adminLinks > 0) throw new Error("the sidebar offered Admin to a non-admin");

      await page.goto(`${ctx.base}/app/admin`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Dashboard" }).waitFor({ timeout: 15_000 });
      if (/\/admin/.test(new URL(page.url()).pathname)) {
        throw new Error(`stayed on ${page.url()} instead of being sent to the dashboard`);
      }
      if ((await page.getByText("Total stored").count()) > 0) {
        throw new Error("backups panel rendered for a non-admin");
      }

      // The gate is cosmetic on its own; the route is what actually protects it.
      const statuses = await page.evaluate(async () =>
        Promise.all(
          ["/api/v1/admin/users", "/api/v1/admin/backups"].map((path) =>
            fetch(path, { credentials: "include" }).then((r) => r.status),
          ),
        ),
      );
      if (statuses.some((s) => s !== 403)) {
        throw new Error(`admin API answered ${statuses.join(", ")} for a non-admin, expected 403s`);
      }
      return `JJ saw no Admin link, /app/admin sent them to the dashboard, and /api/v1/admin/{users,backups} answered ${statuses.join(", ")}.`;
    },
  },
  {
    id: "F18",
    title: "Registering while holding a friend guest link lands on a named success screen",
    run: async (page, ctx) => {
      await stubExchangeRates(page);
      await claimFriendLinkAsNewAccount(page, guestUrl("friend", ctx.base), {
        email: "smoke-claim@example.com",
        name: "Smoke Claimant",
      });

      const openButton = page.getByRole("button", { name: "Open Test User" });
      await openButton.waitFor({ timeout: 10_000 });
      await openButton.click();

      await page.getByRole("heading", { name: "Test User", exact: true }).waitFor({ timeout: 15_000 });
      const url = page.url();
      if (!/\/friends\/[^/]+$/.test(url.replace(ctx.base, ""))) {
        throw new Error(`claim success button landed on ${url}, expected /friends/:id`);
      }

      return "Registering from a friend link's \"Make it mine\" banner reached a named \"Link claimed\" screen with an \"Open Test User\" button, which opened the right friend page.";
    },
  },
];

export async function runFlows(opts: {
  base: string;
  outDir: string;
  only?: string[];
}): Promise<FlowResult[]> {
  const shotDir = join(opts.outDir, "flows");
  mkdirSync(shotDir, { recursive: true });
  const selected = opts.only ? FLOWS.filter((f) => opts.only!.includes(f.id)) : FLOWS;
  if (selected.length === 0) throw new Error(`no flows matched --only ${opts.only?.join(",")}`);

  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    throw new Error(chromiumHint(err));
  }

  const results: FlowResult[] = [];
  console.log(`Running ${selected.length} flow(s) against ${opts.base}`);

  try {
    for (const flow of selected) {
      const viewport = VIEWPORTS[flow.viewport ?? "desktop"];
      const context: BrowserContext = await newContext(browser, viewport, CAPTURE_PARAMS);
      const page = await context.newPage();
      // Every flow, not just the converting ones: a live rate reaching any of
      // them is a network dependency in a suite whose whole point is that a
      // red run means the app changed.
      await stubExchangeRates(page);
      const ctx: FlowCtx = { browser, base: opts.base, shotDir };
      process.stdout.write(`  ${flow.id}  ${flow.title} … `);
      try {
        const evidence = await flow.run(page, ctx);
        console.log("ok");
        results.push({ id: flow.id, title: flow.title, verdict: "pass", evidence });
      } catch (err) {
        const observed = chromiumHint(err).split("\n")[0]!;
        console.log("FAIL");
        console.log(`      ${observed}`);
        let shot: string | undefined;
        try {
          shot = await screenshot(page, ctx, flow.id);
        } catch {
          // page may already be closed
        }
        results.push({
          id: flow.id,
          title: flow.title,
          verdict: "fail",
          evidence: "Flow threw before its assertion completed.",
          observed,
          screenshot: shot,
        });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(join(opts.outDir, "flows.json"), `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((r) => r.verdict !== "pass").length;
  console.log(`\n${results.length - failed}/${results.length} flows passed.`);
  return results;
}

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("smoke-flows.ts");
if (isCli) {
  const outDir = arg("out");
  if (!outDir) {
    console.error("usage: yarn smoke:flows -- --out <run-dir> [--base http://localhost:5644] [--only F1,F7]");
    process.exit(1);
  }
  try {
    const results = await runFlows({
      base: (arg("base", DEFAULT_BASE) ?? DEFAULT_BASE).replace(/\/$/, ""),
      outDir,
      only: arg("only")
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    process.exit(results.some((r) => r.verdict !== "pass") ? 2 : 0);
  } catch (err) {
    console.error(chromiumHint(err));
    process.exit(1);
  }
}
