# Security

SplitSmart is self-hosted software that holds financial records. This document
describes how it handles credentials and access, and which parts of running it
safely belong to you as the operator.

## Reporting

Please report security issues **privately**, not as a public issue.

Use GitHub's private vulnerability reporting: the **Security** tab on this
repository, then **Report a vulnerability**. That opens a private thread with
the maintainer.

Include what you did, what happened, and the version or commit you were on.
Please don't test against anyone else's instance - run your own, which takes
one `docker run`.

This is a personal project maintained in spare time. There is no SLA and no
bounty. Reports are read and taken seriously, but a fix may take a while.

## Supported versions

Only the latest commit on `main`. There are no maintenance branches and no
backports; the project is pre-1.0 (`0.2.x`) and the schema still changes.
Fixes land on `main` and are picked up on your next deploy.

## Credentials and sessions

**Passwords** are hashed with scrypt from `node:crypto` at the OWASP-recommended
parameters (N=2^17, r=8, p=1, roughly 200ms per hash). Hashes are
self-describing - `scrypt$N$r$p$salt$hash` - so the cost can be raised later
without a migration: `needsRehash()` upgrades a hash transparently on the next
successful login. Comparison is `timingSafeEqual`, and input is NFKC-normalised
so the same typed password verifies across platforms. Only the hash is stored.

**Web sessions** are an httpOnly cookie, `SameSite=Lax`, `Secure` when
`NODE_ENV=production`, scoped to `/`, expiring after 30 days.

**API tokens** are a separate credential: a bearer header, long-lived,
revocable per token from Settings. They exist so external tools never need your
password.

Both session and API tokens are stored as SHA-256 hashes rather than scrypt.
That is deliberate and not a shortcut: these are full-entropy random values, so
a slow KDF would add latency to every single request while adding nothing
against an attacker who cannot guess 256 bits anyway. Passwords are the case
that needs scrypt, because humans choose them.

**Password reset** consumes a single-use token, expires it after 24 hours,
stores only its hash, and supersedes any outstanding token of the same purpose.
Completing a reset ends every web session for that account. API tokens are a
separate credential and deliberately survive - revoke them individually if you
need to. Requests to start a reset always return the same response, so the
wording cannot be used to tell whether an address has an account.

Signup is rate-limited: 60 seconds between starts for one address, and 20
starts per IP per hour.

## Guest links

Guest links let someone use a group without an account. Understand what one
grants before you send it.

A link is a secret held by whoever has the URL, sent as
`Authorization: Bearer link_<secret>`, and **re-resolved on every request** -
which is what makes revocation take effect immediately rather than at the end
of a session. Opening a link does not create an account.

Within its scope, a link grants **read and write**: the holder can record and
edit expenses as the person the link represents. It is the equivalent of handing
someone the shared notebook, so treat the URL as the credential it is. Revoking
is instant, but it cannot un-share what has already been seen. Mint, rotate, and
revoke links from the group's share panel.

Guest access is confined by construction, not by convention:

- Guest secrets are **rejected** by the normal auth middleware rather than
  ignored, so a link can never reach `/api/v1`. Guests are served only by
  `/api/v1/guest/*`.
- There is deliberately no route under `/api/v1/guest/*` that mints a link,
  adds a person, or creates a group. A link cannot widen its own scope.
- Guest visibility is *stricter* than a logged-in member's: a link holder sees
  bills they are a participant of, not everything in the group.

Accounts created for people who have not signed up hold no credential of their
own and cannot log in.

## Data handling

**No file uploads.** There is no upload endpoint, no multipart parsing, no image
handling, and no object storage for user content. Nothing accepts a file, so
nothing serves untrusted bytes back. This is a deliberate design constraint, not
an omission.

**Your Splitwise API key is never stored.** Importing is per-user: the key
arrives in the body of each import request, is used for that request, and is
dropped. There is no environment variable, column, cache, or background job
holding it, which means a database dump of this app contains no credential to
anyone's Splitwise account.

**No telemetry.** No analytics, no phone-home, no third-party scripts. The
committed `web/public/telemetry.js` is a no-op stub. The only outbound requests
the app makes are to services you configure yourself: your mail provider, your
S3-compatible backup target, Splitwise during an import you start, and a public
exchange-rate API for the optional display-only currency estimate.

**Requests for records you cannot see return 404, not 403**, so a response
cannot be used to confirm that an expense exists.

**Admin access** is granted by the `ADMIN_EMAILS` environment variable, not by a
database role, and defaults to empty - nobody. It gates usage counts and backup
status only.

## Your responsibilities as operator

Self-hosting means these are yours, and the application cannot do them for you:

- **Terminate TLS.** The container speaks plain HTTP on port 5545 and expects to
  sit behind a reverse proxy. Do not expose that port to the internet directly.
  See [scripts/deploy/nginx.conf.example](scripts/deploy/nginx.conf.example).
  The production image sets `NODE_ENV=production`, so the session cookie carries
  its `Secure` flag on any normal deploy.
- **Generate a strong `SESSION_SECRET`.** Required, minimum 32 characters, no
  default - the server refuses to boot without one. Use the command in
  `.env.example`. Changing it logs everybody out.
- **Protect the env file.** It holds the session secret and any mail or backup
  credentials. The deploy scripts install it outside the deploy and data
  directories as `root:root`, mode 600, and it is never baked into the image or
  committed. Keep it that way.
- **Guard the database file.** `data/splitsmart.db` is the entire ledger in
  plaintext SQLite. There is no application-level encryption at rest; use disk
  encryption if you need it, and keep backups somewhere private.
- **Keep the host patched** and keep your Node and image base up to date.
- **Think before enabling `EMAIL_VERIFICATION_REQUIRED=true`.** Combined with a
  broken mail configuration it locks everyone out, including you. The recovery
  path needs filesystem access to the server: `yarn verify:user -- you@example.com`.

## Scope

In scope: this repository. Out of scope: your reverse proxy, your host, your
mail or storage provider, and Splitwise's own API.
