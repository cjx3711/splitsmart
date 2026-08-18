/**
 * Capture the pixel + DOM snapshots listed in scripts/smoke-screens.ts.
 *
 * The same script records a baseline and captures a run — only the output
 * directory differs. Two captures of an unchanged app must be byte-identical,
 * so everything that could vary is pinned here or neutralised by STABILISE_CSS,
 * and the settings that were actually used are written to manifest.json so
 * `smoke:compare` can tell "the app changed" apart from "the two captures were
 * not taken the same way".
 *
 * Usage:
 *   yarn smoke:capture -- --out <png-dir> [--dom <dir>] [--only id,id] [--base http://localhost:5644]
 *   yarn smoke:baseline                      # records into smoke/baselines/png and .../dom
 *
 * Requires the smoke stack (`yarn smoke:server`) to be up and freshly reset.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  SCREENS,
  VIEWPORTS,
  CAPTURE_PARAMS,
  STABILISE_CSS,
  authKey,
  type Screen,
} from "./smoke-screens.ts";
import {
  BASELINE_PNG,
  BASELINE_DOM,
  DEFAULT_BASE,
  arg,
  chromiumHint,
  clickNamed,
  dumpDom,
  guestUrl,
  newContext,
  settle,
  signIn,
} from "./smoke-lib.ts";

const require = createRequire(import.meta.url);
const playwrightVersion = require("playwright/package.json").version as string;

export type CaptureOpts = {
  pngDir: string;
  domDir: string;
  base: string;
  only?: string[];
};

function parseCli(): CaptureOpts {
  const pngDir = arg("out", BASELINE_PNG)!;
  const defaultDom = pngDir === BASELINE_PNG ? BASELINE_DOM : join(dirname(pngDir), "dom");
  return {
    pngDir,
    domDir: arg("dom", defaultDom)!,
    base: (arg("base", DEFAULT_BASE) ?? DEFAULT_BASE).replace(/\/$/, ""),
    only: arg("only")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function screensFor(only?: string[]): Screen[] {
  const screens = only ? SCREENS.filter((s) => only.includes(s.id) || only.includes(s.id.replace(/-mobile$/, ""))) : SCREENS;
  if (screens.length === 0) {
    throw new Error(`no screens matched --only ${only?.join(",")}`);
  }
  return screens;
}

function wipeStale(dir: string, ext: string, screens: Screen[]): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (file.endsWith(ext) && !screens.some((s) => `${s.id}${ext}` === file)) {
      rmSync(join(dir, file));
      console.log(`  removed stale ${file}`);
    }
  }
}

async function preparePage(page: Page, screen: Screen, base: string): Promise<void> {
  if (screen.auth.kind === "guest") {
    await page.goto(guestUrl(screen.auth.link, base), { waitUntil: "domcontentloaded" });
  } else {
    await page.goto(`${base}${screen.path}`, { waitUntil: "domcontentloaded" });
  }

  for (const name of screen.click ?? []) {
    await clickNamed(page, name);
  }

  await page.getByText(screen.waitForText, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 15_000 });
  await page.addStyleTag({
    content: STABILISE_CSS + (screen.hide ?? []).map((s) => `${s}{visibility:hidden !important;}`).join(""),
  });
  await settle(page);
}

async function shoot(page: Page, screen: Screen, opts: CaptureOpts, consoleErrors: string[]): Promise<void> {
  await page.screenshot({
    path: join(opts.pngDir, `${screen.id}.png`),
    fullPage: screen.fullPage ?? false,
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  writeFileSync(join(opts.domDir, `${screen.id}.txt`), await dumpDom(page));
  const note = consoleErrors.length > 0 ? `  (${consoleErrors.length} console error(s))` : "";
  console.log(`  captured ${screen.id}${note}`);
  if (consoleErrors.length > 0) {
    for (const e of consoleErrors.slice(0, 3)) console.log(`      ${e}`);
  }
}

function attachConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

/**
 * Guest storage (the link secret, who they picked) lives per origin in the
 * context. Reusing a context would leak a previous pick into the next screen.
 */
