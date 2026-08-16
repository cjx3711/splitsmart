# Splitwise API compatibility

The compat layer lives in `src/routes/compat/` and is mounted at both
`/api/v3.0` and `/v3.0`. Its wire format is **frozen** — see CLAUDE.md rule 5.

Auth is `Authorization: Bearer <token>`, where the token is minted in Settings →
API tokens. Splitwise's own personal API keys work the same way, which is why no
OAuth flow is needed.

## Implemented endpoints

These are exactly the endpoints `splitwise-to-toshl` calls, verified against its
source.

### `GET /get_current_user`

```json
{ "user": { "id": 1, "first_name": "Alice", "last_name": "Anderson",
            "email": "alice@example.com", "default_currency": "USD", … } }
```

**Critical:** `user.id` and `user.email` must both be truthy. `useAccounts.tsx`
marks the account invalid otherwise. Ghost accounts have no email, so the
serializer synthesises `ghost-<id>@splitsmart.invalid` — `.invalid` is reserved
by RFC 2606 and can never resolve to a real mailbox.

### `GET /get_friends`

```json
{ "friends": [ { "id": 2, "first_name": "Bob", "last_name": "Brown",
                 "balance": [ { "currency_code": "USD", "amount": "15.00" } ] } ] }
```

`balance` is an **array**, one entry per currency, and currencies that net to
zero are omitted. Clients index into `balance[0]` and treat an empty array as
"settled up".

"Friends" is derived from shared groups and shared expenses rather than the
`friendships` table, so joining a group by invite link immediately makes those
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

⚠️ Seeded category IDs are **ours**, not Splitwise's. For real ID parity, re-seed
from a live `get_categories` response during import (Phase 5).

### `GET /get_expenses`

Params: `friend_id`, `group_id`, `dated_after`, `dated_before`, `limit`, `offset`.

```json
{ "expenses": [ {
  "id": 1, "description": "Dinner", "cost": "30.00", "currency_code": "USD",
  "date": "2026-08-01T00:00:00Z", "deleted_at": null,
  "category": { "id": 7, "name": "Dining out" },
  "users": [ { "user_id": 1, "user": { "id": 1, "first_name": "Alice" },
               "paid_share": "30.00", "owed_share": "15.00",
               "net_balance": "15.00" } ],
  "repayments": [ { "from": 2, "to": 1, "amount": "15.00" } ]
} ] }
```

Shape details clients depend on:

| Field | Requirement |
|---|---|
| `cost`, `paid_share`, `owed_share` | decimal **strings**, not numbers |
| `date` | full ISO timestamp — clients do `date.split("T")[0]` |
| `category` | nested object; read as `e.category.name` |
| `users[].user_id` **and** `users[].user.id` | both present, same value |
| `deleted_at` | returned, **not** filtered — clients skip them themselves |

### `POST /create_expense`

Body uses Splitwise's flattened participant keys:

```json
{
  "cost": "20.00", "description": "Taxi", "date": "2026-08-05T00:00:00Z",
  "currency_code": "USD", "category_id": 7, "group_id": 1,
  "users__0__user_id": 1, "users__0__paid_share": "20.00", "users__0__owed_share": "10.00",
  "users__1__user_id": 2, "users__1__paid_share": "0.00",  "users__1__owed_share": "10.00"
}
```

Indices need not be contiguous or ordered. Because explicit owed shares are
always supplied, this maps to the `exact` split type.

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
file and asserts on field names and string formats — including zero-decimal
currencies (JPY must serialise as `"3000"`, never `"30.00"`).

When adding an endpoint, capture a **real Splitwise response while the API is
still free** and assert against it. Those fixtures are irreplaceable once access
closes.
