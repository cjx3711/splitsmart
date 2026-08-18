/**
 * Compare a run's captures against the committed baselines.
 *
 * Two artefacts per screen: a PNG (layout) and a normalised DOM/aria dump
 * (labels, amounts, headings). The machine decides *whether* something moved;
 * a model looking at the three images decides whether it matters.
 *
 * Usage:
 *   yarn smoke:compare -- --current <png-dir> [--dom <dir>]
 *                        [--baseline smoke/baselines/png] [--baseline-dom smoke/baselines/dom]
 *                        [--out <dir>] [--tolerance 0.0005]
 *
 * Exit codes: 0 = every screen matched, 2 = at least one differed or is
 * missing/new/mis-sized, 1 = bad input.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { BASELINE_PNG, BASELINE_DOM, arg } from "./smoke-lib.ts";

export type RowStatus = "match" | "diff" | "missing-baseline" | "missing-current" | "size-mismatch";

export type CompareRow = {
  id: string;
  kind: "png" | "dom";
  status: RowStatus;
  ratio?: number;
  pixels?: number;
  detail?: string;
};

export type CompareResult = {
  baselinePng: string;
  currentPng: string;
  baselineDom: string;
  currentDom: string;
  outDir: string;
  tolerance: number;
  comparedAt: string;
  paramWarnings: string[];
  rows: CompareRow[];
};

export type CompareOpts = {
  currentPng: string;
  currentDom?: string;
  baselinePng?: string;
  baselineDom?: string;
  outDir?: string;
  tolerance?: number;
};

function files(dir: string, ext: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : [];
}

function readManifest(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function unifiedDiff(baselinePath: string, currentPath: string): string {
  const diff = spawnSync("diff", ["-u", "--label", "baseline", baselinePath, "--label", "current", currentPath], {
    encoding: "utf8",
  });
  return (diff.stdout || diff.stderr || "(diff unavailable)").trimEnd();
}

export function runCompare(opts: CompareOpts): CompareResult {
  const currentPng = opts.currentPng;
  const currentDom = opts.currentDom ?? join(dirname(currentPng), "dom");
  const baselinePng = opts.baselinePng ?? BASELINE_PNG;
  const baselineDom = opts.baselineDom ?? BASELINE_DOM;
  const tolerance = opts.tolerance ?? 0.0005;
  const outDir = opts.outDir ?? join(dirname(currentPng), "diffs");

  if (!existsSync(currentPng)) {
    throw new Error(`current capture dir does not exist: ${currentPng}`);
  }

  const baselinePngs = files(baselinePng, ".png");
  if (baselinePngs.length === 0 && files(baselineDom, ".txt").length === 0) {
    throw new Error(
      `No baselines in ${baselinePng} or ${baselineDom}. Record them first:\n  yarn smoke -- --update`,
    );
  }

  const a = readManifest(baselinePng);
  const b = readManifest(currentPng);
  const paramWarnings: string[] = [];
  if (a && b) {
    for (const key of ["params", "viewports", "playwrightVersion"] as const) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        paramWarnings.push(
          `${key} differs between baseline and run:\n    baseline ${JSON.stringify(a[key])}\n    current  ${JSON.stringify(b[key])}`,
        );
      }
    }
  }

  const rows: CompareRow[] = [];
  mkdirSync(outDir, { recursive: true });

  const pngNames = new Set([...baselinePngs, ...files(currentPng, ".png")]);
  for (const file of pngNames) {
    const id = file.replace(/\.png$/, "");
    const basePath = join(baselinePng, file);
    const curPath = join(currentPng, file);

    if (!existsSync(curPath)) {
      rows.push({ id, kind: "png", status: "missing-current", detail: "baseline exists, run captured nothing" });
      continue;
    }
    if (!existsSync(basePath)) {
      rows.push({ id, kind: "png", status: "missing-baseline", detail: "new screen; record a baseline for it" });
      continue;
    }

    const before = PNG.sync.read(readFileSync(basePath));
    const after = PNG.sync.read(readFileSync(curPath));

    if (before.width !== after.width || before.height !== after.height) {
      rows.push({
        id,
        kind: "png",
        status: "size-mismatch",
        detail: `${before.width}x${before.height} → ${after.width}x${after.height}`,
      });
      continue;
    }

    const diff = new PNG({ width: before.width, height: before.height });
    const pixels = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
      threshold: 0.1,
      includeAA: false,
      alpha: 0.15,
      diffColor: [255, 0, 128],
    });
    const ratio = pixels / (before.width * before.height);

    if (ratio > tolerance) {
      writeFileSync(join(outDir, `${id}.diff.png`), PNG.sync.write(diff));
      rows.push({ id, kind: "png", status: "diff", ratio, pixels });
    } else {
      rows.push({ id, kind: "png", status: "match", ratio, pixels });
    }
  }

  const txtNames = new Set([...files(baselineDom, ".txt"), ...files(currentDom, ".txt")]);
  for (const file of txtNames) {
    const id = file.replace(/\.txt$/, "");
    const basePath = join(baselineDom, file);
    const curPath = join(currentDom, file);

    if (!existsSync(curPath)) {
      rows.push({ id, kind: "dom", status: "missing-current", detail: "baseline exists, run captured nothing" });
      continue;
    }
    if (!existsSync(basePath)) {
      rows.push({ id, kind: "dom", status: "missing-baseline", detail: "new screen; record a baseline for it" });
      continue;
    }

    const left = readFileSync(basePath, "utf8");
    const right = readFileSync(curPath, "utf8");
    if (left === right) {
      rows.push({ id, kind: "dom", status: "match" });
    } else {
      writeFileSync(join(outDir, `${id}.dom.diff`), `${unifiedDiff(basePath, curPath)}\n`);
      rows.push({ id, kind: "dom", status: "diff" });
    }
  }

  rows.sort((x, y) => x.id.localeCompare(y.id) || x.kind.localeCompare(y.kind));

  const result: CompareResult = {
    baselinePng,
    currentPng,
    baselineDom,
    currentDom,
    outDir,
    tolerance,
    comparedAt: new Date().toISOString(),
    paramWarnings,
    rows,
  };
  writeFileSync(join(outDir, "compare.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function printCompare(result: CompareResult): void {
  const pct = (r?: number) => (r === undefined ? "" : `${(r * 100).toFixed(3)}%`);
  const failed = result.rows.filter((r) => r.status !== "match");

  console.log(`png      ${result.currentPng}  vs  ${result.baselinePng}`);
  console.log(`dom      ${result.currentDom}  vs  ${result.baselineDom}`);
  console.log(`tolerance ${result.tolerance} (${(result.tolerance * 100).toFixed(3)}% of pixels)\n`);

  for (const r of result.rows) {
    const mark = r.status === "match" ? "ok  " : "FAIL";
    const extra =
      r.status === "diff" && r.kind === "png"
        ? `${pct(r.ratio)} (${r.pixels} px)`
        : (r.detail ?? r.status);
    console.log(`  ${mark}  ${r.id.padEnd(28)} ${r.kind.padEnd(4)} ${extra}`);
  }

  for (const w of result.paramWarnings) {
    console.log(`\n!! ${w}`);
    console.log("   A diff under different capture settings is not a regression. Re-record instead.");
  }

  const pngFail = failed.filter((r) => r.kind === "png").length;
  const domFail = failed.filter((r) => r.kind === "dom").length;
  const pngOk = result.rows.filter((r) => r.kind === "png" && r.status === "match").length;
  const pngN = result.rows.filter((r) => r.kind === "png").length;
  const domOk = result.rows.filter((r) => r.kind === "dom" && r.status === "match").length;
  const domN = result.rows.filter((r) => r.kind === "dom").length;

  console.log(
    `\n${pngOk}/${pngN} png matched, ${domOk}/${domN} dom matched.` +
      (failed.length > 0 ? ` Diffs in ${result.outDir}` : ""),
  );

  if (pngFail + domFail > 0) {
    console.log(
      "\nNext: open the baseline, the current capture and the diff for each FAIL and say what moved.\n" +
        "Do not re-record the baseline to clear a failure. If this machine's fonts differ from\n" +
        "the committed PNGs, re-record with: yarn smoke -- --update",
    );
  }
}

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("smoke-compare.ts");
if (isCli) {
  const current = arg("current");
  if (!current) {
    console.error(
      "usage: yarn smoke:compare -- --current <png-dir> [--dom <dir>] [--out <dir>] [--tolerance 0.0005]",
    );
    process.exit(1);
  }
  try {
    const result = runCompare({
      currentPng: current,
      currentDom: arg("dom"),
      baselinePng: arg("baseline"),
      baselineDom: arg("baseline-dom"),
      outDir: arg("out"),
      tolerance: arg("tolerance") ? Number(arg("tolerance")) : undefined,
    });
    printCompare(result);
    process.exit(result.rows.some((r) => r.status !== "match") ? 2 : 0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
