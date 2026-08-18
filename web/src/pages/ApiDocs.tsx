import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { GROUP_TYPES } from "../../../src/domain/group-types.ts";

/**
 * Public reference for the two HTTP APIs. Kept as a page rather than an
 * OpenAPI dump so the money rules and the frozen compat quirks stay next to
 * the endpoints they apply to.
 */
export function ApiDocs() {
  return (
    <article className="mkt-prose mkt-docs">
      <h1>API</h1>
      <p>
        SplitSmart speaks two HTTP APIs from the same process. The native one
        is what this web app uses. The Splitwise-compatible one exists so
        existing clients can keep working after changing only the base URL.
      </p>
      <ul>
        <li>
          Native: <code>/api/v1</code>, camelCase JSON, integer minor units
        </li>
        <li>
          Compat: <code>/api/sw/v3.0</code>, Splitwise v3.0 wire format,
          decimal strings
        </li>
      </ul>
      <p>
        Mint a token in Settings after you log in. Send it as{" "}
        <code>Authorization: Bearer &lt;token&gt;</code>. Cookie sessions work
        on the native API too; they are how the browser talks to itself. The
        compat API is bearer-only.
      </p>
      <nav className="docs-toc" aria-label="On this page">
        <a href="#auth">Auth</a>
        <a href="#money">Money</a>
        <a href="#native">Native API</a>
        <a href="#compat">Compat API</a>
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
      <Endpoint method="POST" path="/api/v1/auth/register" auth="public">
        <p>Create an account and a session.</p>
        <Code>{`{ "email": "you@example.com", "password": "at-least-8", "name": "Alex Chen",
  "nickname": "Alex", "defaultCurrency": "USD" }`}</Code>
        <p>
          <code>nickname</code> is optional. <code>201</code> with{" "}
          <code>{`{ user, emailVerified, verificationEmailSent }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/login" auth="public">
        <Code>{`{ "email": "you@example.com", "password": "…" }`}</Code>
        <p>
          <code>200</code> with <code>{`{ user }`}</code>. Placeholder people
          (ghosts) cannot log in at all; a guest link acts as them instead.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/logout" auth="public">
        <p>Clears the session cookie. <code>{`{ ok: true }`}</code></p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/auth/me">
        <Code>{`{ "user": { "id": "01ARZ…", "email": "you@example.com", "name": "Alex Chen",
  "nickname": null, "iconLetters": null, "iconEmoji": null, "iconHue": null,
  "isGhost": false, "defaultCurrency": "USD",
  "emailVerified": true, "needsEmailVerification": false } }`}</Code>
      </Endpoint>
      <Endpoint method="PATCH" path="/api/v1/auth/me">
        <Code>{`{ "name": "Alex Chen", "nickname": "Alex", "iconLetters": "AC",
  "iconEmoji": null, "iconHue": 205, "defaultCurrency": "JPY" }`}</Code>
        <p>
          Any subset of those fields. Name, nickname, letters, emoji and hue
          are how you look in the app; currency is the expense-entry default
          and display conversions. Letters are at most two graphemes; hue is
          0–359 or <code>null</code> (hashed from your id). Must be a currency
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

      <h2 id="money">Money</h2>
      <p>
        Native amounts are <strong>integers in minor units</strong>, always
        paired with a <code>currencyCode</code>. <code>1000</code> is{" "}
        <code>10.00 USD</code> and also <code>1000 JPY</code>. Decimal places
        come from <code>GET /api/v1/categories/currencies</code>; do not
        assume 2. There is no exchange-rate table. Balances are arrays, one
        entry per currency that is not zero.
      </p>
      <p>
        The compat API is the opposite on purpose: money is a decimal{" "}
        <em>string</em> (<code>"25.00"</code>, or <code>"3000"</code> for JPY)
        so Splitwise clients keep parsing what they already parse.
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
  "defaultCurrency": "JPY", "simplifyByDefault": false }`}</Code>
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
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/groups/:id/members">
        <Code>{`{ "userId": "01ARZ…" }  or  { "name": "Jordan" }`}</Code>
        <p>
          Adds an existing person, or creates a new placeholder. Opening a link
          does not create members; someone with an account puts them there.
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
          <code>breakdown</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/friends">
        <Code>{`{ "name": "Hubert Lim", "email": "optional@example.com" }`}</Code>
        <p>
          Name alone is enough to track a debt. An email creates a ghost and
          sends (or returns) an invite. Ghosts cannot call this.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/friends/:id" />
      <Endpoint method="PATCH" path="/api/v1/friends/:id">
        <Code>{`{ "name": "Hubert", "nickname": "Hub", "iconLetters": null,
  "iconEmoji": "🦊", "iconHue": 32 }`}</Code>
        <p>
          Same identity fields as <code>PATCH /api/v1/auth/me</code>, but only
          for placeholder people (ghosts) you are related to. A real account
          edits themselves. Guests cannot call this.
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
      <Endpoint method="POST" path="/api/v1/expenses">
        <p>
          Create anywhere: a group, or no group. You must be a participant. A
          non-group expense may only include people you already share history
          with. <code>groupId</code> may be <code>null</code>.{" "}
          <code>201</code> with <code>{`{ id }`}</code>.
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
          Undoes a delete. Participant-only, rebuilds the repayment cache, and is
          a no-op if the expense is already live.
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
        <code>/api/v1/guest/*</code>. The routes above and the Splitwise compat
        API reject it outright. Three kinds: <code>group</code> (pick any
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
          A guest speaks as the person the link acts as. Guest visibility is
          stricter than the logged-in rule: it needs you to be a participant of
          that bill, not merely in its group.
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
        <Code>{`{ "apiKey": "…", "offset": 0, "limit": 100 }`}</Code>
        <p>
          One page. Returns <code>imported</code>, <code>alreadyPresent</code>,{" "}
          <code>refreshed</code>, <code>commentsImported</code>,{" "}
          <code>skipped[]</code> with reasons, and <code>nextOffset</code>. An
          expense that changed in Splitwise is refreshed only when nothing has
          edited the local row since import; otherwise it is skipped as{" "}
          <code>local edits, not refreshed</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/comments">
        <Code>{`{ "apiKey": "…", "offset": 0, "limit": 25 }`}</Code>
        <p>
          Step 4, after expenses, because a comment references one. Cheap and safe
          to call either way: when Splitwise nests comments on the expenses page
          they are already in, and each expense is stamped once fetched so a
          second run does not ask again. Splitwise's automatic{" "}
          <em>System</em> comments are imported too - they are the only edit
          history it will hand over.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/run">
        <Code>{`{ "apiKey": "…", "maxPages": 50 }`}</Code>
        <p>Friends, groups, expenses up to the page cap, then comments.</p>
      </Endpoint>

      <h2 id="compat">Compat API</h2>
      <p>
        Base URL: <code>/api/sw/v3.0</code>. Bearer token required. The wire
        format is frozen: money as decimal strings, flattened{" "}
        <code>users__0__paid_share</code> keys on create, <code>deleted_at</code>{" "}
        tombstones returned rather than filtered, and both{" "}
        <code>user_id</code> and nested <code>user.id</code> on participants.
        Do not expect native fields such as <code>splitType</code> here -
        Splitwise never had them.
      </p>
      <p>Implemented:</p>
      <ul>
        <li>
          <code>GET /get_current_user</code>
        </li>
        <li>
          <code>GET /get_friends</code> / <code>GET /get_friend/:id</code>
        </li>
        <li>
          <code>GET /get_categories</code>
        </li>
        <li>
          <code>GET /get_expenses</code>
        </li>
        <li>
          <code>POST /create_expense</code>
        </li>
      </ul>
      <p>
        Point a client such as <code>splitwise-to-toshl</code> at{" "}
        <code>https://&lt;host&gt;/api</code> and paste a SplitSmart token
        where the Splitwise key went. Groups, comments, notifications, and
        OAuth2 are not implemented yet.
      </p>
      <p>
        <Link to="/about">About this instance</Link>
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
