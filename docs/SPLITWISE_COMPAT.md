# Splitwise API compatibility

> ## BREAKING CHANGE: entity IDs are ULID strings, not integers
>
> `/api/sw/v3.0` is **not** byte-compatible with Splitwise for identifiers.
>
> `user.id`, `friend.id`, `expense.id`, `group_id`, `users[].user_id`,
> `users[].user.id`, `repayments.from` / `to`, and `created_by.id` are
> 26-character Crockford ULID **strings**
> (`"01ARZ3NDEKTSV4RRFFQ69G5FAV"`), not JSON numbers (`1`).
>
> **Category ids are unchanged.** They are still Splitwise's integers
> (`13` = Dining out). Money is still decimal strings (`"25.00"`). The rest
> of the response shape is still frozen.
>
> This is deliberate. Native primary keys are ULIDs, and a parallel integer
> `compat_id` is not stored. After a Splitwise import, the original integer
> lives only in `metadata.splitwise_id` and is **not** returned on this API.
>
> Existing Splitwise clients (including `splitwise-to-toshl`) that persist or
> compare ids as numbers **will not work** without changes. Pointing Toshl at
> SplitSmart after an import will treat every expense as new. That data loss
> is accepted.

The compat layer lives in `src/routes/compat/` and is mounted at
`/api/sw/v3.0`. Aside from the ID type break above, its wire format is
**frozen**. See CLAUDE.md rule 5.

Auth is `Authorization: Bearer <token>`, where the token is minted in Settings →
API tokens. Splitwise's own personal API keys work the same way, which is why no
OAuth flow is needed.

## Implemented endpoints

These are exactly the endpoints `splitwise-to-toshl` calls, verified against its
source.

### `GET /get_current_user`

```json
{ "user": { "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "first_name": "Alice", "last_name": "Anderson",
            "email": "alice@example.com", "default_currency": "USD", … } }
```

**Critical:** `user.id` and `user.email` must both be truthy. `useAccounts.tsx`
marks the account invalid otherwise. Ghost accounts have no email, so the
serializer synthesises `ghost-<ulid>@splitsmart.invalid`: `.invalid` is reserved
by RFC 2606 and can never resolve to a real mailbox. The suffix is the integer
compat id, not the native ULID, so the address stays short.

### `GET /get_friends`

```json
{ "friends": [ { "id": "01ARZ3NDEKTSV4RRFFQ69G5FBW", "first_name": "Bob", "last_name": "Brown",
                 "balance": [ { "currency_code": "USD", "amount": "15.00" } ] } ] }
```

`balance` is an **array**, one entry per currency, and currencies that net to
zero are omitted. Clients index into `balance[0]` and treat an empty array as
"settled up".

"Friends" is derived from shared groups and shared expenses rather than the
`friendships` table, so being added to a group immediately makes those
people visible with no extra step.

### `GET /get_friend/:id`

Same shape, wrapped in `{ "friend": … }`.

### `GET /get_categories`

```json
{ "categories": [ { "id": 1, "name": "Food and drink",
                    "subcategories": [ { "id": 7, "name": "Dining out" } ] } ] }
```

Two levels. Clients flatten to subcategories and use **only subcategory IDs** as
`category_id`.

✅ **Category IDs are Splitwise's real IDs.** Captured from the live API and
checked in at `fixtures/splitwise/get_categories.json`; `yarn db:seed` uses
them directly, so `category_id` is portable in both directions with no extra
step.

The ids could not have been guessed; they are non-sequential and parents and
children share **one** id space:

| Parent | ID | Example leaf | ID |
|---|---|---|---|
| Utilities | 1 | Electricity | 5 |
| Uncategorized | 2 | General | **18** (the default) |
| Entertainment | 19 | Games | 20 |
| Food and drink | 25 | Dining out | 13 |
| Home | 27 | Household supplies | 14 |
| Transportation | 31 | Bus/train | 32 |
| Life | 40 | Childcare | 50 |

7 parents, 43 leaves, ids 1–50. `src/db/categories.test.ts` diffs
`src/db/categories.ts` against the fixture on every run, so any rename or
renumber fails the build.

`yarn seed:splitwise` is only for refreshing from a **newer** export if
Splitwise ever changes the tree. It refuses to run once expenses reference
categories, since remapping would silently recategorise them.

### Currencies

168 currencies are seeded: the full active ISO 4217 list **plus** all 153 codes
Splitwise's live `get_currencies` returns. This is deliberate -
`expenses.currency_code` is a foreign key, so a missing currency does not
degrade gracefully, it rejects the expense.

