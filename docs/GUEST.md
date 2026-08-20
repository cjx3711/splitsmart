# Guest links

Implemented. Replaces recovery codes and the old one-token-per-group invite,
both of which are gone.

Native primary keys are ULIDs (`docs/ULIDS.md`). There is no integer
`compat_id`, so a merge has no second id space to preserve.

Two consumers:

| App | URL | Who | Offline |
|---|---|---|---|
| Logged-in | `/app/*` | email + password, cookie session | yes, later (`docs/OFFLINE.md`) |
| Guest | `/guest/*` | invite-link secret in `localStorage`, sent on every request | **never** |

Same React components. Different entry points, different auth, different
permission scaffolding. Guest never opens Dexie and never calls `/api/v1/sync/*`.

---

## Why this replaces recovery codes

A ghost has no email and no password. Their identity used to be a session cookie
plus a one-time recovery code. The recovery code was a second credential nobody
asked for.

The invite URL **is** the credential. `localStorage` remembers it on this
browser; another device opens the same URL. The owner can expire or revoke it.
No cookie exchange, no session row for guests.

Ghosts are **placeholder people** the owner created. Opening a link does not
create a user. The owner adds friends and group members
(`POST /api/v1/groups/:id/members`); guests pick among those names.

---

## Link kinds

One table, three capabilities. The secret in the URL is the row's token
(hash stored; plaintext returned once and kept by the client).

| Kind | Bound to | Acting as | Can see |
|---|---|---|---|
| `group` | a group | whoever they pick, re-pickable | that group only |
| `group_member` | a group + one user | that user, no picker | that group only |
| `friend` | owner + one ghost | that ghost | Alice↔owner expenses, and groups that ghost is in, as that member |

`is_ghost = 0` means a linked account. No kind of link can act as them:
`mintAccessLink` refuses to create one and `resolveAccessLink` returns
`claimed`, which the UI renders as "log in" rather than "invalid link". The
general picker only lists `is_ghost = 1` members.

The general group link is a known impersonation channel. Anyone in a group can
already see and edit that group's expenses, so pick/re-pick is a convenience
equal to the individual link (which only skips the picker). Sharing the URL is
the owner's choice.

The friend link is the wide one: one secret, every group that ghost belongs to,
plus non-group expenses that include both the ghost and the owner. It is not
"every expense the owner ever created". Owner's other friends and groups the
ghost is not in stay invisible.

Guest permissions (all three kinds):

- Add, edit, delete expenses; settle up.
- Read and write **comments** on an expense the link can see, as the person the
  link acts as. Their own notes are deletable by them and nobody else; the
  generated `system` ones are not deletable by anyone (`docs/PARITY.md` slice 1).
- Download the expenses **in scope** as CSV (`/api/v1/guest/expenses.csv`). The
  scope is the link's, not the owner's.
- Not: group settings, members, mint/rotate/expire links, add people, API
  tokens, import, create groups, create friends.
- Not: **starting or changing a recurring series.** Occurrences are ordinary
  expenses and a guest sees and edits them like any other bill, but the
  scheduler is a server job and a series the owner cannot see coming is a bad
  surprise. The field is dropped from a guest write rather than rejected, so the
  bill they were recording still lands, and an omitted interval leaves an
  existing series alone.

Owner-only for anything that mints or revokes a link. There is no route under
`/api/v1/guest/*` for any of it, so this is structural rather than a hidden
button.

Optional `expiresAt` at mint time, defaulting to 3 months. Revoke is immediate because the secret is
checked on every request.

---

## Auth

No session cookie for guests. Every API call from `/guest` sends

```
Authorization: Bearer link_<plaintext>
```

Prefix distinguishes these from API tokens. `requireAuth` on the logged-in tree
rejects `link_` tokens outright (`src/auth/middleware.ts`) with
`{ guestLink: true }`, rather than falling through to the cookie; a guest
browser has no cookie, so a missing check would read as an anonymous request
instead of a clear 401. Compat `/api/sw/v3.0` shares that middleware and so
refuses them too. The guest client sends `credentials: "omit"` for the mirror
of the same reason.

Guest app talks only to `/api/v1/guest/*`, which resolves the token to
`{ kind, userId, groupId?, ownerUserId? }` and enforces that scope in every
handler. `expenseInScope()` in `src/domain/access-links.ts` is the single
definition of visibility; the four read paths all call it rather than
re-deriving the predicate. A group link for Alice in group A never returns
group B, and never returns a 1:1 expense Alice is on.

