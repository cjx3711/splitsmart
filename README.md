# SplitSmart

A self-hosted Splitwise replacement with API compatibility, so existing Splitwise
clients keep working after pointing them at a different base URL.

## Why

Splitwise is moving API access behind a paywall. This keeps the data, the
splitting, and the API surface under your own control.

Two differences from Splitwise, both deliberate:

- **Group invite links.** Each group has a secret link. Anyone who opens it can
  join and create a guest account; no email, no password. One real account is
  enough for a whole group.
- **Self-hosted.** Single Node process, single SQLite file, one container.

## Quick start

```bash
yarn install
cp .env.example .env
```

Generate a session secret and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then:

```bash
yarn db:migrate && yarn db:seed
yarn dev
```

API on `http://localhost:5545`, frontend on `http://localhost:5173`.

## Demo data

To explore the UI with sample friends, groups, and expenses instead of an empty
account:

1. Register an account at `/login?register` (or use any email you prefer).
2. Seed demo data for that account:

```bash
yarn seed:demo                  # defaults to test@example.com
yarn seed:demo -- you@example.com
```

This creates ghost users, two groups (a Tokyo trip in JPY and a shared apartment
in USD), six expenses, and one settlement payment. It is idempotent: if the
account already has expenses, the script skips.

After `yarn db:reset`, register again and re-run `yarn seed:demo`.

## Export your Splitwise data first

This is the one step with a deadline. It writes raw, untransformed JSON to
`splitwise-export/<timestamp>/` and does not touch the database, so re-importing
after a schema change never needs another API call.

```bash
SPLITWISE_API_KEY=... yarn export:splitwise
```

Get a key from [secure.splitwise.com/apps](https://secure.splitwise.com/apps).
The output is gitignored; back it up somewhere private.

## Using it with splitwise-to-toshl

1. Settings → API tokens → create a token.
2. In `splitwise-to-toshl`, set the proxy target in `webapp/server.js`:

```bash
SPLITWISE_API_URL=http://localhost:5545/api
```

3. Paste the SplitSmart token where the Splitwise API key goes.

All six endpoints that app uses are implemented and tested. See
[docs/SPLITWISE_COMPAT.md](docs/SPLITWISE_COMPAT.md).

## Commands

```bash
yarn dev             # API + frontend with reload
yarn test            # split engine, money, auth, compat API
yarn typecheck       # server + web
yarn db:check        # audit data integrity
yarn db:reset        # wipe and rebuild locally
yarn seed:demo       # sample friends, groups, and expenses (see above)
yarn build           # production build
```

## Documentation

- **[CLAUDE.md](CLAUDE.md)**: how the repo works, and the five rules that keep
  financial data correct. Read this before changing anything.
- [docs/PLAN.md](docs/PLAN.md): roadmap toward full API parity
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md): schema reasoning
- [docs/SPLITWISE_COMPAT.md](docs/SPLITWISE_COMPAT.md): endpoint reference

## Status

Working: accounts, groups, invite links and guest accounts, equal-split expenses,
per-currency balances, settle-up suggestions, API tokens, and the six
Splitwise-compatible endpoints.

Not yet: expense editing UI, non-equal split UI, one-on-one expenses, the
Splitwise importer, email. See [docs/PLAN.md](docs/PLAN.md).

## License

Personal project. Not affiliated with Splitwise.