async function captureGuest(browser: Browser, screen: Screen, opts: CaptureOpts): Promise<void> {
  const context = await newContext(browser, VIEWPORTS[screen.viewport], CAPTURE_PARAMS);
  const page = await context.newPage();
  const errors = attachConsole(page);
  try {
    await preparePage(page, screen, opts.base);
    await shoot(page, screen, opts, errors);
  } finally {
    await context.close();
  }
}

async function captureGroup(
  browser: Browser,
  screens: Screen[],
  opts: CaptureOpts,
): Promise<string[]> {
  const failures: string[] = [];
  const first = screens[0]!;
  if (first.auth.kind === "guest") {
    for (const screen of screens) {
      try {
        await captureGuest(browser, screen, opts);
      } catch (err) {
        failures.push(`${screen.id}: ${chromiumHint(err).split("\n")[0]}`);
        console.log(`  FAILED  ${screen.id}`);
      }
    }
    return failures;
  }

  const context = await newContext(browser, VIEWPORTS[first.viewport], CAPTURE_PARAMS);
  const page = await context.newPage();
  const errors = attachConsole(page);
  try {
    if (first.auth.kind === "user") {
      await signIn(page, first.auth.account ?? "user", opts.base);
      await settle(page);
    }
    for (const screen of screens) {
      errors.length = 0;
      try {
        await preparePage(page, screen, opts.base);
        await shoot(page, screen, opts, errors);
      } catch (err) {
        failures.push(`${screen.id}: ${chromiumHint(err).split("\n")[0]}`);
        console.log(`  FAILED  ${screen.id}`);
      }
    }
  } finally {
    await context.close();
  }
  return failures;
}

export async function runCapture(opts: CaptureOpts): Promise<{ captured: number; failures: string[] }> {
  const screens = screensFor(opts.only);
  mkdirSync(opts.pngDir, { recursive: true });
  mkdirSync(opts.domDir, { recursive: true });

  if (!opts.only) {
    wipeStale(opts.pngDir, ".png", screens);
    wipeStale(opts.domDir, ".txt", screens);
  }

  console.log(`Capturing ${screens.length} screen(s) from ${opts.base}`);
  console.log(`  png  ${opts.pngDir}`);
  console.log(`  dom  ${opts.domDir}`);

  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    throw new Error(chromiumHint(err));
  }

  const failures: string[] = [];
  const groups = new Map<string, Screen[]>();
  for (const screen of screens) {
    const key = `${authKey(screen)}|${screen.viewport}`;
    const list = groups.get(key) ?? [];
    list.push(screen);
    groups.set(key, list);
  }

  try {
    for (const group of groups.values()) {
      failures.push(...(await captureGroup(browser, group, opts)));
    }
  } finally {
    await browser.close();
  }

  writeFileSync(
    join(opts.pngDir, "manifest.json"),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        base: opts.base,
        playwrightVersion,
        params: CAPTURE_PARAMS,
        viewports: VIEWPORTS,
        screens: screens.map((s) => ({
          id: s.id,
          viewport: s.viewport,
          path: s.path,
          click: (s.click ?? []).map((c) => (typeof c === "string" ? c : `${c.text}~${c.near}`)),
          auth: authKey(s),
        })),
      },
      null,
      2,
    )}\n`,
  );

  if (failures.length > 0) {
    console.error(`\n${failures.length} screen(s) could not be captured:`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("A screen that cannot be reached is a finding. Report it; do not fix the app.");
  } else {
    console.log(`\n${screens.length} screen(s) captured.`);
  }
  return { captured: screens.length - failures.length, failures };
}

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("smoke-capture.ts");
if (isCli) {
  const opts = parseCli();
  try {
    const result = await runCapture(opts);
    if (result.failures.length > 0) process.exit(2);
  } catch (err) {
    console.error(chromiumHint(err));
    process.exit(1);
  }
}
