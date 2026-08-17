---
name: ai-smoke-test
description: Run the SplitSmart AI end-to-end smoke suite in docs/AI_SMOKE_TESTS.md — drive the app in a browser against an isolated seeded database, judge each screen by looking at it, snapshot the pages, and write a report. Reports only; never fixes what it finds. Use when asked to run the smoke tests, the AI E2E suite, /ai-smoke-test, or to check whether the app still works end to end.
---

# AI smoke tests

You are the test runner. You drive a real browser against a real seeded app,
decide by looking whether each screen is right, and write down what you saw.

This skill is agent-agnostic: it names **jobs** (navigate, click, screenshot,
dump the page, read console/network), not a vendor's tool names. Use whatever
browser tools you have. If you cannot do a job a test requires, mark that test
`blocked` and say which job was missing — do not invent a Playwright suite or
fall back to guessing from HTML.

## The rule that outranks the rest

**You do not fix anything.**

Not the app, not the test, not the baseline. Not "while I'm here". Not even a
one-line obvious typo in a component you just watched break. A failing smoke
test is a finding; an agent that repairs the app mid-run and then reports a
green suite has destroyed the only thing the run was for.

This means, concretely, for the whole run:

- No edits to `src/`, `web/`, `migrations/`, or `scripts/`.
- No edits to files under `smoke/baselines/` — a snapshot `DIFF` is a result to
  report, never something to silence.
- No edits to `docs/AI_SMOKE_TESTS.md` to make a step match what you observed.
- No `git` writes of any kind.

The only files you create are inside the run directory (and new baselines, which
`smoke:snapshot` writes for you the first time a snapshot is taken).

If a failure blocks the rest of the suite, mark the blocked tests `blocked`, say
what blocked them, and keep going with whatever is still reachable. At the end,
if the fix looks small and you are tempted, put it in the report as a
suggestion. Then stop. The user decides.

## Arguments

No extra argument runs the whole suite. An argument selects a subset: test ids
(`S3`, `S1-S4`, `S3,S7`) or a word to match against test titles (`guest`,
`mobile`). Note in the report which subset ran.

## Procedure

### 1. Set the environment up

The suite runs against its own database and its own ports; nothing here touches
the user's dev database or dev server.

```bash
yarn smoke:reset
```

Read its output and **keep the two guest link URLs it prints** — they are minted
fresh each reset and S10 needs one. Then:

```bash
yarn smoke:new
```

which prints the run directory (`smoke/runs/<stamp>/`). Everything you write
goes there.

Start the smoke server as a **long-running** process and leave it running:

```bash
yarn smoke:server
```

That is 5644 (web) / 5645 (API). How you keep it in the background is up to
your environment (a background shell, a launch config named `smoke` if you
have one). Confirm http://localhost:5644 loads before starting the suite.

If the server does not come up, stop. Report a run that could not start; do not
debug the server and do not fall back to the dev stack on 5444 — that one has
the user's real data in it and the suite writes expenses.

If you have no browser you can drive, stop the same way. A text-only agent
cannot run this suite.

### 2. Read the suite

`docs/AI_SMOKE_TESTS.md`. Each test gives you steps, a snapshot to take, and a
list of "look for" questions. Run the tests in order; later ones depend on
earlier ones having happened (S12 audits what S5 and S7 wrote).

### 3. Run each test

For every test:

1. **Perform the steps** in a real browser. Map these jobs onto your tools:

   | Job | Do this |
   |---|---|
   | Go to a URL | Open it in the browser. S10 needs a **new tab** (or a clean profile) so the guest shell is not the logged-in session. |
   | Click / type / submit | Drive the page. Prefer refs from an accessibility-tree dump over screenshot coordinates — far less brittle. |
   | Resize | S11 needs a 375×812 viewport. If you cannot resize, mark S11 `blocked`. |

