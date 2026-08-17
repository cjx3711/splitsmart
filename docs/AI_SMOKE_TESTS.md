# AI smoke tests

An end-to-end suite written for an agent to read and perform, rather than for a
test runner to execute. There is no Playwright here: the steps are prose, the
agent drives the browser, and the assertions are things a person would check by
looking — *is the balance the right way round, does the split preview add up, is
the sidebar still there on a phone*.

That buys coverage of the parts a DOM assertion is bad at (layout, overflow,
legibility, "this looks broken") at the cost of determinism. So the suite is
deliberately paired with a snapshot mechanism that IS deterministic — see
"Two kinds of evidence" below — and it never gates a commit. `yarn test` is the
suite you trust for logic; this one tells you the app is usable.

**The agent that runs this fixes nothing.** See `.claude/skills/ai-smoke-test/SKILL.md`.
A run produces a report and stops. That is the whole point: a failing smoke test
is information about the app, and an agent that quietly repairs the app to make
its own test pass has destroyed the information.

## How to run it

```bash
/ai-smoke-test
```

Or a subset: `/ai-smoke-test S1-S4`, `/ai-smoke-test guest`.

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
yarn smoke:server    # serve it on 5644/5645 (launch.json config: "smoke")
```

`yarn smoke:reset` is destructive to `data/smoke.db` and to nothing else. Run it
before every suite: the tests below name specific groups and amounts from
`scripts/seed-demo.ts`, and a suite run mutates the data it walks through.

**Login:** `test@example.com` / `password123`.

The demo seed dates everything relative to today on purpose, so the recurring
series is always slightly behind and the catch-up note is always visible. That
is also why snapshots are normalised rather than compared raw.

## Two kinds of evidence

Every test produces at least one, and most produce both.

**A snapshot** is the page's text — the accessibility tree or its visible text —
run through `yarn smoke:snapshot`, which erases the values that legitimately
change between runs (ULIDs, dates, `ref_N`, link secrets) and diffs the rest
against a committed baseline in `smoke/baselines/`. This is the deterministic
half: a diff is a fact, not a judgement, and it survives the agent being
replaced by a different agent next month.

**A vision check** is the agent looking at a screenshot and answering the
questions the test asks. This is the half that catches a chart rendered on top
of the sidebar, a currency truncated to `¥34…`, or a modal that opened
off-screen — none of which move a single byte of the accessibility tree.

Screenshots are judged in the session and the *judgement* is what gets written
down; the browser tooling hands the agent an image, not a file it can commit, so
there are no PNG baselines to diff. Where a visual regression must be caught
byte-for-byte rather than by opinion, assert on computed styles via
`javascript_tool` and snapshot the result as text.

### On baselines

The first time a snapshot is taken there is nothing to compare against, so the
script records it and says `RECORDED`. **A recorded baseline is not a pass** —
it is a promise that this is what the page looked like when somebody chose to
freeze it. Look at the file before committing it.

When a diff is legitimate (you changed the UI on purpose), the baseline is
updated by *you*, in a normal commit, alongside the change that caused it.
Never by the agent mid-run, and never to make a red run go green.

---

## The suite

Each test is: a **setup**, numbered **steps**, a **snapshot** to take (or none),
and **look for** — the questions the screenshot has to answer. Answer every
"look for" explicitly. "Looks fine" is not a result.

Unless a test says otherwise, start from a logged-in dashboard at
http://localhost:5644/app.

---

### S1 — Sign in

**Setup:** log out first if a session exists.

1. Go to http://localhost:5644/app — expect a redirect to the login screen.
2. Sign in as `test@example.com` / `password123`.

**Snapshot:** `S1 / dashboard`, from the accessibility tree.

**Look for:**
- The dashboard renders with a sidebar listing groups and friends.
- An overall balance is shown, and it is labelled as owed *to* or *by* you —
  not a bare signed number.
- The sidebar shows at most 5 groups (the seed makes 10; the sidebar shows the
  newest 5).
- No error toast, and no console error (check `read_console_messages`).

---

### S2 — The marketing shell is not the app shell

1. Go to http://localhost:5644/ .

**Snapshot:** none.

**Look for:**
- A marketing landing page, not the logged-in app — no sidebar, no balances.
- Being logged in does not leak account data onto it.
- A visible way into the app (a sign-in or open-app link).

---

### S3 — Group detail, in a non-USD currency

1. From the sidebar, open **Weekend in Tokyo** (a JPY group).

**Snapshot:** `S3 / tokyo-group`, accessibility tree.

**Look for:**
- JPY amounts have **no decimal point** — `3400 JPY`, never `34.00`. This is the
  single most valuable check in the suite; rule 1 in `CLAUDE.md` exists because
  this is what a currency bug looks like from outside.
- The member list and per-member balances render, and the balances are labelled
  by direction (who owes whom), not signed.
- The expense list shows *Ramen at Ichiran* and *TeamLab tickets*.
- Long group names and long member names are not clipped mid-word.

---

### S4 — Balances are per-currency, side by side

1. Open the dashboard, then a friend who has both USD and JPY history
   (follow the balances from S3's group members if unsure).

**Snapshot:** `S4 / mixed-currency-balance`, accessibility tree.

**Look for:**
- Two currencies are shown **back to back on one line**, e.g. `34750 JPY 74.02 USD`.
- Nothing sums them into a single figure. There is no combined total, no "≈ total
  in USD" that is presented as the balance itself.
- If a `≈` estimate appears, it is visibly *labelled* as an estimate and sits
  next to the real per-currency amounts, not in place of them.

---

### S5 — Add an expense, equal split

1. Open **Office Lunch Club**.
2. Start a new expense. Description `Smoke test lunch`, amount `31.00`, USD.
3. Put three people on it, split equally, paid by you.
4. Watch the split preview before saving.
5. Save.

**Snapshot:** `S5 / expense-created`, accessibility tree of the expense detail page.

**Look for:**
- The preview shows three shares that **add up to exactly 31.00** — 10.34 / 10.33
  / 10.33, in some order. Three equal shares of 31.00 cannot all be equal; the
  leftover cent must land on somebody, not vanish and not be duplicated.
- The saved expense shows the same numbers the preview did.
- The expense appears in the group list and the group balance moved by 31.00.

---

### S6 — Split editor: percent and exact

1. Open the add-expense form again in the same group. Amount `100.00`.
2. Switch the split to **percent** and give an allocation that does not total
   100% (say 50 / 20).
3. Then fix it to total 100%.
4. Switch to **exact** and enter amounts that do not total the cost.

**Snapshot:** none (transient form state).

**Look for:**
- An incomplete percent split is called out clearly — the remaining/overshoot is
  named, and saving is either blocked or obviously refused.
- The message updates live as the numbers change, and clears when it balances.
- Switching split type does not silently keep the previous type's numbers in a
  way that would save a wrong split.
- Discard the form; do not save it.

---

### S7 — Expense detail, comments, and the edit trail

1. Open the group **Apartment 4B** and open **Trader Joe's run**.

**Snapshot:** `S7 / expense-comments`, accessibility tree.

**Look for:**
- The comment thread shows both typed comments and at least one **system**
  comment describing an edit (the seed makes one).
- The system comment's amounts are formatted in the expense's own currency.
- A typed comment shows a delete affordance; the system comment does **not**.
- Post a comment of your own (`smoke test comment`) and confirm it appears
  without a reload.

---

### S8 — Recurring series

1. Open the **Rent** expense (a monthly template) from Apartment 4B.

**Snapshot:** `S8 / recurring-note`, accessibility tree.

**Look for:**
- The page says it repeats, and how often, in a sentence a person can read.
- Because the seed leaves the series behind on purpose, the catch-up note is
  visible — it says the series is behind rather than silently showing nothing.
- Generated occurrences are visibly related to the template, and each is dated
  the day it was due (they are not all dated today).

---

### S9 — Filters, search, and the CSV link

1. Go to **All expenses**.
2. Search for `coffee`.
3. Add a date filter that excludes most results, then clear it.
4. Type `50%` into the search box.

**Snapshot:** `S9 / filtered-list`, accessibility tree, taken with `coffee` applied.

**Look for:**
- The list narrows to matching expenses and the empty state (when a filter
  matches nothing) is a sentence, not a blank panel.
- `50%` does not match everything — the percent sign is searched literally.
- A CSV export link is present and its URL carries the same filters currently
  applied to the list.
- Filters survive a reload (they are in the URL) — reload and confirm.

---

### S10 — Guest link (an unauthenticated shell)

**Setup:** `yarn smoke:reset` prints two guest URLs. Use the **group** one.

1. Open the group guest URL in a new tab.

**Snapshot:** `S10 / guest-group`, accessibility tree.

**Look for:**
- The group's expenses render with no login.
- There is **no** sidebar of your other groups, no settings, no import, no way
  to mint another link, and no access to groups outside this link's scope.
- A claim/sign-up affordance is offered rather than assumed.
- Console shows no failed requests to `/api/v1/` (the guest shell must only
  talk to `/api/v1/guest/`) — check `read_network_requests`.

---

### S11 — Mobile viewport

1. Resize to the `mobile` preset (375×812) and reload.
2. Visit the dashboard, a group, and an expense detail.

**Snapshot:** none (the tree is the same; the failure mode is visual).

**Look for:**
- Nothing overflows horizontally. Scroll right and confirm there is nowhere to go.
- Amounts are not truncated or wrapped mid-number.
- The sidebar collapses into something reachable rather than disappearing or
  covering the content.
- Tap targets (add expense, the group rows) are not overlapping.

---

### S12 — Data integrity after the run

1. Run `yarn smoke:check`.

**Snapshot:** none.

**Look for:**
- It reports no violations. This is the one test with a machine-checkable
  answer, and it is last on purpose: S5 and S7 wrote expenses and comments
  through the UI, and this asks the database whether those writes kept
  `SUM(paid_share) == SUM(owed_share) == cost` and whether
  `expense_repayments` still agrees with `expense_users`.
- If it fails, the report says so and stops. Do not repair the data.

---

## Adding a test

Copy the shape above. Three things keep the suite honest:

1. **"Look for" must be answerable from the screen.** "Balances are correct" is
   not; "the JPY balance shows no decimal point" is. If you cannot say what
   would make it fail, the agent cannot either.
2. **Name real seed data.** Tests that invent their own fixtures drift from
   `scripts/seed-demo.ts` and start failing for reasons that are not bugs.
3. **Snapshot the page, not the moment.** Anything genuinely time-varying should
   be covered by a normalisation rule in `scripts/smoke-snapshot.ts`, not left
   in a baseline that then diffs every day at midnight.
