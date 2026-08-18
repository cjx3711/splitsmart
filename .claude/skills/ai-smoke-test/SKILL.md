---
name: ai-smoke-test
description: Run the SplitSmart deterministic smoke suite (Playwright capture, flows, snapshot compare) against an isolated seeded database, then look at failures only. Reports only; never fixes what it finds. Use when asked to run the smoke tests, the AI E2E suite, /ai-smoke-test, or to check whether the app still works end to end.
---

# AI smoke tests

You are not the test runner. Playwright is. You start the suite, read the
report, and only open a browser (or a PNG) if something already failed.

`docs/AI_SMOKE_TESTS.md` is the spec of what the suite covers. `yarn smoke`
is the runner.

## The rule that outranks the rest

**You do not fix anything.**

Not the app, not the test, not the baseline. Not "while I'm here". A failing
smoke test is a finding; an agent that repairs the app mid-run and then reports
a green suite has destroyed the only thing the run was for.

For the whole run:

- No edits to `src/`, `web/`, `migrations/`, or `scripts/`.
- No edits to files under `smoke/baselines/` - a snapshot `diff` is a result to
  report, never something to silence. (The user re-records with
  `yarn smoke -- --update` on purpose, on their machine.)
- No edits to `docs/AI_SMOKE_TESTS.md` to make a step match what you observed.
- No `git` writes of any kind.

The only files the suite creates are inside `smoke/runs/` (gitignored) and,
when the user asked to re-record, `smoke/baselines/`.

If a failure blocks the rest of the suite, the runner keeps going with whatever
is still reachable. At the end, if the fix looks small and you are tempted, put
it in the report as a suggestion. Then stop. The user decides.

## Arguments

No extra argument runs the whole suite (`yarn smoke`).

Pass-through:

- `update` / `--update` - re-record PNG + DOM baselines on this machine, then
  still run flows and `smoke:check`.
- a flow id (`F3`) or screen id (`group-tokyo`) - only if the user asked for a
  subset; otherwise run everything.
- `guest` / `mobile` - still run the whole suite; those words are coverage
  labels, not a reason to skip Playwright.

## Procedure

### 1. Run the suite

```bash
yarn smoke
```

That is: reset `data/smoke.db`, start (or reuse) the smoke server on 5644/5645,
capture every screen at desktop and mobile, run the click-through flows,
pixel- and DOM-compare against `smoke/baselines/`, then `yarn smoke:check`.

It prints the run directory (`smoke/runs/<stamp>/`) and the path to `report.md`.
Read `report.md`. Do not drive the browser yourself while this is running.

If Chromium is missing, it will say so. Run `yarn playwright install chromium`
once, then retry `yarn smoke`. Do not install a system Chrome to work around it.

If the server does not come up, stop. Report a run that could not start; do not
fall back to the dev stack on 5444 - that one has the user's real data.

`--update` (only when the user asked to re-record baselines):

```bash
yarn smoke -- --update
```

Say in the report that the baselines are new and the user should eyeball
`smoke/baselines/` before committing. `RECORDED` is not a pass.

### 2. If the report is clean

Give the user the totals and the path to `report.md`. Stop. Do not open
screenshots of passing pages. Do not narrate every flow.

### 3. If anything failed

For each finding, in this order:

1. **Read the artefacts on disk.** PNG failures: `smoke/baselines/png/<id>.png`,
   the run's `screens/<id>.png`, and `diffs/<id>.diff.png`. DOM failures:
   `diffs/<id>.dom.diff`. Flow failures: `flows/<id>.png` if present.
2. **Look at those images** (or the text diff) and say what moved, in words.
   Vague self-assessment ("the page looks wrong") is not a result. Name the
   amount, the label, the overflow, the missing heading.
3. **Only then** drive a real browser, and only if the pictures are not enough
   to describe the failure. Reproduce that one screen or flow. Do not re-run
   the whole suite by hand.

Then, in chat:

- the totals and the path to `report.md`;
- each failure in a sentence or two - expected vs actual;
- whether a PNG diff looks like a real UI change or like font / antialiasing
  on this machine (in which case tell the user `yarn smoke -- --update` is the
  re-record path, and do not do it yourself);
- a suggested fix per failure, clearly marked as a suggestion and not applied.

Leave the smoke server running if `yarn smoke` already stopped it; say whether
it is up. They will usually want to look at the failure themselves.

## Judging a diff (only when the runner already failed)

- **Be specific about money.** `3400 JPY` and `34.00 JPY` are the same pixels'
  worth of effort to check and only one of them is correct. Prefer the DOM diff
  for this; pixelmatch can miss a decimal point.
- **A balance needs a direction.** "You are owed" vs "you owe" / "gets back"
  vs "owes" is the entire meaning.
- **Two currencies never become one number.** If anything sums across
  currencies without labelling itself an estimate, that is a fail.
- **Don't grade on a curve.** A suite that reports three real failures is
  worth more than one that reports none.

## Things that will trip you up

- **Baselines are machine-local.** System fonts (`ui-sans-serif`) mean a PNG
  recorded on another Mac or on Linux will diff here. That is expected. The
  user re-records on this device with `--update`. A DOM diff of amounts or
  labels is still a real finding.
- **The seed dates everything relative to a pinned `SEED_TODAY`**, and leaves
  the recurring series behind on purpose. A visible catch-up note is expected.
- **The demo makes 10 groups and the sidebar shows 5.** Not a missing-data bug.
- **Guest link secrets change on every `smoke:reset`.** The runner reads them
  from `data/smoke.db`; you do not need to copy URLs out of the reset log.
- **`data/smoke.db` is disposable; `data/splitsmart.db` is not.** If you ever
  find yourself about to run `yarn db:reset` (no `smoke:` prefix), stop.
