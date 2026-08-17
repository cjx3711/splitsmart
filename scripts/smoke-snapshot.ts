/**
 * Normalise a captured page and compare it against its committed baseline.
 *
 * The agent captures a page (accessibility tree or visible text), writes it
 * raw, and hands the file to this script. Normalisation and comparison happen
 * HERE, not in the model: a snapshot is only worth keeping if the same page
 * produces byte-identical output twice, and an LLM asked to "ignore the ids"
 * will do it slightly differently every run.
 *
 * Usage:
 *   yarn smoke:snapshot -- <run-dir> <test-id> <step> <raw-file>
 *
 * Exit codes: 0 = MATCH or RECORDED, 2 = DIFF, 1 = usage/IO error.
 * DIFF is a report, not a crash: the caller records it and moves on.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const baselineDir = join(root, "smoke", "baselines");

const [runDir, testId, step, rawFile] = process.argv.slice(2);
if (!runDir || !testId || !step || !rawFile) {
  console.error("usage: yarn smoke:snapshot -- <run-dir> <test-id> <step> <raw-file>");
  process.exit(1);
}

/**
 * What gets erased, and why.
 *
 * Everything here is a value that changes between two runs of a suite that
 * passed both times. ULIDs are minted per seed; the demo seed dates relative to
 * today on purpose; read_page renumbers its refs as the tree changes; a guest
 * link secret is fresh every mint. Amounts, names, counts and labels are left
 * alone — those are the things a regression actually shows up in.
 */
const RULES: [RegExp, string][] = [
  [/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<ULID>"],
  [/\blink_[A-Za-z0-9_-]{16,}\b/g, "<LINK_SECRET>"],
  [/\/guest\/l\/[A-Za-z0-9_-]{16,}/g, "/guest/l/<LINK_SECRET>"],
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
 * The one value that changes without anything in the app changing.
 *
 * The dashboard's `≈ overall` figure comes from live Frankfurter rates fetched
 * in the browser (rule 2: display-only, never persisted), so it moves whenever
 * the market does. Left alone it would diff every single run and train whoever
 * reads these reports to ignore diffs — which is the only way this scaffolding
 * can actually fail. The amount renders as the node right after the `≈` label,
 * so blank that one and leave every other amount in the tree intact.
 */
function blankFxEstimate(lines: string[]): string[] {
  return lines.map((line, i) =>
    lines[i - 1]?.includes("≈") ? line.replace(/-?[\d,]+(\.\d+)?/, "<FX_ESTIMATE>") : line,
  );
}

function normalise(input: string): string {
  let out = input;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return `${blankFxEstimate(out.split("\n"))
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

const slug = `${testId}__${step}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
const current = join(runDir, "snapshots", `${slug}.txt`);
const baseline = join(baselineDir, `${slug}.txt`);

let raw: string;
try {
  raw = readFileSync(rawFile, "utf8");
} catch (err) {
  console.error(`cannot read ${rawFile}: ${(err as Error).message}`);
  process.exit(1);
}

const normalised = normalise(raw);
mkdirSync(join(runDir, "snapshots"), { recursive: true });
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
