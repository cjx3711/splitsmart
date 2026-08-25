import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { GROUP_TYPES } from "../../../src/domain/group-types.ts";

/**
 * Public reference for the HTTP API. Kept as a page rather than an OpenAPI
 * dump so the money rules stay next to the endpoints they apply to.
 */
export function ApiDocs() {
  return (
    <article className="mkt-prose mkt-docs">
      <h1>API</h1>
      <p>
        One HTTP API, at <code>/api/v1</code>. CamelCase JSON, integer minor
        units. This web app uses it; so can anything else that holds a bearer
        token.
      </p>
      <p>
        Mint a token under Settings → API tokens after you log in. Send it as{" "}
        <code>Authorization: Bearer &lt;token&gt;</code>. Cookie sessions work
        too; they are how the browser talks to itself.
      </p>
      <aside id="compat" className="docs-tombstone">
        <p>
          There used to be a second API at <code>/api/sw/v3.0</code> that
          copied Splitwise&apos;s v3.0 shapes so existing clients could keep
          working after changing only the base URL. Maintaining a frozen,
          ugly wire next to this one was a lot of work for a drop-in that an
          agent can recode against <code>/api/v1</code> in an afternoon. The
          shim is gone. This page is the API.
        </p>
      </aside>
      <nav className="docs-toc" aria-label="On this page">
        <a href="#auth">Auth</a>
        <a href="#money">Money</a>
        <a href="#native">Native API</a>
      </nav>

      <h2 id="auth">Auth</h2>
      <p>
        Two independent paths, both accepted by <code>requireAuth</code> on
        native routes:
      </p>
      <ul>
        <li>
          <strong>Session cookie</strong>: httpOnly, 30 days, set by{" "}
          <code>POST /api/v1/auth/login</code> and{" "}
          <code>POST /api/v1/auth/register</code>
        </li>
        <li>
          <strong>API token</strong>: long-lived, revocable, plaintext shown
          once at creation
        </li>
      </ul>
      <Endpoint method="POST" path="/api/v1/auth/signup" auth="public">
        <p>
          Start creating an account. Email-first: no user row is written yet.
        </p>
        <Code>{`{ "email": "you@example.com", "next": "/claim?link=…" }`}</Code>
        <p>
          <code>next</code> is optional: an in-app path to return to after the
          account exists (the claim flow). Open redirects are dropped.
        </p>
        <p>
          <code>200</code> with{" "}
          <code>{`{ ok, email, delivered, verifyUrl }`}</code>.{" "}
          <code>verifyUrl</code> is the complete-account link when{" "}
          <code>EMAIL_VERIFICATION_REQUIRED</code> is off (so a box with no
          mail provider can still finish). When that flag is on, the link is
          emailed and <code>verifyUrl</code> is <code>null</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/register" auth="public">
        <p>
          Finish creating an account from a signup token (the{" "}
          <code>/app/verify/:token</code> link) and open a session.
        </p>
        <Code>{`{ "token": "…", "password": "at-least-8", "name": "Alex Chen",
  "nickname": "Alex", "defaultCurrency": "USD" }`}</Code>
        <p>
          <code>nickname</code> is optional. The email comes from the token, not
          the body. <code>201</code> with{" "}
          <code>{`{ user, emailVerified, claimedImportedHistory }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/login" auth="public">
        <Code>{`{ "email": "you@example.com", "password": "…" }`}</Code>
        <p>
          <code>200</code> with <code>{`{ user }`}</code>. Placeholder people
          (ghosts) cannot log in at all; a guest link acts as them instead.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/password/forgot" auth="public">
        <Code>{`{ "email": "you@example.com" }`}</Code>
        <p>
          Always <code>200</code> with <code>{`{ ok: true }`}</code>, whether
          or not that address has an account. If it does, a 24-hour single-use
          link is emailed (or written to the server log when no mail provider
          is configured). The URL is never returned here: that would reveal
          whether the address exists.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/auth/password/reset/:token" auth="public">
        <p>
          Opens a reset link so the form can show which address it will change.
          Does not consume the token. <code>200</code> with{" "}
          <code>{`{ ok, email }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/password/reset/:token" auth="public">
        <Code>{`{ "password": "at-least-8" }`}</Code>
        <p>
          Writes the new hash, marks the address verified, ends every web
          session for that account, and opens a new one. API tokens stay.{" "}
          <code>200</code> with <code>{`{ user, emailVerified: true }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/logout" auth="public">
        <p>Clears the session cookie. <code>{`{ ok: true }`}</code></p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/auth/me">
        <Code>{`{ "user": { "id": "01ARZ…", "email": "you@example.com", "name": "Alex Chen",
  "nickname": null, "iconLetters": null, "iconEmoji": null, "iconHue": null, "iconPattern": null,
  "isGhost": false, "defaultCurrency": "USD",
  "emailVerified": true, "needsEmailVerification": false, "isAdmin": false } }`}</Code>
        <p>
          <code>isAdmin</code> is true when the account's email is listed in the
          server's <code>ADMIN_EMAILS</code> env var.
        </p>
      </Endpoint>
      <Endpoint method="PATCH" path="/api/v1/auth/me">
        <Code>{`{ "name": "Alex Chen", "nickname": "Alex", "iconLetters": "AC",
  "iconEmoji": null, "iconHue": 205, "iconPattern": { "base": { "h": 205, "s": 62, "l": 38, "a": 1 }, "layers": [] }, "defaultCurrency": "JPY" }`}</Code>
        <p>
          Any subset of those fields. Name, nickname, letters, emoji and the
          geometric pattern are how you look in the app; currency is the expense-entry default
          and display conversions. Letters are at most two graphemes; the pattern is a base
          colour plus up to ten bands (start/end percent, rotation, HSLA).{" "}
          <code>iconPattern: null</code> hashes a unique pattern from your id. Must be a currency
          from <code>GET /api/v1/categories/currencies</code>. Returns the same{" "}
          <code>{`{ user }`}</code> shape as GET. Does not convert any stored
          balances.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/auth/tokens">
        <p>
          Lists your tokens (id, name, timestamps). The secret is never
          returned again.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/tokens">
        <Code>{`{ "name": "toshl sync" }`}</Code>
        <p>
          <code>201</code> with <code>{`{ id, name, token }`}</code>. Store{" "}
          <code>token</code> now; it is the only time the plaintext exists.
        </p>
      </Endpoint>
      <Endpoint method="DELETE" path="/api/v1/auth/tokens/:id">
        <p>Revoke. <code>{`{ ok: true }`}</code></p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/delete">
        <Code>{`{ "confirm": "DELETE ACCOUNT" }`}</Code>
        <p>
          Closes this account. The confirmation phrase is required so a stray
          POST cannot do this. If another live real account still shares a group
          or an expense, the row becomes a placeholder (ghost) so their balances
          stay; <code>{`{ ok: true, convertedToGhost: true }`}</code>. Otherwise
          the ledger is wiped and the login is retired;{" "}
          <code>{`{ ok: true, convertedToGhost: false }`}</code>. Sessions and
          API tokens die either way. The session cookie is cleared.
        </p>
      </Endpoint>

      <h2 id="money">Money</h2>
      <p>
        Native amounts are <strong>integers in minor units</strong>, always
        paired with a <code>currencyCode</code>. <code>1000</code> is{" "}
        <code>10.00 USD</code> and also <code>1000 JPY</code>. Decimal places
        come from <code>GET /api/v1/categories/currencies</code>; do not
        assume 2. There is no exchange-rate table. Balances are arrays, one
        entry per currency that is not zero.
      </p>

      <h2 id="native">Native API</h2>
      <p>
        JSON in and out. Errors are <code>{`{ "error": "…" }`}</code> with a
        real status code. Unless noted, every route below needs a session or a
        bearer token.
      </p>

      <h3>Groups</h3>
      <Endpoint method="GET" path="/api/v1/groups">
        <p>
          <code>{`{ groups, totalBalance }`}</code>. <code>totalBalance</code>{" "}
          is <code>{`{ currencyCode, amountMinor }[]`}</code>, your net across
          every group, still per currency.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/groups">
        <Code>{`{ "name": "Kyushu 2025", "groupType": "trip",
  "defaultCurrency": "JPY", "simplifyByDefault": true }`}</Code>
        <p>
          <code>groupType</code> is one of{" "}
          {GROUP_TYPES.map((type, index) => (
            <span key={type}>
              {index > 0 && ", "}
              <code>{type}</code>
            </span>
          ))}
          . <code>201</code> with <code>{`{ group }`}</code>. Creating a group
          does not share it; mint a guest link when you mean to.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/groups/:id">
        <p>
          <code>{`{ group, members, balances, role }`}</code>. <code>role</code>{" "}
          is the caller&apos;s own; only an owner may mint or revoke links.
          Member nets are unsimplified; friend totals are what{" "}
          <code>simplify_by_default</code> changes.
        </p>
      </Endpoint>
      <Endpoint method="PATCH" path="/api/v1/groups/:id">
        <Code>{`{ "name": "Kyushu 2025", "groupType": "trip",
  "simplifyByDefault": true }`}</Code>
        <p>
          Any member. Fields are optional; omit one to leave it alone.{" "}
          <code>simplifyByDefault</code> turns Splitwise-style simplify-debts on
          or off for this group&apos;s contribution to friend totals. Nets on
          the group page do not change. New groups and imported Splitwise groups
          default on.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/groups/:id/members">
        <Code>{`{ "userId": "01ARZ…" }  or  { "name": "Jordan" }`}</Code>
        <p>
          Any member with an account. Adds an existing person, or creates a new
          placeholder. Opening a guest link does not create members, and a
          guest-link holder cannot add people.
        </p>
      </Endpoint>
      <Endpoint method="DELETE" path="/api/v1/groups/:id/members/:userId">
        <p>
          Soft removal (<code>left_at</code>), never a delete: what they are on
          is still owed. Their per-member guest link is revoked with it.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/groups/:id/settle">
        <p>
          Suggested transfers after simplify-debts, grouped by currency:{" "}
          <code>{`{ suggestions: [{ currencyCode, transfers }] }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/groups/:id/expenses">
        <p>Expenses in that group, each with <code>shares</code>.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/groups/:id/expenses">
        <p>Create an expense whose participants must be members of the group. Body is the expense shape below, without <code>groupId</code>.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/groups/:id/payments">
        <Code>{`{ "fromUserId": 2, "toUserId": 1, "amountMinor": 946,
  "currencyCode": "JPY", "date": "2026-08-17" }`}</Code>
        <p>
          Records a settle-up. <code>201</code> with <code>{`{ id }`}</code>.
        </p>
      </Endpoint>

      <h3>Friends</h3>
      <Endpoint method="GET" path="/api/v1/friends">
        <p>
          Everyone you share a group or an expense with, plus anyone you added
          explicitly. Each row has <code>balances</code> and a per-group{" "}
          <code>breakdown</code>. Groups with simplify on contribute simplified
          edges; one-on-one expenses stay pairwise. Each breakdown row has{" "}
          <code>simplified</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/friends">
        <Code>{`{ "name": "Hubert Lim", "email": "optional@example.com" }`}</Code>
        <p>
          Name alone is enough to track a debt. An optional email is stored as
          the invite address (never <code>users.email</code>) and the response
          includes a guest link to copy. Nothing is emailed until{" "}
          <code>POST /friends/:id/invite</code>. Ghosts cannot call this.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/friends/:id" />
      <Endpoint method="PATCH" path="/api/v1/friends/:id">
        <Code>{`{ "name": "Hubert", "nickname": "Hub", "iconLetters": null,
  "iconEmoji": "🦊", "iconHue": 32, "email": "optional@example.com" }`}</Code>
        <p>
          Same identity fields as <code>PATCH /api/v1/auth/me</code>, but only
          for placeholder people (ghosts) you are related to. A real account
          edits themselves. <code>email</code> writes the invite address
          (never <code>users.email</code>); it does not send mail. Empty string
          or <code>null</code> clears it. Guests cannot call this.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/friends/:id/invite">
        <p>
          Emails the live guest link to the placeholder&apos;s invite address.
          Add or change the address with <code>PATCH</code>; this is the only
          send. One send per friend per 24 hours, and 3 per account per UTC
          day; further calls are <code>429</code>. <code>400</code> if they
          have no email yet. Does not rotate the link.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/friends/:id/expenses" />
      <Endpoint method="POST" path="/api/v1/friends/:id/expenses">
        <p>One-on-one expense. Participants must be exactly the two of you.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/friends/:id/payments">
        <Code>{`{ "direction": "you_paid", "amountMinor": 1500,
  "currencyCode": "SGD", "date": "2026-08-17" }`}</Code>
        <p>
          <code>direction</code> is <code>you_paid</code> or{" "}
          <code>they_paid</code>.
        </p>
      </Endpoint>
      <Endpoint method="DELETE" path="/api/v1/friends/:id">
        <p>
          Removes an explicit friendship only. Response includes{" "}
          <code>stillVisible</code> if you still share a group or an expense.
        </p>
      </Endpoint>

      <h3>Expenses</h3>
      <p>This is the shape the web UI posts. Money is minor units.</p>
      <Code>{`{
  "description": "Ramen",
  "details": "optional notes, not a receipt",
  "costMinor": 2838,
  "currencyCode": "JPY",
  "date": "2026-08-17",
  "categoryId": 13,
  "groupId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "splitType": "equal",
  "participants": [
    { "userId": "01ARZ3NDEKTSV4RRFFQ69G5FAW", "paidMinor": 2838, "input": 1 },
    { "userId": "01ARZ3NDEKTSV4RRFFQ69G5FAX", "paidMinor": 0, "input": 1 }
  ]
}`}</Code>
      <p>
        <code>splitType</code> is <code>equal</code>, <code>exact</code>,{" "}
        <code>percent</code>, <code>shares</code>, <code>adjustment</code>, or{" "}
        <code>itemized</code>. <code>input</code> is the per-person figure the
        editor typed: minor units, a percent, or a share count, depending on
        type. For itemized splits, send <code>items</code> instead of relying
        on <code>input</code>:
      </p>
      <Code>{`{
  "splitType": "itemized",
  "costMinor": 2838,
  "items": [
    { "label": "Tonkotsu", "amountMinor": 1900, "participantIds": ["01ARZ3NDEKTSV4RRFFQ69G5FAW", "01ARZ3NDEKTSV4RRFFQ69G5FAX"] },
    { "label": "Gyoza", "amountMinor": 680, "participantIds": ["01ARZ3NDEKTSV4RRFFQ69G5FAW"] }
  ],
  "taxMinor": 258,
  "tipMinor": 0,
  "participants": [ /* paidMinor still required; input ignored */ ]
}`}</Code>
      <p>
        Paid-by and split are separate: <code>paidMinor</code> is who fronted
        the cash; the engine computes what each person owes. Both columns must
        sum to <code>costMinor</code> or the write is rejected.
      </p>
      <p>
        <code>extra</code> is a client-owned bag: an object up to 4 KB
        serialized, merged into the stored row rather than replacing it, so
        omitting it on a PATCH leaves whatever was there alone. It is meant for
        an external tool to stash its own identifiers or state on an expense
        without asking this API to model them. Every read (list and{" "}
        <code>GET /expenses/:id</code>) echoes it back as{" "}
        <code>extra</code>, and also includes{" "}
        <code>splitwise_id</code> - the original Splitwise integer on an
        imported row, <code>null</code> otherwise, and read-only: there is no
        way to set it over this API.
      </p>
      <Endpoint method="POST" path="/api/v1/expenses">
        <p>
          Create anywhere: a group, or no group. In a group, any current member
          may write, including a payment between two other members. A non-group
          expense requires you to be a participant, and may only include people
          you already share history with. <code>groupId</code> may be{" "}
          <code>null</code>. <code>201</code> with <code>{`{ id }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/expenses">
        <p>
          Every expense you are on, group and not. Filters, all optional and all
          shared with the group and friend listings and with the CSV export:{" "}
          <code>q</code> (description substring), <code>group_id</code> (a ULID,
          or <code>none</code> for expenses outside any group),{" "}
          <code>friend_id</code>, <code>dated_after</code>,{" "}
          <code>dated_before</code>, <code>category_id</code>,{" "}
          <code>is_payment</code>. A filter narrows what you can already see; it
          never widens it. Malformed values are ignored rather than rejected.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/expenses.csv">
        <p>
          The same rows and the same filters as above, as CSV: one row per
          expense, money as a decimal string with the currency in its own column.
          Guests have their own link-scoped{" "}
          <code>/api/v1/guest/expenses.csv</code>.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/export.zip">
        <p>
          A zip of CSV files for this account: profile, expenses, comments,
          groups, and people. No filters — everything you can see. Money in{" "}
          <code>expenses.csv</code> is the same decimal shape as the file above.
          Settings offers this as &quot;Download all data&quot;.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/expenses/currencies/frequent">
        <p>Currencies you have actually used, for the picker.</p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/expenses/:id">
        <p>
          Full row plus <code>shares</code> (including <code>split_input</code>{" "}
          so an editor can reopen the form).
        </p>
      </Endpoint>
      <Endpoint method="PATCH" path="/api/v1/expenses/:id">
        <p>Same body as create. Replaces the expense; does not patch fields.</p>
      </Endpoint>
      <Endpoint method="DELETE" path="/api/v1/expenses/:id">
        <p>Soft-delete. <code>{`{ ok: true }`}</code></p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/expenses/:id/restore">
        <p>
          Undoes a delete. You are on the bill, or you are currently in its
          group. Rebuilds the repayment cache, and is a no-op if the expense is
          already live.
        </p>
      </Endpoint>

      <h3>Recurring expenses</h3>
      <p>
        Send <code>repeatInterval</code> on a create or an edit to make an
        expense a <em>template</em>: <code>weekly</code>,{" "}
        <code>fortnightly</code>, <code>monthly</code> or <code>yearly</code>. A
        job in the same process then generates ordinary expenses from it, one per
        template per tick, each dated the day it was due and carrying{" "}
        <code>repeat_of</code>. The next fire date is derived from the expense's
        own date; there is no way to name it from the API.
      </p>
      <p>
        <strong>Three states, and they differ.</strong> Omitting{" "}
        <code>repeatInterval</code> leaves an existing schedule alone,{" "}
        <code>null</code> stops it, and a value sets it. Stopping remembers the
        interval so it can be turned back on; resuming starts from now and does
        not create the bills that were missed while it was stopped. Editing a
        template affects future bills only; deleting it stops the series and
        keeps the bills it already made. Guests cannot create or change a
        template.
      </p>

      <h3>Comments</h3>
      <p>
        Two kinds of row: <code>user</code>, which somebody typed, and{" "}
        <code>system</code>, generated when an expense is edited, deleted or
        restored. System rows cannot be written or deleted through the API by
        anyone; there is no <code>kind</code> field on the wire. Visibility is
        the same rule as <code>GET /api/v1/expenses/:id</code>, and failing it is
        a <code>404</code>.
      </p>
      <Endpoint method="GET" path="/api/v1/expenses/:id/comments">
        <p>
          The live thread, oldest first, each with{" "}
          <code>{`{ id, kind, content, createdAt, author }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/expenses/:id/comments">
        <Code>{`{ "content": "I paid the tip in cash" }`}</Code>
        <p>
          Empty or whitespace-only content is a <code>400</code>. An optional{" "}
          <code>id</code> may be a client-minted ULID; replaying it returns the
          existing comment rather than a second one.
        </p>
      </Endpoint>
      <Endpoint method="DELETE" path="/api/v1/comments/:id">
        <p>
          Soft-delete, author-only. Deleting twice is not an error. The list
          endpoints also carry a live <code>comment_count</code> per expense.
        </p>
      </Endpoint>

      <h3>Guest links</h3>
      <p>
        A guest link IS the credential. It is sent as{" "}
        <code>Authorization: Bearer link_&lt;secret&gt;</code>, it is re-checked
        on every request (so revoking is immediate), and it only ever reaches{" "}
        <code>/api/v1/guest/*</code>. The routes above reject it outright.
        Three kinds: <code>group</code> (pick any
        placeholder member, re-pickably), <code>group_member</code> (one person,
        no picker), and <code>friend</code> (one person, their groups plus your
        1:1 expenses with them).
      </p>
      <p>
        Guest links expire after 3 months by default. The URL is returned from
        mint and from list, so owners can copy it again. Minting the same slot
        rotates, which kills the old secret in the same transaction.
      </p>
      <Endpoint method="GET" path="/api/v1/links?groupId=…">
        <p>
          Live links with their URLs: <code>{`{ links }`}</code>. Also accepts{" "}
          <code>friendId</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/links">
        <Code>{`{ "kind": "group" | "group_member" | "friend",
  "groupId": "01ARZ…", "userId": "01ARZ…", "expiresAt": "…" }`}</Code>
        <p>
          <code>201</code> with <code>{`{ id, url, expiresAt }`}</code>.
          Replaces whatever live link held the same slot. Expiry defaults to 3
          months and cannot exceed it.
        </p>
      </Endpoint>
      <Endpoint method="DELETE" path="/api/v1/links/:id">
        <p>Revoke. Takes effect on the guest&apos;s next request.</p>
      </Endpoint>

      <h3>The guest API</h3>
      <p>
        Bearer <code>link_…</code> only. A general group link also sends{" "}
        <code>X-SplitSmart-Acting-As</code>, because there is no server-side
        guest state to remember the pick in. <code>401</code> means the link is
        finished; <code>409</code> means nobody has been picked yet.
      </p>
      <Endpoint method="GET" path="/api/v1/guest/session" auth="guest link">
        <p>
          What the link is, who it can act as, and where to land. Answers before
          a name is picked, so the picker has something to show.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/guest/expenses" auth="guest link">
        <p>Every expense in scope, and nothing outside it.</p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/guest/groups/:id" auth="guest link">
        <p>
          <code>{`{ group, members, balances, expenses }`}</code>, for a group
          the link covers. Any other id is a <code>404</code>.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/guest/friend" auth="guest link">
        <p>The 1:1 surface of a friend link. Absent on a group link.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/guest/expenses" auth="guest link">
        <p>
          Same body as <code>/api/v1/expenses</code>. Also{" "}
          <code>PATCH</code>, <code>DELETE</code>, and{" "}
          <code>/api/v1/guest/payments</code>. A <code>repeatInterval</code> is
          dropped rather than refused: the bill still lands, but a guest cannot
          start a series the owner cannot see coming. Nothing else: no route here
          creates a group, a person, or a link.
        </p>
      </Endpoint>
      <Endpoint
        method="GET"
        path="/api/v1/guest/expenses/:id/comments"
        auth="guest link"
      >
        <p>
          The thread on an expense in scope, plus <code>POST</code> to add one
          and <code>DELETE /api/v1/guest/comments/:id</code> to remove your own.
          A guest speaks as the person the link acts as. In a group the link
          covers, that is every bill, not only the ones they are named on. A
          group link still cannot reach a 1:1 expense.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/guest/expenses.csv" auth="guest link">
        <p>The rows in scope, as CSV. The link's scope, not the owner's.</p>
      </Endpoint>

      <h3>Claiming a placeholder</h3>
      <p>
        Create the account first, then claim. Both a session AND the link token
        are required: the token is what makes those placeholders claimable, so a
        logged-in caller without one cannot absorb a stranger.
      </p>
      <Endpoint method="POST" path="/api/v1/claim/candidates">
        <Code>{`{ "linkToken": "link_…" }`}</Code>
        <p>
          <code>{`{ status: "already_member" | "claimable" | "none", candidates }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/claim/preview">
        <Code>{`{ "linkToken": "link_…", "userId": "01ARZ…" }`}</Code>
        <p>
          Counts for the confirm dialog. Overlapping expenses have their shares{" "}
          <em>combined</em>, never re-split, so no money moves.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/claim">
        <p>Runs the merge, in one transaction. Links acting as them die.</p>
      </Endpoint>

      <h3>Everything else</h3>
      <Endpoint method="GET" path="/api/v1/activity">
        <p>
          Query: <code>limit</code> (max 200), <code>offset</code>. Events in
          groups you are in, plus expenses you are on.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/categories" auth="public">
        <p>The category tree. IDs are Splitwise&apos;s real IDs.</p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/categories/currencies" auth="public">
        <p>
          <code>{`{ currencies: [{ code, decimal_places, symbol, name }] }`}</code>
        </p>
      </Endpoint>

      <h3>Admin (usage and backups)</h3>
      <p>
        Operator-only. The caller's email must appear in{" "}
        <code>ADMIN_EMAILS</code> (comma-separated, case-insensitive). Empty
        means nobody. Usage endpoints return counts and a 30-day series only —
        never amounts, titles, friend names, or link secrets.{" "}
        <code>as_of=YYYY-MM-DD</code> pins the series window (UTC); missing or
        malformed falls back to today. Backup endpoints never return S3
        credentials; the access key is masked and the secret is a boolean.
      </p>
      <Endpoint method="GET" path="/api/v1/admin/users" auth="admin">
        <Code>{`{ "asOf": "2026-08-18",
  "users": [{ "id", "name", "email", "createdAt",
    "counts": { "expensesCreated", "expensesParticipated", "groups",
      "friends", "recurring", "guestLinks", "ghosts" },
    "series": [{ "date": "2026-07-20", "count": 0 }, "…"] }] }`}</Code>
        <p>
          Optional <code>q</code> (name/email substring) and{" "}
          <code>as_of</code>. Real accounts only; capped at 50.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/admin/users/:id" auth="admin">
        <p>Same shape for one user. <code>404</code> for ghosts or deleted.</p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/admin/backups" auth="admin">
        <p>
          Always <code>200</code> once authorised: redacted config, scheduler
          state, run history, and (when configured) bucket size. A missing S3
          config is data on this page, not an error.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/admin/backups" auth="admin">
        <p>
          Start a run now. Returns <code>202</code> immediately; the upload
          continues in the background. <code>?force=true</code> records an extra
          run that does not own the day. <code>409</code> if one is already
          running; <code>503</code> if backups are not configured.
        </p>
      </Endpoint>

      <Endpoint method="GET" path="/health" auth="public">
        <p>
          Liveness. <code>{`{ ok: true, version }`}</code>
        </p>
      </Endpoint>

      <h3>Splitwise import</h3>
      <p>
        Authenticated, ghosts forbidden. You send <em>your</em> Splitwise API
        key in the body of each request. It is used for that request and not
        stored. Prefer the paged steps for a large account;{" "}
        <code>/run</code> is the small-account shortcut.
      </p>
      <Endpoint method="GET" path="/api/v1/import/status">
        <p>What is already here. No key needed.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/preview">
        <Code>{`{ "apiKey": "…" }`}</Code>
        <p>Dry run. Names every email match before anything is written.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/friends">
        <p>Same body. Step 1.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/groups">
        <p>Step 2.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/expenses">
        <Code>{`{ "apiKey": "…", "offset": 0, "limit": 500 }`}</Code>
        <p>
          One page. Returns <code>imported</code>, <code>alreadyPresent</code>,{" "}
          <code>refreshed</code>, <code>commentsImported</code>,{" "}
          <code>skipped[]</code> with reasons, <code>warnings[]</code> for
          amounts whose extra digits were dropped, <code>pausedSeries[]</code>{" "}
          for newly imported repeating bills (landed stopped), and{" "}
          <code>nextOffset</code>. An
          expense that changed in Splitwise is refreshed only when nothing has
          edited the local row since import; otherwise it is skipped as{" "}
          <code>local edits, not refreshed</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/comments">
        <Code>{`{ "apiKey": "…", "offset": 0, "limit": 25 }`}</Code>
        <p>
          Step 4, after expenses, because a comment references one. Only expenses
          Splitwise reported a <code>comments_count</code> for (and did not nest
          the thread on the list) are a request; the count is stamped as pending
          metadata and removed once fetched, so a second run is a no-op.{" "}
          <code>limit</code> is at most 25. <code>offset</code> is ignored: the
          pending set shrinks as rows finish. Returns <code>total</code> (how
          many imported expenses still need a fetch, including this page).
          Splitwise&apos;s automatic <em>System</em> comments are imported too -
          they are the only edit history it will hand over.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/rounding">
        <Code>{`{ "apiKey": "…" }`}</Code>
        <p>
          Step 5. Compares Splitwise <code>get_friends</code> totals with ours
          and records a one-on-one settle-up for leftover cents (at most 100
          minor units per friend per currency) from digits dropped on import.
          Each payment gets a system comment explaining why. Larger gaps are
          listed in <code>skipped[]</code> rather than settled. Re-running is a
          no-op once the totals match.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/run">
        <Code>{`{ "apiKey": "…", "maxPages": 50 }`}</Code>
        <p>Friends, groups, expenses up to the page cap, comments, then rounding.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/continue-recurring">
        <Code>{`{ "ids": ["01…"] }`}</Code>
        <p>
          Resume stopped series that import landed from Splitwise repeating
          bills. Starts from today; does not create months that already
          happened. No API key: the rows are already here.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/wipe">
        <Code>{`{ "confirm": "DELETE ALL DATA" }`}</Code>
        <p>
          Hard-delete this account&apos;s groups, friends, expenses, comments
          and placeholder people so a Splitwise import can run on an empty book.
          The account itself stays. Refuses with <code>409</code> if another
          live account shares a group or expense with you. The confirmation
          phrase is required; a stray POST is not enough.
        </p>
      </Endpoint>

      <p>
        <Link to="/about">About this instance</Link>
        {" · "}
        <Link to="/changelog">Changelog</Link>
        {" · "}
        <Link to="/">Home</Link>
      </p>
    </article>
  );
}

function Endpoint({
  method,
  path,
  auth = "session or bearer",
  children,
}: {
  method: string;
  path: string;
  auth?: string;
  children?: ReactNode;
}) {
  return (
    <section className="docs-endpoint">
      <h4>
        <span className={`docs-method docs-method-${method.toLowerCase()}`}>{method}</span>
        <code>{path}</code>
      </h4>
      <p className="docs-auth">{auth}</p>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="docs-pre">
      <code>{children}</code>
    </pre>
  );
}