A general group link also sends `X-SplitSmart-Acting-As`, because there is no
server-side guest state to remember the pick in. It is re-validated on every
request. `409 { needsPicker: true }` means "the link is fine, say who you are";
`401` means the link itself is finished. The client renders a different screen
for each, and collapsing them would send someone who only needs to tap their
own name off to beg for a replacement link.

Landing: `/guest/l/:token` → write `localStorage` key
`splitsmart.guest.link` (namespaced, never the Dexie DB) → `history.replaceState`
to a secret-free path (`/guest/groups/:id`, `/guest/friend`, or `/guest/pick`).
Screenshots and Referer do not keep the token. Bookmarking depends on
`localStorage` or keeping the original URL.

Same origin as `/app`, so keys **must** be prefixed `splitsmart.guest.*`.
`entry-app.tsx` clears the guest keys on every `/app` boot so a leftover secret
cannot mix with a session.

If the token is missing, expired, revoked, or the target user is now
`is_ghost = 0`, the next request is 401: "ask the owner for a new link" or
"this person has an account, log in".

---

## Two shells

Path split, not a subdomain. Service workers are origin-wide unless scoped.

```
/app/*     logged-in SPA. PWA SW scope /app/. start_url /app/.
/guest/*   guest SPA. Network-only SW scope /guest/. No precache of API.
/          marketing, about, docs - not the PWA.
```

Vite MPA: `index.html`, `app.html` and `guest.html`, three `createRoot`s,
shared `web/src` components (`ExpenseForm`, `SplitEditor`, `money.tsx`,
`reopenExpense.ts`, …). Guest bundle imports no Dexie, no sync, and no
logged-in router. Router basenames `/app` and `/guest`; the marketing shell is
at the root. Crossing shells is a document load, so those links are plain
`<a href>` - a `<Link to="/about">` inside `/app` resolves to `/app/about` and
404s, which is why `Footer.tsx` says so at the top.

Guest SW exists so a future or leftover SW at `/` cannot control `/guest/`:
longer matching scope wins. It is network-only and never touches `caches` -
`caches.keys()` is origin-wide, so deleting them would wipe the logged-in app
shell the moment someone opens a claim link. Navigate with no network is a
needs-connection screen, not last week's balances. That is the whole point of
revocable links, and it is why the guest SW registers in dev too: the case it
protects against is a stale worker that is already installed.

Production Hono: `/app` and `/app/*` → `app.html`; `/guest` and `/guest/*` →
`guest.html`; everything else → `index.html`. `serveStatic` is registered
**before** those fallbacks so `/app/sw.js`, `/app/manifest.webmanifest` and
`/guest/sw.js` are served as themselves; get that order wrong and SW
registration receives an HTML document and the scope this split exists to claim
is left to whatever registers at `/`. Dev: a small Vite middleware
(`web/vite.config.ts`) does the same rewrite, skipping anything with a file
extension for the same reason.

Old `/join/:token` and `/accept/:code` 301 into `/guest/l/...` for one release.

Logged-in user who is already a member of the group, opening a guest URL:
`/api/v1/claim/candidates` answers `already_member` and the claim page sends
them to `/app/groups/:id`. They are not offered a different name to become.

---

## Claim

One user flow for *manual* placeholders. Create the account first, then claim.
No in-place "set password on the ghost" path - that is a second flow for the
same outcome.

```
Guest (not logged in)
  → pick a ghost, use the group/friend as them
  → banner: create an account to keep this identity
  → /app/claim?link=… (registers, comes back to the same URL)
  → "this is me" → merge that ghost into the logged-in account

Logged in, not a member of this group, holding a valid link
  → offer unclaimed (is_ghost = 1) members the link can act as
  → same merge

Logged in, already a member
  → no claim picker; they are themselves
```

Splitwise-imported ghosts have two extra, automatic paths that do not need a
link. Both go through the same `mergeUsers` (shares added, never re-split):

- **Import.** Holding a Splitwise API key is proof you are that Splitwise
  user. If a live ghost already carries your `metadata.splitwise_id`, import
  merges it into you before writing anything. Dummy vs confirmed does not
  matter; the key is the proof.
- **Signup.** Splitwise's `registration_status` is `confirmed` for a real
  Splitwise account and `dummy` for an email someone else typed. Imported
  ghosts store that flag. Signing up at a confirmed ghost's `invite_email`
  merges it. Dummy ghosts and invite-only friends (no splitwise_id) still
  need the link: two owners can invite the same inbox, and a dummy address
  was never verified by Splitwise.

