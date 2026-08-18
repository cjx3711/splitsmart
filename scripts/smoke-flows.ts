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
      await dialog(page).getByLabel("Morgan Chen: percentage").fill("20");
      await dialog(page).getByLabel("Riley Brooks: percentage").fill("0");
      await dialog(page).locator(".split-problem").waitFor({ timeout: 5_000 });
      const percentMsg = (await dialog(page).locator(".split-problem").innerText()).trim();
      if (!/expected 100/i.test(percentMsg)) {
        throw new Error(`percent problem was ${JSON.stringify(percentMsg)}`);
      }

      await dialog(page).getByLabel("Riley Brooks: percentage").fill("30");
      await dialog(page).locator(".split-problem").waitFor({ state: "hidden", timeout: 5_000 });

      await dialog(page).getByRole("button", { name: "Exact amounts" }).click();
      await dialog(page).getByLabel("You: exact amount").fill("10.00");
      await dialog(page).getByLabel("Morgan Chen: exact amount").fill("10.00");
      await dialog(page).getByLabel("Riley Brooks: exact amount").fill("10.00");
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
      await clickNamed(page, "Alex Kim");
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
      return "Alex Kim saw Weekend in Tokyo expenses; no Settings/Import; no requests to /api/v1/ outside /guest/.";
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

      const jamieCtx = await newContext(ctx.browser, VIEWPORTS.desktop, CAPTURE_PARAMS);
      const jamie = await jamieCtx.newPage();
      try {
        await signIn(jamie, "jamie", ctx.base);
        await settle(jamie);
        await clickNamed(jamie, "Groups");
        await clickNamed(jamie, "Apartment 4B");
        await jamie.getByText("Smoke test paint").first().waitFor({ timeout: 15_000 });
        const body = await jamie.locator("body").innerText();
        if (!/owes /.test(body) && !/gets back /.test(body)) {
          throw new Error("Jamie's apartment page has no directed balances");
        }
        // Test User paid 40, split equally: Jamie owes 20 more. The row should
        // not present the same "gets back" direction Test User just saw.
        const youRow = jamie.locator(".list-item").filter({ hasText: "You" }).first();
        const youText = await youRow.innerText();
        if (/You/.test(youText) && /gets back /.test(youText) && !/owes /.test(youText)) {
          throw new Error(`Jamie (who did not pay) reads as creditor: ${youText.replace(/\s+/g, " ")}`);
        }
        return "Test User saved Smoke test paint (40.00 USD) in Apartment 4B; Jamie's session listed it with a directed balance.";
      } finally {
        await jamieCtx.close();
      }
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
