/**
 * Render a run's results.json into report.md, and count the verdicts.
 *
 * The counting is here rather than in the agent's head for the same reason the
 * diff is: a suite report whose totals are arithmetic done in prose is a report
 * you cannot trust. The agent records one object per test; this renders them.
 *
 * Usage:
 *   yarn smoke:report -- <run-dir>
 *
 * Exit codes: 0 = no failures, 2 = at least one fail or blocked, 1 = bad input.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERDICTS = ["pass", "fail", "blocked", "skipped"] as const;
const SNAPSHOTS = ["match", "diff", "recorded", "none"] as const;

type Verdict = (typeof VERDICTS)[number];
type SnapshotStatus = (typeof SNAPSHOTS)[number];

type TestResult = {
  id: string;
  title: string;
  verdict: Verdict;
  snapshot?: SnapshotStatus;
  /** What was looked at: the screenshot judgement, the console, the diff. */
  evidence: string;
  /** For a fail: what was expected vs what was on screen. */
  observed?: string;
  notes?: string;
};

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: yarn smoke:report -- <run-dir>");
  process.exit(1);
}

const resultsPath = join(runDir, "results.json");
let parsed: { run?: string; startedAt?: string; suite?: string; tests?: TestResult[] };
try {
  parsed = JSON.parse(readFileSync(resultsPath, "utf8"));
} catch (err) {
  console.error(`cannot read ${resultsPath}: ${(err as Error).message}`);
  process.exit(1);
}

const tests = parsed.tests ?? [];
if (tests.length === 0) {
  console.error(`${resultsPath} has no tests. Record each test as you finish it.`);
  process.exit(1);
}

const problems: string[] = [];
for (const [i, t] of tests.entries()) {
  const where = `tests[${i}]${t?.id ? ` (${t.id})` : ""}`;
  if (!t?.id) problems.push(`${where}: missing id`);
  if (!t?.title) problems.push(`${where}: missing title`);
  if (!VERDICTS.includes(t?.verdict)) {
    problems.push(`${where}: verdict must be one of ${VERDICTS.join(", ")}`);
  }
  if (t?.snapshot && !SNAPSHOTS.includes(t.snapshot)) {
    problems.push(`${where}: snapshot must be one of ${SNAPSHOTS.join(", ")}`);
  }
  if (!t?.evidence) problems.push(`${where}: missing evidence`);
  if (t?.verdict === "fail" && !t?.observed) {
    problems.push(`${where}: a fail must say what was observed`);
  }
}
if (problems.length > 0) {
  console.error("results.json is malformed:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

const count = (v: Verdict) => tests.filter((t) => t.verdict === v).length;
const totals = Object.fromEntries(VERDICTS.map((v) => [v, count(v)])) as Record<Verdict, number>;
const diffs = tests.filter((t) => t.snapshot === "diff");
const recorded = tests.filter((t) => t.snapshot === "recorded");

const icon: Record<Verdict, string> = {
  pass: "✅",
  fail: "❌",
  blocked: "🚧",
  skipped: "⏭️",
};

const lines: string[] = [];
lines.push(`# AI smoke test run — ${parsed.run ?? runDir}`);
lines.push("");
lines.push(`- Started: ${parsed.startedAt ?? "unknown"}`);
lines.push(`- Rendered: ${new Date().toISOString()}`);
lines.push(`- Suite: ${parsed.suite ?? "docs/AI_SMOKE_TESTS.md"}`);
lines.push("");
lines.push(
  `**${totals.pass} passed · ${totals.fail} failed · ${totals.blocked} blocked · ${totals.skipped} skipped** ` +
    `(${tests.length} tests, ${diffs.length} snapshot diffs, ${recorded.length} baselines recorded)`,
);
lines.push("");
lines.push("| | Test | Verdict | Snapshot |");
lines.push("|---|---|---|---|");
for (const t of tests) {
  lines.push(`| ${icon[t.verdict]} | ${t.id} — ${t.title} | ${t.verdict} | ${t.snapshot ?? "none"} |`);
}
lines.push("");

const notable = tests.filter((t) => t.verdict !== "pass" || t.snapshot === "diff");
if (notable.length > 0) {
  lines.push("## Findings");
  lines.push("");
  for (const t of notable) {
    lines.push(`### ${icon[t.verdict]} ${t.id} — ${t.title}`);
    lines.push("");
    lines.push(`- **Verdict:** ${t.verdict}${t.snapshot ? ` (snapshot: ${t.snapshot})` : ""}`);
    if (t.observed) lines.push(`- **Observed:** ${t.observed}`);
    lines.push(`- **Evidence:** ${t.evidence}`);
    if (t.notes) lines.push(`- **Notes:** ${t.notes}`);
    lines.push("");
  }
}

lines.push("## Passing");
lines.push("");
for (const t of tests.filter((x) => x.verdict === "pass")) {
  lines.push(`- **${t.id}** ${t.title} — ${t.evidence}`);
}
lines.push("");
lines.push("---");
lines.push("");
lines.push(
  "This run reports; it does not repair. Nothing above was fixed, and no baseline was " +
    "updated to make a diff disappear.",
);
lines.push("");

const reportPath = join(runDir, "report.md");
writeFileSync(reportPath, `${lines.join("\n")}`);

console.log(reportPath);
console.log(
  `${totals.pass} passed, ${totals.fail} failed, ${totals.blocked} blocked, ${totals.skipped} skipped ` +
    `(${diffs.length} snapshot diffs, ${recorded.length} recorded)`,
);
process.exit(totals.fail + totals.blocked > 0 ? 2 : 0);