Claim endpoints live on the logged-in API (`src/routes/native/claim.ts`):
cookie session **and** the link token in the body. The token is what makes
those ghosts claimable; a logged-in user with no link cannot eat a random
placeholder. `authoriseClaim` is shared by preview and confirm so the two
cannot disagree about who is claimable.

The banner passes the secret to `/app/claim` in the query string. That is the
one place a secret goes back into a URL and it is unavoidable - `/app` is a
different document and cannot read the guest shell's memory - so the claim page
`replaceState`s it away as soon as it has read it.

After merge the ghost is retired (`deleted_at` + `merged_into_user_id`), so
every link that acted as them dies on the next request and the pickers stop
offering them. A general group link is NOT revoked by a claim: it was never
bound to that person, and turning it off is a separate decision. It simply has
one fewer name to offer.

No unlink. Wrong-person claim is undo (support), not a toggle.

---

## Merge

`src/domain/merge.ts`. Survivor is always the **logged-in account** (stable
session, future Dexie name, email). The ghost is consumed.

There is no `compat_id` and import does not reuse a Splitwise integer as the
PK, so there is no second id to alias. Rewrite every FK that pointed at the
ghost onto the account, then soft-delete the ghost (`deleted_at`,
`merged_into_user_id` so a missed pointer is visible, not a living person). A
CHECK refuses a `merged_into_user_id` that is not also soft-deleted.

All of it in **one transaction**. Expense writes still go through
`src/domain/expenses.ts`.

### `mergeExpenseParticipants(trx, expenseId, fromUserId, toUserId)`

The overlapping-expense case is not a reject. It is this helper, which claim
calls, and which is also the utility for "these two names are the same person
on this bill".

`expense_users` PK is `(expense_id, user_id)`, so you cannot UPDATE the ghost's
row to the account id when the account is already on it. Combine instead:

- `paid_share_minor` and `owed_share_minor` **sum**.
- Drop the `from` row.
- Totals still equal `cost_minor` - we did not change the pie, only the
  number of slices. Then `deriveRepayments()` as on every other write.
- Set `split_type = 'exact'`, `split_input = owed` for remaining people,
  `split_meta = NULL`. Do **not** re-run `computeSplit` from the old type:
  equal/percent/itemized with one fewer person would move cents. Itemized
  meta would also disagree with the editor if we left it in place (the editor
  recomputes from lines). Exact + cleared meta is the honest stored form;
  money does not move.

`created_by` / `updated_by` on that expense: rewrite `from` → `to`.

Claim preview, before confirm:

```
You and Alice are both on 3 expenses. Their shares will be combined
into you. 11 other expenses will be retitled as you.
[Cancel]  [Combine and claim]
```

Descriptions are listed when there are five or fewer; otherwise the count is
enough. Confirm runs the merge. It is never silent.

### Rest of the user merge

| What | Rule |
|---|---|
| Expenses where only the ghost is a participant | rewrite `expense_users.user_id` (and repayments via the writer) |
| Expenses where both are | `mergeExpenseParticipants` |
| `group_members` both in the same group | drop the ghost row; keep the account; if either role is `owner`, keep `owner`; still a member if either row is active |
| `group_members` only ghost | rewrite `user_id` |
| `friendships` | rewrite ids through `friendPair`; drop a row that would become self; `ON CONFLICT DO NOTHING` |
| comments, activity actor | rewrite |
| `access_links` for the ghost | revoke |
| ghost row | `merged_into_user_id = account`, `deleted_at = now`, `email = NULL`, `invite_email = NULL` |

`yarn db:check` gains three checks for this: `merged_users_are_retired`,
`nothing_points_at_a_merged_user`, and `live_links_act_as_live_ghosts`.

---

## Owner UI (logged-in app)

`web/src/LinkPanel.tsx`, shared by both screens.

On a group: a general link, plus per-member links for `is_ghost = 1` members.
Members with an account are listed as "has an account" and get no slot.
`web/src/AddMemberForm.tsx` is how names get there in the first place, since
opening a link no longer creates anyone.

On a friend: mint/revoke the friend link for that ghost. The email invite
carries this URL (`/guest/l/:token`), not a recovery code. Same story if
Postmark is off: the URL comes back in the API response so the owner can pass
it on.

**The URL is always copyable.** The secret is stored so the owner can copy it
again from the link panel. Rotating revokes the old secret and mints a new one
in the same transaction.

