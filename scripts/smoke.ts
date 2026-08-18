/**
 * One command for the deterministic smoke suite.
 *
 *   yarn smoke                 reset, serve, capture, flows, compare, check
 *   yarn smoke -- --update     same, but write captures into smoke/baselines/
 *   yarn smoke -- --no-reset   reuse the current data/smoke.db
 *   yarn smoke -- --keep-server
 *   yarn smoke -- --only capture|flows|compare
 *
 * The smoke stack is isolated (data/smoke.db, ports 5644/5645). This never
 * touches data/splitsmart.db. If the smoke server is already running it is
 * reused; if this process started it, it is stopped at the end unless
 * --keep-server.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runCapture } from "./smoke-capture.ts";
import { printCompare, runCompare, type CompareResult } from "./smoke-compare.ts";
import { runFlows, type FlowResult } from "./smoke-flows.ts";
import { writeReport, type SmokeReport } from "./smoke-report.ts";
import {
  ROOT,
  BASELINE_PNG,
  BASELINE_DOM,
  DEFAULT_BASE,
  flag,
  arg,
  chromiumHint,
} from "./smoke-lib.ts";

const BASE = (arg("base", DEFAULT_BASE) ?? DEFAULT_BASE).replace(/\/$/, "");
const UPDATE = flag("update");
const NO_RESET = flag("no-reset");
const KEEP_SERVER = flag("keep-server");
const ONLY = arg("only");

function yarn(args: string[], opts: { inherit?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("yarn", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : "pipe",
  });
  return {
    status: r.status ?? 1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${url}. Is yarn smoke:server running?`);
}

function startServer(): ChildProcess {
  const child = spawn("yarn", ["smoke:server"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  // Drain so the child cannot stall on a full pipe.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

function killPort(port: number): void {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  for (const pid of (r.stdout ?? "").trim().split(/\s+/).filter(Boolean)) {
    const n = Number(pid);
    if (Number.isInteger(n)) {
      try {
        process.kill(n, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

function stopServer(child: ChildProcess | null): void {
  if (child?.pid != null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  killPort(5644);
  killPort(5645);
  spawnSync("sleep", ["0.4"]);
}

function newRunDir(): string {
  const name = stamp();
  const runDir = join(ROOT, "smoke", "runs", name);
  mkdirSync(join(runDir, "screens"), { recursive: true });
  mkdirSync(join(runDir, "dom"), { recursive: true });
  mkdirSync(join(runDir, "diffs"), { recursive: true });
  mkdirSync(join(runDir, "flows"), { recursive: true });
  const latest = join(ROOT, "smoke", "runs", "latest");
  try {
    if (existsSync(latest)) rmSync(latest, { recursive: true, force: true });
    symlinkSync(name, latest, "dir");
  } catch {
    // optional
  }
  return runDir;
}

const phases = {
  capture: !ONLY || ONLY === "capture" || ONLY.includes("capture"),
  flows: !ONLY || ONLY === "flows" || ONLY.includes("flows"),
  compare: !ONLY || ONLY === "compare" || ONLY.includes("compare"),
  check: !ONLY,
};

if (ONLY === "compare") {
  phases.capture = false;
  phases.flows = false;
  phases.check = false;
}

let server: ChildProcess | null = null;
let startedServer = false;

try {
  if (!NO_RESET && ONLY !== "compare") {
    if (await isUp(BASE)) {
      console.error(
        `${BASE} is already serving. yarn smoke:reset would replace data/smoke.db while that process keeps the old file open.`,
      );
      console.error("Stop yarn smoke:server and re-run, or pass --no-reset to test against whatever it is serving.");
      process.exit(1);
    }
    console.log("→ yarn smoke:reset");
    const reset = yarn(["smoke:reset"], { inherit: true });
    if (reset.status !== 0) process.exit(reset.status);
  }

  if (!(await isUp(BASE))) {
    console.log("→ yarn smoke:server");
    server = startServer();
    startedServer = true;
    await waitFor(BASE);
    console.log(`  ${BASE} is up`);
  } else {
    console.log(`→ reusing server at ${BASE}`);
  }

  const runDir = newRunDir();
  console.log(`→ run ${runDir}`);

  let captureFailures: string[] = [];
  if (phases.capture) {
    const pngDir = UPDATE ? BASELINE_PNG : join(runDir, "screens");
    const domDir = UPDATE ? BASELINE_DOM : join(runDir, "dom");
    console.log(UPDATE ? "→ capturing baselines" : "→ capturing screens");
    const captured = await runCapture({ pngDir, domDir, base: BASE });
    captureFailures = captured.failures;
  }

  let flows: FlowResult[] = [];
  if (phases.flows) {
    console.log("→ flows");
    flows = await runFlows({ base: BASE, outDir: runDir });
  }

  let compare: CompareResult | null = null;
  let compareError: string | null = null;
  if (phases.compare && !UPDATE) {
    const currentPng = join(runDir, "screens");
    if (!existsSync(join(currentPng, "manifest.json")) && phases.capture === false) {
      compareError = `No capture in ${currentPng}. Run without --only compare, or pass a previous run.`;
    } else {
      console.log("→ compare");
      try {
        compare = runCompare({
          currentPng,
          currentDom: join(runDir, "dom"),
          outDir: join(runDir, "diffs"),
        });
        printCompare(compare);
      } catch (err) {
        compareError = err instanceof Error ? err.message : String(err);
        console.error(compareError);
      }
    }
  }

  let invariants: SmokeReport["invariants"] = { verdict: "skipped", output: "" };
  if (phases.check) {
    console.log("→ yarn smoke:check");
    const check = yarn(["smoke:check"]);
    const output = (check.stdout + check.stderr).trim();
    if (output) console.log(output);
    invariants = {
      verdict: check.status === 0 ? "pass" : "fail",
      output,
    };
  }

  const report: SmokeReport = {
    run: runDir,
    startedAt: new Date().toISOString(),
    base: BASE,
    updatedBaselines: UPDATE,
    captureFailures,
    compare,
    compareError,
    flows,
    invariants,
  };
  writeFileSync(join(runDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  const { path, exitCode } = writeReport(report);
  console.log(`\nreport  ${path}`);
  if (UPDATE) {
    console.log("Baselines rewritten. Look at smoke/baselines/ before committing.");
  }
  if (startedServer && KEEP_SERVER) {
    console.log(`Smoke server left running on ${BASE} (pid ${server?.pid}).`);
  }
  if (startedServer && server && !KEEP_SERVER) stopServer(server);
  process.exit(exitCode);
} catch (err) {
  console.error(chromiumHint(err));
  if (startedServer && server && !KEEP_SERVER) stopServer(server);
  process.exit(1);
}
