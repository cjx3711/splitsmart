# Guest links

A plan, not an implementation. Replaces recovery codes and the current
one-token-per-group invite.

**Prerequisite:** native primary keys are ULIDs (`docs/ULIDS.md`). There is no
integer `compat_id`. Import mints ULIDs; merge does not have a second id space
to preserve.

Two consumers after this:

| App | URL | Who | Offline |
|---|---|---|---|
| Logged-in | `/app/*` | email + password, cookie session | yes, later (`docs/OFFLINE.md`) |
| Guest | `/guest/*` | invite-link secret in `localStorage`, sent on every request | **never** |

Same React components. Different entry points, different auth, different
permission scaffolding. Guest never opens Dexie and never calls `/api/v1/sync/*`.

---

## Why this replaces recovery codes

A ghost has no email and no password. Today their identity is a session cookie
plus a one-time recovery code. The recovery code is a second credential nobody
asked for.

The invite URL **is** the credential. `localStorage` remembers it on this
browser; another device opens the same URL. The owner can expire or revoke it.
No cookie exchange, no session row for guests.

Ghosts still exist as **placeholder people** the owner created. Opening a link
does not create a user. The owner adds friends and group members; guests pick
among those names.

---

## Link kinds

One table, three capabilities. The secret in the URL is the row's token
(hash stored; plaintext shown once and kept by the client).

| Kind | Bound to | Acting as | Can see |
|---|---|---|---|
| `group` | a group | whoever they pick, re-pickable | that group only |
| `group_member` | a group + one user | that user, no picker | that group only |
| `friend` | owner + one ghost | that ghost | Alice↔owner expenses, and groups that ghost is in, as that member |

`is_ghost = 0` means a linked account. A group or group_member link cannot act
as them: prompt login. The general picker only lists `is_ghost = 1` members.

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
- Not: group settings, members, mint/rotate/expire links, add people, API
  tokens, import, create groups, create friends.

Owner-only for anything that mints or revokes a link.

Optional `expires_at` at mint time. Revoke is immediate because the secret is
checked on every request.

---

## Auth

No session cookie for guests. Every API call from `/guest` sends

```
Authorization: Bearer link_<plaintext>
```

Prefix distinguishes these from API tokens. `requireAuth` on the logged-in
tree does not accept `link_` tokens. Compat `/api/sw/v3.0` does not either.

Guest app talks only to `/api/v1/guest/*`, which resolves the token to
`{ kind, userId, groupId?, ownerUserId? }` and enforces that scope on every
handler. A group link for Alice in group A never returns group B, and never
returns a 1:1 expense Alice is on.

Landing: `/guest/l/:token` → write `localStorage` key
`splitsmart.guest.link` (namespaced, never the Dexie DB) → `history.replaceState`
to a secret-free path (`/guest/groups/:id` or `/guest/friends/:id`). Screenshots
and Referer do not keep the token. Bookmarking depends on `localStorage` or
keeping the original URL.

Same origin as `/app`, so keys **must** be prefixed `splitsmart.guest.*`.
Clear the guest key on `/app` login so a leftover secret cannot mix with a
session.

If the token is missing, expired, revoked, or the target user is now
`is_ghost = 0`, the next request is 401: "ask the owner for a new link" or
"this person has an account, log in".

---

## Two shells

Path split, not a subdomain. Service workers are origin-wide unless scoped.

```
/app/*     logged-in SPA. PWA SW scope /app/. start_url /app/.
/guest/*   guest SPA. Network-only SW scope /guest/. No precache of API.
/          marketing, about, docs — not the PWA.
```

Vite MPA: `app.html` and `guest.html`, two `createRoot`s, shared
`web/src/components` (and `ExpenseForm`, `SplitEditor`, `money.tsx`, etc.).
Guest bundle must not import Dexie, sync, or the logged-in router. Two
`BrowserRouter` basenames (`/app`, `/guest`).

Guest SW exists so a future or leftover SW at `/` cannot control `/guest/`:
longer matching scope wins. It is network-only — navigate with no network is a
needs-connection screen, not last week's balances. That is the whole point of
revocable links.

Production Hono: `/app` and `/app/*` → `app.html`; `/guest` and `/guest/*` →
`guest.html`. Dev: Vite history fallback for both. Old `/join/:token` and
`/accept/:code` redirect into `/guest/l/...` until those routes die.

Logged-in user who is already a member of the group, opening a guest URL:
send them to `/app/groups/:id`. Do not let them pick a different name.

---

## Claim

One user flow. Create the account first, then claim. No in-place
"set password on the ghost" path — that is a second flow for the same outcome.

```
Guest (not logged in)
  → pick a ghost, use the group/friend as them
  → banner: create an account to keep this identity
  → /app/register (cookie session)
  → back on /guest, still holding the link secret
  → "this is me" → merge that ghost into the logged-in account

Logged in, not a member of this group, holding a valid link
  → offer unclaimed (is_ghost = 1) members the link can act as
  → same merge

Logged in, already a member
  → no claim picker; they are themselves
```

Claim endpoint lives on the logged-in API: cookie session **and** the link
token in the body. The token is what makes those ghosts claimable; a logged-in
user with no link cannot eat a random placeholder.

After merge the ghost is `is_ghost = 0` in effect (row retired, see below), so
every link that acted as them dies on the next request. Individual and general
pickers stop offering them.

No unlink. Wrong-person claim is undo (support), not a toggle.

---

## Merge

Survivor is always the **logged-in account** (stable session, future Dexie
name, email). The ghost is consumed.

