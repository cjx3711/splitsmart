/**
 * Normalise a captured page dump and compare it against a committed baseline.
 *
 * Kept for ad-hoc dumps (paste a tree, get a diff). The suite itself captures
 * and compares through `yarn smoke` — see scripts/smoke-capture.ts.
 *
 * Usage:
 *   yarn smoke:snapshot -- <run-dir> <test-id> <step> <raw-file>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, normalise } from "./smoke-lib.ts";

const baselineDir = join(ROOT, "smoke", "baselines", "dom");

const [runDir, testId, step, rawFile] = process.argv.slice(2);
if (!runDir || !testId || !step || !rawFile) {
  console.error("usage: yarn smoke:snapshot -- <run-dir> <test-id> <step> <raw-file>");
  process.exit(1);
}

const slug = `${testId}__${step}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
const current = join(runDir, "dom", `${slug}.txt`);
const baseline = join(baselineDir, `${slug}.txt`);

let raw: string;
try {
  raw = readFileSync(rawFile, "utf8");
} catch (err) {
  console.error(`cannot read ${rawFile}: ${(err as Error).message}`);
  process.exit(1);
}

const normalised = normalise(raw);
mkdirSync(join(runDir, "dom"), { recursive: true });
writeFileSync(current, normalised);

if (!existsSync(baseline)) {
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(baseline, normalised);
  console.log(`RECORDED ${slug}`);
  console.log(`  new baseline written to ${baseline}`);
  console.log("  a first recording proves nothing; report it as recorded, not as a pass");
  process.exit(0);
}

if (readFileSync(baseline, "utf8") === normalised) {
  console.log(`MATCH ${slug}`);
  process.exit(0);
}

const diff = spawnSync("diff", ["-u", "--label", "baseline", baseline, "--label", "current", current], {
  encoding: "utf8",
});
console.log(`DIFF ${slug}`);
console.log(diff.stdout || diff.stderr || "(diff unavailable)");
console.log("A diff is a finding to report. Do not edit the baseline to make it go away.");
process.exit(2);
