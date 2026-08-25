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

`yarn smoke:server` sets `DISABLE_RECURRING_SCHEDULER=true` so boot does not
mint recurring bills; `smoke:reset` already ran the scheduler with a pinned
clock (`SEED_TODAY`). Re-recording baselines with `--no-reset` while the server
has been up can still drift balances — stop the server and reset first.

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
through the same normaliser as before (ULIDs, dates, link secrets, the app
version, the live FX estimate) and diffed against `smoke/baselines/dom/`. This
is the half that catches `3400 JPY` vs `34.00 JPY`, a lost heading, a missing
"owes you".

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
| `settings` | Test User | Account, export, danger zone |
| `admin` | Test User | Operator usage list, window pinned with `as_of` |
| `admin-user` | Test User | One account's counts and 30-day chart |
| `admin-backups` | Test User | The backup panel with no S3 configured |
| `jj-dashboard` | JJ | Same ledger, other side |
| `jj-tokyo` | JJ | Tokyo as the member who paid TeamLab |
| `jj-apartment` | JJ | Apartment 4B as the other roommate |
| `guest-picker` | guest link | "Which one are you?" (Hana) |
| `guest-group` | guest (Hana) | Tokyo with no Settings / other groups |
| `claim-success` | new account via a spare friend link | "Link claimed" after merging the placeholder |

## Flows

Listed in `scripts/smoke-flows.ts`. These mutate the smoke database, so they
run *after* the screenshots of the seeded state.

| Id | What it asserts |
|---|---|
| F1 | Book Club, equal split of 31.00 → 10.34 / 10.33 / 10.33, then save |
| F2 | Incomplete percent and exact totals are named; form is discarded |
| F3 | A comment on Trader Joe's appears without a reload; system comments stay |
| F4 | Search `coffee` narrows; `50%` matches nothing; CSV is enabled behind More actions |
| F5 | Guest link: Tokyo only; nothing hits `/api/v1/` outside `/api/v1/guest/` |
| F6 | 375×812, Show menu, no horizontal overflow on dashboard / group / expense |
| F7 | Test User adds "Smoke test paint" in Apartment 4B; JJ's session lists it |
| F8 | Stop Rent warns (cancel is a no-op); resume starts from today and does not backfill |
| F9 | Group balances, group members, and expense participants open `/friends/:id` |
| F10 | Signed-in homepage says Open app and Log out; `/app/login` redirects to the dashboard; Log out returns the homepage to Log in |
| F11 | A two-currency group names its default in the nudge and dialog; 3000 JPY → 20.00 USD; settle-up collapses to 3 × 35.00 USD |
| F12 | Tokyo's 5 recorded debts + simplify nudge → 3 on, 5 again off; nets never grow |
| F13 | Ah Beng's page carries the group's convert offer, naming USD as *your* default; previews 1200 JPY → 8.00 USD, cancels |
| F14 | Settling a friend to zero prompts for the cancelling buckets, offers no USD, survives "Leave them for now", then clears on Close them out |
| F15 | Usage lists accounts with no amount anywhere in `main`; search narrows to one and then to none; View keeps `as_of` and shows integer counts |
| F16 | The backups panel reports itself unconfigured, lists no runs, and "Back up now" says so instead of recording a run |
| F17 | JJ gets no Admin link, `/app/admin` sends them to the dashboard, and `/api/v1/admin/*` answers 403 |

`yarn smoke:check` runs last, against whatever F1 / F3 / F7 / F8 / F11 / F14
wrote, and asks whether `SUM(paid_share) == SUM(owed_share) == cost` still
holds. The conversion and settle-all flows write pairs of payments, so this is
the check that says those pairs balance.

**Exchange rates are stubbed for every flow**, in `stubExchangeRates`
(`scripts/smoke-lib.ts`): a fixed USD-per-unit table, USD/JPY pinned at 150. A
conversion test against live rates could only assert "a number appeared", which
is precisely the bug it exists to catch. A base the table does not carry is a
404, not a fallthrough to the network. The captures still take the real rate
for the ≈ estimate, which is why `normalise()` blanks it.

**The backup config is pinned in `smoke:server`, not read from your `.env`.**
`BACKUP_*` is set on the command line (empty bucket and keys, a `smoke.invalid`
endpoint), so `admin-backups` captures the same unconfigured panel on every
machine. Without that, a developer with real S3 credentials in `.env` would
capture their own bucket name — and a scheduler that had actually started.
`normalise()` also rewrites the checkout path to `<ROOT>`, since the panel
prints the resolved database and snapshot directories.

F13 and F14 both read Ah Beng, and F14 spends the JPY balance F13 asserts, so
F13 comes first and F14 says so if it finds the balance already gone. F12
restores the simplify toggle it flips, and F11 builds its own mixed-currency
group in Yosemite Camping rather than borrowing one.

## Adding a screen or a flow

A new **screen** is a row in `scripts/smoke-screens.ts`. Name real seed data.
Capture both viewports happens automatically. Re-record baselines in the same
commit.

A new **flow** is a function in `scripts/smoke-flows.ts` that throws on
failure. Prefer an assertion a machine can check (`shares sum to 3100`) over a
screenshot of a transient form.

Do not add a step that only an LLM can judge. If you cannot say what would
make it fail, it does not belong here.
