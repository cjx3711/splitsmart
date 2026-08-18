# Smoke tests

Playwright drives a real browser against a real seeded app, captures each
screen (PNG + accessibility dump), runs a handful of click-through flows, and
diffs the captures against committed baselines. An agent can start the suite
(`ai-smoke-test` skill) but does not click through it; it only looks when
something already failed.

`yarn test` is the suite you trust for logic. This one tells you the app is
still usable: JPY has no decimal point, the leftover cent of a 31.00 split
landed on someone, the sidebar survives a phone viewport, JJ sees the
expense Test User just added.

**The agent that starts this fixes nothing.** See the `ai-smoke-test` skill.
A run produces a report and stops.

## How to run it

Once per machine:

```bash
yarn playwright install chromium
```

Then:

```bash
yarn smoke                 # reset, serve, capture, flows, compare, check
yarn smoke -- --update     # re-record PNG + DOM baselines on THIS machine
```

Ask an agent to run the smoke tests (Claude Code: `/ai-smoke-test`). Same
command; the skill reads `report.md` and only opens pictures on a failure.

PNG baselines are machine-local. System fonts (`ui-sans-serif`) mean a snapshot
recorded on another Mac or on Linux will pixel-diff here. Re-record with
`--update` on the device you actually run on. DOM dumps of amounts and labels
are the portable half.

## The environment under test

Its own database and its own ports, so a run never touches `data/splitsmart.db`
and never fights your dev server for a port.

| | Smoke | Dev |
|---|---|---|
| Database | `data/smoke.db` | `data/splitsmart.db` |
| Web | http://localhost:5644 | 5444 |
| API | 5645 | 5445 |

```bash
yarn smoke:reset     # rebuild data/smoke.db and seed the demo account
yarn smoke:server    # serve it on 5644/5645 (yarn smoke starts this for you)
```

`yarn smoke:reset` is destructive to `data/smoke.db` and to nothing else.

**Login:** `test@example.com` / `password123`. A second real account,
`jj@example.com` / `password123` (Lee Jin Jie / JJ), is a member of Weekend
in Tokyo and Apartment 4B - that is the "other person in the group" view.

The demo seed pins dates with `SEED_TODAY=2026-06-01` and leaves the recurring
series slightly behind on purpose, so the catch-up note is always visible.

## Two kinds of evidence

Every screen produces both.

**A PNG** is a screenshot taken under pinned Playwright settings (viewport,
`deviceScaleFactor: 1`, UTC, `en-US`, dark, reduced motion). Compared with
`pixelmatch` against `smoke/baselines/png/`. This is the layout half: overflow,
a modal that opened off-screen, a sidebar that vanished on a phone.

**A DOM dump** is Playwright's accessibility snapshot of the same page, run
through the same normaliser as before (ULIDs, dates, link secrets, the live FX
estimate) and diffed against `smoke/baselines/dom/`. This is the half that
catches `3400 JPY` vs `34.00 JPY`, a lost heading, a missing "owes you".

Values that legitimately churn are either hidden before the shutter
(`scripts/smoke-screens.ts` `STABILISE_CSS`) or stripped by
`scripts/smoke-lib.ts` `normalise()`. Amounts, names, counts and labels stay.

When a diff is legitimate (you changed the UI on purpose), re-record with
`yarn smoke -- --update` and commit the baselines alongside the change. Never
to make a red run go green.

## Screens

Listed in `scripts/smoke-screens.ts`. Every id is captured twice: desktop
(1280×800) and mobile (375×812, suffix `-mobile`).

| Id | Who | What it is for |
|---|---|---|
| `marketing-home` | anonymous | Landing page, not the app shell |
| `login` | anonymous | Sign-in form |
| `dashboard` | Test User | Directed balances, ≤5 groups in the rail |
| `groups` | Test User | Full group list |
| `group-tokyo` | Test User | JPY, no decimals, Ramen / TeamLab |
| `group-apartment` | Test User | USD group Test User shares with JJ |
| `friends` | Test User | Friend list |
| `friend-ahbeng` | Test User | Mixed USD + JPY, side by side, not summed |
| `all-expenses` | Test User | Global list |
| `expense-detail` | Test User | Trader Joe's: user + system comments |
| `expense-rent` | Test User | Recurring template, next bill coming soon |
| `expense-series` | Test User | Every bill in the Rent series, oldest first |
| `expense-rent-stop` | Test User | Stop-repeating warning modal on Rent |
| `add-expense-dialog` | Test User | The add form |
| `settings` | Test User | Account + API tokens |
| `jj-dashboard` | JJ | Same ledger, other side |
| `jj-tokyo` | JJ | Tokyo as the member who paid TeamLab |
| `jj-apartment` | JJ | Apartment 4B as the other roommate |
| `guest-picker` | guest link | "Which one are you?" (Hana) |
| `guest-group` | guest (Hana) | Tokyo with no Settings / other groups |

## Flows

Listed in `scripts/smoke-flows.ts`. These mutate the smoke database, so they
run *after* the screenshots of the seeded state.

| Id | What it asserts |
|---|---|
| F1 | Book Club, equal split of 31.00 → 10.34 / 10.33 / 10.33, then save |
| F2 | Incomplete percent and exact totals are named; form is discarded |
| F3 | A comment on Trader Joe's appears without a reload; system comments stay |
| F4 | Search `coffee` narrows; `50%` matches nothing; CSV button is enabled |
| F5 | Guest link: Tokyo only; nothing hits `/api/v1/` outside `/api/v1/guest/` |
| F6 | 375×812, Show menu, no horizontal overflow on dashboard / group / expense |
| F7 | Test User adds "Smoke test paint" in Apartment 4B; JJ's session lists it |
| F8 | Stop Rent warns (cancel is a no-op); resume starts from today and does not backfill |

`yarn smoke:check` runs last, against whatever F1 / F3 / F7 / F8 wrote, and asks
whether `SUM(paid_share) == SUM(owed_share) == cost` still holds.

## Adding a screen or a flow

A new **screen** is a row in `scripts/smoke-screens.ts`. Name real seed data.
Capture both viewports happens automatically. Re-record baselines in the same
commit.

A new **flow** is a function in `scripts/smoke-flows.ts` that throws on
failure. Prefer an assertion a machine can check (`shares sum to 3100`) over a
screenshot of a transient form.

Do not add a step that only an LLM can judge. If you cannot say what would
make it fail, it does not belong here.