That includes 11 codes Splitwise lists which are not active ISO 4217 currencies,
mostly demonetised ones its users still have history in: BYR, CUC, HRK, LTL,
SLL, STD, VEF, XCG, ZWL, plus BTC and the non-standard CMG. Omitting any of them
would make importing an expense denominated in it impossible.

`decimal_places` comes from ISO 4217 and is **never** taken from Splitwise -
their `get_currencies` returns only `currency_code` and `unit`, with no exponent
at all. BTC is the reason `migrations/001` allows up to 8 decimal places.

### `GET /get_expenses`

Params: `friend_id`, `group_id`, `dated_after`, `dated_before`, `limit`, `offset`.

```json
{ "expenses": [ {
  "id": "01ARZ3NDEKTSV4RRFFQ69G5FCX", "description": "Dinner", "cost": "30.00", "currency_code": "USD",
  "date": "2026-08-01T00:00:00Z", "deleted_at": null,
  "category": { "id": 13, "name": "Dining out" },
  "users": [ { "user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "user": { "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "first_name": "Alice" },
               "paid_share": "30.00", "owed_share": "15.00",
               "net_balance": "15.00" } ],
  "repayments": [ { "from": "01ARZ3NDEKTSV4RRFFQ69G5FBW", "to": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "amount": "15.00" } ]
} ] }
```

Shape details clients depend on:

| Field | Requirement |
|---|---|
| `cost`, `paid_share`, `owed_share` | decimal **strings**, not numbers |
| `date` | full ISO timestamp; clients do `date.split("T")[0]` |
| `category` | nested object; read as `e.category.name` |
| `users[].user_id` **and** `users[].user.id` | both present, same value |
| `deleted_at` | returned, **not** filtered; clients skip them themselves |

### `POST /create_expense`

Body uses Splitwise's flattened participant keys:

```json
{
  "cost": "20.00", "description": "Taxi", "date": "2026-08-05T00:00:00Z",
  "currency_code": "USD", "category_id": 13, "group_id": "01ARZ3NDEKTSV4RRFFQ69G5FDY",
  "users__0__user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "users__0__paid_share": "20.00", "users__0__owed_share": "10.00",
  "users__1__user_id": "01ARZ3NDEKTSV4RRFFQ69G5FBW", "users__1__paid_share": "0.00",  "users__1__owed_share": "10.00"
}
```

Indices need not be contiguous or ordered. Because explicit owed shares are
always supplied, this maps to the `exact` split type.

The compat layer has no notion of a split *type*, in either direction; the wire
format only ever carries per-person `paid_share` / `owed_share`, which is exactly
what SplitSmart stores in `expense_users`. So a native expense split by percent,
shares or an itemized bill serialises out here as ordinary owed shares and reads
correctly in any Splitwise client. Nothing needs adding, and per the frozen-wire
rule, nothing should be: do not surface `split_type` or `split_meta` on
`/api/sw/v3.0`, because real Splitwise never did.

Response: `{ "expenses": [ … ], "errors": {} }`.

**Deviation:** real Splitwise returns HTTP 200 with a populated `errors` object
on validation failure. We return a proper 4xx *and* the `errors` key. Clients
that check `res.ok` (which `splitwise-to-toshl` does) behave correctly, and the
status code is more useful.

## Not yet implemented

`get_groups`, `get_group/:id`, `create_group`, `add_user_to_group`,
`remove_user_from_group`, `get_expense/:id`, `update_expense/:id`,
`delete_expense/:id`, `get_currencies`, `get_comments`, `create_comment`,
`get_notifications`, OAuth2.

Priority order is in `docs/PLAN.md` phase 3.

## Pointing splitwise-to-toshl at this server

Its proxy target is hardcoded in `webapp/server.js`:

```js
target: process.env.SPLITWISE_API_URL || "https://secure.splitwise.com/api",
```

Set `SPLITWISE_API_URL=http://localhost:5545/api` and paste a SplitSmart API
token where the Splitwise key goes. That is the entire integration.

## Testing parity

`src/routes/compat/v3.test.ts` runs the real Hono app against a throwaway SQLite
file and asserts on field names and string formats, including zero-decimal
currencies (JPY must serialise as `"3000"`, never `"30.00"`).

When adding an endpoint, capture a **real Splitwise response while the API is
still free** and assert against it. Those fixtures are irreplaceable once access
closes.
