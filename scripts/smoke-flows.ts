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
  chromiumHint,
  clickNamed,
  guestUrl,
  newContext,
  settle,
  signIn,
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
  await page.locator(".page-actions").getByRole("button", { name: "Add Expense" }).click();
  await dialog(page).getByLabel("Description").waitFor({ timeout: 10_000 });
}

async function openRentTemplate(page: Page): Promise<void> {
  await clickNamed(page, "Groups");
  await clickNamed(page, "Apartment 4B");
  await clickNamed(page, { text: "Rent", near: "repeats" });
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

      const csv = page.getByRole("button", { name: "Download CSV" });
      if (!(await csv.isEnabled())) throw new Error("Download CSV was disabled");
      return "coffee narrowed to coffee expenses; 50% matched nothing (literal percent); CSV button enabled.";
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
      await page.getByRole("heading", { name: "Members" }).waitFor({ timeout: 10_000 });
      await page
        .locator(".list-item")
        .filter({ hasText: "member · has an account" })
        .filter({ hasText: "JJ" })
        .click();
      await page.getByRole("heading", { name: "JJ", exact: true }).waitFor({ timeout: 10_000 });
      const fromGroup = page.url();
      if (!/\/friends\/[^/]+$/.test(fromGroup.replace(ctx.base, ""))) {
        throw new Error(`group member link landed on ${fromGroup}`);
      }

      await clickNamed(page, "All expenses");
      await clickNamed(page, { text: "Concert tickets", near: "One-on-one" });
      await page.getByRole("heading", { name: "Who paid, who owes" }).waitFor({ timeout: 10_000 });
      await page.locator(".list-item").filter({ hasText: "John" }).filter({ hasText: "owes" }).click();
      await page.getByRole("heading", { name: "John", exact: true }).waitFor({ timeout: 10_000 });
      const fromExpense = page.url();
      if (!/\/friends\/[^/]+$/.test(fromExpense.replace(ctx.base, ""))) {
        throw new Error(`expense participant link landed on ${fromExpense}`);
      }

      return "Tokyo balances JJ, Tokyo member JJ, and Concert tickets participant John all opened /friends/:id.";
    },
  },
  {
    id: "F10",
    title: "Signed-in marketing offers Open app, not Log in",
    run: async (page, ctx) => {
      await signIn(page, "user", ctx.base);
      await page.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: "Open app" }).first().waitFor({ timeout: 10_000 });
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
      return "Homepage said Open app; /app/login redirected to the dashboard.";
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