Rotating a general link does not kill per-member or friend links. Revoking a
person's member link does not kill the general link (they can still pick
themselves there until you expire that too). Removing a member from a group
revokes their `group_member` link for that group - that rule lives in
`routes/native/groups.ts`, next to the removal itself.

---

## Schema

Folded into `migrations/001_initial_schema.sql`, which is still the only
migration. `users.recovery_code_hash`, `groups.invite_token` and
`groups.invite_rotated_at` are gone; `group_members.joined_via` lost its
`invite_link` value. Once a real database exists somewhere, the same change
becomes a table rebuild: `-- migrate:no-transaction` and
`PRAGMA foreign_keys=OFF`. See CLAUDE.md.

```sql
-- users: recovery_code_hash gone; merged_into_user_id added (stub only,
-- and CHECKed to imply deleted_at).

CREATE TABLE access_links (
  id           TEXT PRIMARY KEY,          -- ULID
  token_hash   TEXT NOT NULL UNIQUE,      -- sha256 of the secret
  kind         TEXT NOT NULL,             -- 'group' | 'group_member' | 'friend'
  group_id     TEXT REFERENCES groups(id),
  user_id      TEXT REFERENCES users(id), -- ghost the link acts as; NULL on kind=group
  created_by   TEXT NOT NULL REFERENCES users(id),
  expires_at   TEXT,                      -- NULL = until revoked
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  CHECK (kind IN ('group', 'group_member', 'friend')),
  CHECK (LENGTH(id) = 26),
  CHECK (
    (kind = 'friend' AND group_id IS NULL AND user_id IS NOT NULL)
    OR (kind = 'group' AND group_id IS NOT NULL AND user_id IS NULL)
    OR (kind = 'group_member' AND group_id IS NOT NULL AND user_id IS NOT NULL)
  )
) STRICT;
```

Three partial unique indexes enforce **one live link per slot** (per group, per
group+member, per owner+friend), which is what makes mint-is-rotate safe: the
old secret dies in the same transaction the new one is born, with no window
where both work. They are partial on `revoked_at IS NULL` rather than also on
expiry, because `datetime('now')` is not deterministic and SQLite refuses it in
an index.

---

## Guest chrome

A persistent banner (`ClaimBanner.tsx`): create an account to claim this
identity. The rest of the guest app is the existing group/friend/expense
screens with owner-only controls stripped. People picker is group members (or
the owner, on a friend link) - no "add a person". `ExpenseList` takes
`personLinks={false}` there, because `/friends/:id` is a logged-in screen and
would be a dead end.

---

## Testing

`src/domain/merge.test.ts`, `src/routes/native/guest.test.ts`, and
`src/routes/native/claim.test.ts` cover:

- Group link cannot read another group or a 1:1 expense the ghost is on.
- Friend link sees Alice↔owner expenses (including in groups) and not the
  owner's other friends.
- General picker re-pick; `is_ghost = 0` excluded; individual link auto-picks
  and ignores a client-supplied name.
- Expired/revoked secret is 401 with no leftover access; a claimed person is
  401 `claimed`, worded as "log in".
- A guest link is refused by every `/api/v1` route and by `/api/sw/v3.0`; an
  API token is refused by `/api/v1/guest/*`.
- Guest writes stay in scope, including that an EDIT cannot move an expense out
  of the scope that authorised the edit.
- Mint-is-rotate; rotating the general link leaves member links alive; removing
  a member kills theirs.
- Claim preview names overlapping expenses; confirm combines rather than
  re-splits; a bystander's cent does not move; itemized becomes exact.
- Claim without a link token, or with a link that does not cover that person,
  cannot merge a ghost.
- `db:check`-equivalent assertions after every merge test.

Not covered by an automated test: the guest offline screen, which is a
`fetch()` rejection path. It is `GuestOfflineError` → `NeedsConnection`, and
there is deliberately nothing cached for it to fall back to.

---

## Deliberately not doing

- **Unlink.** Claim is "I am this person".
- **In-place password-on-ghost.** Create account first; merge is the one path.
- **Guest offline / Dexie / sync.** A link is revocable; a local copy is not.
- **Guest API tokens or compat.** Those are full-user credentials.
- **Guests creating people, groups, or links.**
- **A living second user row after claim.** `merged_into` is a stub, not a
  participant.
- **Subdomains.** `/app` + scoped SWs are the isolation we are buying.