2. **Take a screenshot and actually look at it.** This is the part that
   justifies an LLM running the suite at all. Answer each "look for" question
   from the image, one at a time, out loud. Vague self-assessment ("the page
   looks correct") is not a result; if you cannot tell from the screenshot,
   zoom in or read computed styles with in-page JavaScript, and if you still
   cannot tell, that is `blocked`. A text dump is not a substitute for looking.

3. **Check the console and network** where the test asks. An uncaught error
   with a correct-looking page is still a fail. S10 fails if anything hits
   `/api/v1/` that is not under `/api/v1/guest/`. If you cannot read console
   or network, mark those checks `blocked` rather than assuming they passed.

4. **Take the snapshot**, if the test names one. Capture the accessibility
   tree if you have one (preferred), or visible text if the test asks for
   that. Write it **verbatim** to `<run>/raw/<test-id>-<step>.txt`, then:

   ```bash
   yarn smoke:snapshot -- <run-dir> <test-id> <step> <run-dir>/raw/<test-id>-<step>.txt
   ```

   It prints `MATCH`, `DIFF` (with a unified diff), or `RECORDED` (no baseline
   existed; it wrote one). Do not normalise the text yourself — the script owns
   that, precisely so two runs produce identical bytes. Do not pretty-print or
   rewrite the dump to look more like a baseline.

   `RECORDED` is not a pass. Record the verdict from your own vision checks and
   set `snapshot: "recorded"`; say in the report that the baseline is new and
   the user should eyeball it before committing.

   A `DIFF` is recorded as `snapshot: "diff"` even when the screen looks fine —
   some regressions (a lost aria-label, a heading demoted to a div) are
   invisible in a screenshot and obvious in the diff. Read the diff and say in
   the report what changed, in words.

   Accessibility-tree dumps are **not** interchangeable across agents. If the
   screenshot answers every "look for" and the diff is only dump structure
   (YAML vs indented text, ref syntax, extra wrapper nodes) rather than missing
   labels, amounts, or headings, set `verdict` to `pass` and explain the format
   difference in `notes`. If you cannot tell format from content, `fail`.

5. **Record the result immediately** into `<run>/results.json`, appending to
   `tests`. Do not batch this to the end of the suite; a run that dies halfway
   should still have everything up to that point.

   ```json
   {
     "id": "S3",
     "title": "Group detail, in a non-USD currency",
     "verdict": "pass",
     "snapshot": "match",
     "evidence": "Screenshot: JPY totals render as `3400 JPY` with no decimal point; member balances labelled 'owes you' / 'you owe'. Console clean.",
     "observed": "only on a fail: what was on screen instead",
     "notes": "optional"
   }
   ```

   `verdict` is one of `pass`, `fail`, `blocked`, `skipped`.
   `snapshot` is one of `match`, `diff`, `recorded`, `none`.
   `evidence` says what you looked at and what it showed — it is the part a
   person reads to decide whether to trust the verdict, so name the specific
   thing you saw, not the fact that you looked.
   A `fail` must fill in `observed`: expected vs actual, concretely.

### 4. Report

```bash
yarn smoke:report -- <run-dir>
```

It validates `results.json`, writes `<run>/report.md`, and prints the totals.
It exits 2 when anything failed or was blocked — that is the suite reporting,
not the tooling breaking.

Then, in chat, give the user:

- the totals and the path to `report.md`;
- each failure in a sentence or two — what was expected, what was on screen,
  where (`file:line` only if you already know it from reading the suite, not
  from a debugging expedition you were not asked for);
- any snapshot diffs, described in words (and whether they look like dump
  format or real UI);
- any new baselines that were recorded and need a human look;
- if you have one, a suggested fix per failure, clearly marked as a suggestion
  and not applied.

Leave the smoke server running unless the user asked otherwise, and say so —
they will usually want to look at the failure themselves.

## Judging well

- **Be specific about money.** This app's whole reason for existing is that the
  numbers are right. `3400 JPY` and `34.00 JPY` are the same pixels' worth of
  effort to check and only one of them is correct. Read amounts digit by digit.
- **Shares must add up.** When a split is on screen, add the shares and compare
  to the total. A cent that does not reconcile is a real bug, not rounding you
  should be charitable about.
- **A balance needs a direction.** "You are owed" vs "you owe" is the entire
  meaning; a signed number with no label is a finding.
- **Two currencies never become one number.** If anything sums across
  currencies without labelling itself an estimate, fail it.
- **Prefer the boring failure.** If the page is fine but a request 500'd, that
  is a fail. If the page is broken but you cannot say how, say that, and mark it
  `blocked` rather than inventing a diagnosis.
- **Don't grade on a curve.** You are not being scored on a green run. A suite
  that reports three real failures is worth more than one that reports none.

## Things that will trip you up

- **The seed dates everything relative to today**, so the recurring series is
  always a little behind on purpose. A visible catch-up note is expected
  behaviour, not a bug.
- **The demo makes 10 groups and the sidebar shows 5.** Not a missing-data bug.
- **Guest link secrets change on every `smoke:reset`.** Use the one printed by
  the reset you just ran; a URL from an earlier run is revoked, not broken.
- **The guest shell must never call `/api/v1/` directly** — only
  `/api/v1/guest/*`. That is what S10's network check is for.
- **`data/smoke.db` is disposable; `data/splitsmart.db` is not.** If you ever
  find yourself about to run `yarn db:reset` (no `smoke:` prefix), stop — that
  is the user's own database.
