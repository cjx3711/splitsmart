/**
 * Render a smoke run's results.json into report.md.
 *
 * Counting lives here, not in the agent's head: a suite report whose totals
 * are arithmetic done in prose is a report you cannot trust.
 *
 * Usage:
 *   yarn smoke:report -- <run-dir>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompareResult } from "./smoke-compare.ts";
import type { FlowResult } from "./smoke-flows.ts";

export type SmokeReport = {
  run: string;
  startedAt: string;
  base: string;
  updatedBaselines: boolean;
  captureFailures: string[];
  compare: CompareResult | null;
  compareError: string | null;
  flows: FlowResult[];
  invariants: { verdict: "pass" | "fail" | "skipped"; output: string };
};

export function writeReport(report: SmokeReport): { path: string; exitCode: number } {
  const pngRows = report.compare?.rows.filter((r) => r.kind === "png") ?? [];
  const domRows = report.compare?.rows.filter((r) => r.kind === "dom") ?? [];
  const pngFail = pngRows.filter((r) => r.status !== "match");
  const domFail = domRows.filter((r) => r.status !== "match");
  const flowFail = report.flows.filter((r) => r.verdict !== "pass");
  const captureFail = report.captureFailures;
  const invariantsFail = report.invariants.verdict === "fail";

  const problems =
    captureFail.length +
    pngFail.length +
    domFail.length +
    flowFail.length +
    (invariantsFail ? 1 : 0) +
    (report.compareError ? 1 : 0);

  const lines: string[] = [];
  lines.push(`# Smoke run — ${report.run}`);
  lines.push("");
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Target: ${report.base}`);
  if (report.updatedBaselines) lines.push("- Baselines were rewritten (`--update`).");
  lines.push("");

  const pngN = pngRows.length;
  const pngOk = pngN - pngFail.length;
  const domN = domRows.length;
  const domOk = domN - domFail.length;
  const flowN = report.flows.length;
  const flowOk = flowN - flowFail.length;

  lines.push(
    `**${pngOk}/${pngN} png · ${domOk}/${domN} dom · ${flowOk}/${flowN} flows · invariants ${report.invariants.verdict}**` +
      (problems > 0 ? ` · ${problems} finding(s)` : " · clean"),
  );
  lines.push("");

  if (report.compareError) {
    lines.push("## Compare could not run");
    lines.push("");
    lines.push("```");
    lines.push(report.compareError);
    lines.push("```");
    lines.push("");
  }

  if (captureFail.length > 0) {
    lines.push("## Capture failures");
    lines.push("");
    for (const f of captureFail) lines.push(`- ${f}`);
    lines.push("");
  }

  const notable = [...pngFail, ...domFail];
  if (notable.length > 0) {
    lines.push("## Snapshot diffs");
    lines.push("");
    lines.push("| Screen | Kind | Status | Detail |");
    lines.push("|---|---|---|---|");
    for (const r of notable) {
      const extra =
        r.status === "diff" && r.kind === "png" && r.ratio !== undefined
          ? `${(r.ratio * 100).toFixed(3)}% (${r.pixels} px)`
          : (r.detail ?? r.status);
      lines.push(`| ${r.id} | ${r.kind} | ${r.status} | ${extra} |`);
    }
    lines.push("");
    if (report.compare) {
      lines.push(`Diff artefacts: \`${report.compare.outDir}\``);
      lines.push("");
      lines.push(
        "Open the baseline PNG, the current PNG and the `.diff.png` (or `.dom.diff`) and say what moved. " +
          "If this machine's fonts differ from the committed snapshots, re-record with `yarn smoke -- --update` — " +
          "do not edit a baseline to silence a real UI change.",
      );
      lines.push("");
    }
  }

  if (report.flows.length > 0) {
    lines.push("## Flows");
    lines.push("");
    lines.push("| | Id | Title |");
    lines.push("|---|---|---|");
    for (const f of report.flows) {
      const icon = f.verdict === "pass" ? "✅" : f.verdict === "blocked" ? "🚧" : "❌";
      lines.push(`| ${icon} | ${f.id} | ${f.title} |`);
    }
    lines.push("");
    for (const f of report.flows.filter((x) => x.verdict !== "pass")) {
      lines.push(`### ❌ ${f.id} — ${f.title}`);
      lines.push("");
      if (f.observed) lines.push(`- **Observed:** ${f.observed}`);
      lines.push(`- **Evidence:** ${f.evidence}`);
      if (f.screenshot) lines.push(`- **Screenshot:** \`${f.screenshot}\``);
      lines.push("");
    }
    for (const f of report.flows.filter((x) => x.verdict === "pass")) {
      lines.push(`- **${f.id}** ${f.title} — ${f.evidence}`);
    }
    lines.push("");
  }

  lines.push("## Invariants");
  lines.push("");
  if (report.invariants.verdict === "skipped") {
    lines.push("Not run.");
  } else if (report.invariants.verdict === "pass") {
    lines.push("`yarn smoke:check` reported no violations.");
  } else {
    lines.push("`yarn smoke:check` failed:");
    lines.push("");
    lines.push("```");
    lines.push(report.invariants.output || "(no output)");
    lines.push("```");
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "This run reports; it does not repair. Nothing above was fixed, and no baseline was " +
      "updated to make a diff disappear.",
  );
  lines.push("");

  const path = join(report.run, "report.md");
  writeFileSync(path, `${lines.join("\n")}`);
  const exitCode = problems > 0 ? 2 : 0;
  return { path, exitCode };
}

const isCli = process.argv[1]?.replace(/\\/g, "/").endsWith("smoke-report.ts");
if (isCli) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("usage: yarn smoke:report -- <run-dir>");
    process.exit(1);
  }
  const resultsPath = join(runDir, "results.json");
  let parsed: SmokeReport;
  try {
    parsed = JSON.parse(readFileSync(resultsPath, "utf8")) as SmokeReport;
  } catch (err) {
    console.error(`cannot read ${resultsPath}: ${(err as Error).message}`);
    process.exit(1);
  }
  parsed.run = parsed.run ?? runDir;
  const { path, exitCode } = writeReport(parsed);
  console.log(path);
  process.exit(exitCode);
}