There is no `compat_id` and import does not reuse a Splitwise integer as the
PK, so there is no second id to alias. Rewrite every FK that pointed at the
ghost onto the account, then soft-delete the ghost (`deleted_at`,
`merged_into_user_id` so a missed pointer is visible, not a living person).

All of it in **one transaction**. Expense writes still go through
`src/domain/expenses.ts`.

### `mergeExpenseParticipants(expenseId, fromUserId, toUserId)`

The overlapping-expense case is not a reject. It is this helper, which claim
calls, and which is also the utility for "these two names are the same person
on this bill".

`expense_users` PK is `(expense_id, user_id)`, so you cannot UPDATE the ghost's
row to the account id when the account is already on it. Combine instead:

- `paid_share_minor` and `owed_share_minor` **sum**.
- Drop the `from` row.
- Totals still equal `cost_minor` — we did not change the pie, only the
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

List descriptions if it is a handful; otherwise the count is enough. Confirm
runs the merge. Do not silently combine.

### Rest of the user merge

| What | Rule |
|---|---|
| Expenses where only the ghost is a participant | rewrite `expense_users.user_id` (and repayments via the writer) |
| Expenses where both are | `mergeExpenseParticipants` |
| `group_members` both in the same group | drop the ghost row; keep the account; if either role is `owner`, keep `owner` |
| `group_members` only ghost | rewrite `user_id` |
| `friendships` | rewrite ids through `friendPair`; drop a row that would become self; `ON CONFLICT DO NOTHING` |
| comments, activity actor | rewrite |
| `access_links` for the ghost | revoke |
| ghost row | `merged_into_user_id = account`, `deleted_at = now`, clear any leftover recovery hash |

Then `yarn db:check` must pass.

---

## Owner UI (logged-in app)

On a group: general link (copy, expiry, revoke/rotate), plus per-member links
for `is_ghost = 1` members. Claimed members show "has an account" instead of a
link.

On a friend: mint/revoke the friend link for that ghost. Email invite, when
it fires, carries this URL (`/guest/l/:token`), not a recovery code. Same
story if Postmark is off: return the URL in the API response so the owner can
pass it on.

Rotating a general link does not kill per-member or friend links. Revoking a
person's member link does not kill the general link (they can still pick
themselves there until you expire that too). Removing a member from a group
revokes their `group_member` link for that group.

---

## Schema sketch

Fold into the next migration (or `001` if still pre-deploy). Drop
`users.recovery_code_hash` and `groups.invite_token` — SQLite cannot drop a
column's CHECKs casually; this is a table rebuild, so
`-- migrate:no-transaction` and `PRAGMA foreign_keys=OFF` if it is not still
`001`. See CLAUDE.md.

```sql
-- users: recovery_code_hash goes away.
-- merged_into_user_id TEXT REFERENCES users(id)  -- stubs only, after claim

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
  CHECK (kind IN ('group', 'group_member', 'friend')),
  CHECK (LENGTH(id) = 26),
  -- group + group_member need a group; friend does not.
  CHECK (
    (kind = 'friend' AND group_id IS NULL AND user_id IS NOT NULL)
    OR (kind = 'group' AND group_id IS NOT NULL AND user_id IS NULL)
    OR (kind = 'group_member' AND group_id IS NOT NULL AND user_id IS NOT NULL)
  )
) STRICT;
```

Existing `groups.invite_token` values migrate to `kind = 'group'` rows so
already-shared URLs can be redirected once, then the column dies.

---

## Guest chrome

A persistent banner (top or bottom): create an account to claim this identity.
The rest of the guest app is the existing group/friend/expense screens with
owner-only controls stripped. People picker is group members (or the owner, on
a friend link) — no "add a person".

---

## Phasing

### 0 — Schema and domain merge
`access_links`, drop recovery hashes and `invite_token`, `merged_into_user_id`.
`mergeExpenseParticipants` + `mergeUsers` in `src/domain/`, through the
existing expense writer. Tests: combine-shares keeps the invariant; equal
expense does not reshuffle cents; itemized becomes exact; self-friendship
dropped; `db:check` clean.

### 1 — Guest API
`/api/v1/guest/*`, bearer `link_` resolver, scoped reads/writes. Compat and
`/api/v1/sync/*` reject these tokens. Expiry and revoke tests.

### 2 — Two shells
Vite MPA, `/app` and `/guest` basenames, Hono static routing, network-only
guest SW, app PWA scope `/app/` (even before offline writes exist). Shared
components, guest does not import Dexie.

### 3 — Owner mint/revoke UI + emails
Group and friend screens. Email body is `/guest/l/:token`.

### 4 — Claim
Preview counts, confirm, merge. Banner on guest. Login-already-member
redirects to `/app`. `is_ghost = 0` cannot be acted as via link.

### 5 — Remove the old doors
Recovery-code login, `/accept/:code`, join-creates-a-ghost, `generateRecoveryCode`.
Redirects from old URLs for one release if any local data exists.

---

## Testing (minimum)

- Group link cannot read another group or a 1:1 expense the ghost is on.
- Friend link sees Alice↔owner expenses (including in groups) and not the
  owner's other friends.
- General picker re-pick; `is_ghost = 0` excluded; individual link auto-picks.
- Expired/revoked secret is 401 with no leftover access.
- Claim preview names overlapping expenses; confirm combines; invariant holds.
- Claim without a link token cannot merge a ghost.
- Guest 401 while offline is a needs-connection screen, not a cached ledger.
- `yarn db:check` after every merge test.

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
