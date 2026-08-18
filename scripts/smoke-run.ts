/**
 * Start a new AI smoke-test run.
 *
 * Creates smoke/runs/<stamp>/ with the directories and the results.json
 * skeleton the agent fills in, and prints the path it created. Everything the
 * run produces lives under that one directory so a run can be read, diffed, or
 * thrown away as a unit.
 *
 * Usage:
 *   yarn smoke:new            # stamped run directory
 *   yarn smoke:new -- <name>  # named run directory (overwrites its results.json)
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runsDir = join(root, "smoke", "runs");

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const name = process.argv[2] ?? stamp();
const runDir = join(runsDir, name);

mkdirSync(join(runDir, "snapshots"), { recursive: true });
mkdirSync(join(runDir, "raw"), { recursive: true });
mkdirSync(join(runDir, "screens"), { recursive: true });
mkdirSync(join(runDir, "diffs"), { recursive: true });

const results = {
  run: name,
  startedAt: new Date().toISOString(),
  suite: "docs/AI_SMOKE_TESTS.md",
  tests: [] as unknown[],
};
writeFileSync(join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

// A stable path for "the run I am working on right now", so a follow-up
// session can find it without knowing the stamp.
const latest = join(runsDir, "latest");
if (existsSync(latest)) rmSync(latest, { recursive: true, force: true });
try {
  symlinkSync(name, latest, "dir");
} catch {
  // Symlinks are optional scaffolding; a filesystem that refuses them is fine.
}

console.log(runDir);
console.log(`  screens    ${join(runDir, "screens")}`);
console.log(`  diffs      ${join(runDir, "diffs")}`);
console.log(`  snapshots  ${join(runDir, "snapshots")}`);
console.log(`  raw        ${join(runDir, "raw")}`);
console.log(`  results    ${join(runDir, "results.json")}`);
