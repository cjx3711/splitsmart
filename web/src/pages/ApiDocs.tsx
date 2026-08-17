import { type ReactNode } from "react";
import { Link } from "react-router-dom";

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
        <Code>{`{ "email": "you@example.com", "password": "at-least-8", "firstName": "Alex",
  "lastName": "optional", "defaultCurrency": "USD" }`}</Code>
        <p>
          <code>201</code> with <code>{`{ user, emailVerified, verificationEmailSent }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/login" auth="public">
        <Code>{`{ "email": "you@example.com", "password": "…" }`}</Code>
        <p>
          <code>200</code> with <code>{`{ user }`}</code>. Ghosts cannot log in
          this way; they use a recovery code.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/auth/logout" auth="public">
        <p>Clears the session cookie. <code>{`{ ok: true }`}</code></p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/auth/me">
        <Code>{`{ "user": { "id": 1, "email": "you@example.com", "firstName": "Alex",
  "lastName": null, "isGhost": false, "defaultCurrency": "USD",
  "emailVerified": true, "needsEmailVerification": false } }`}</Code>
      </Endpoint>
      <Endpoint method="PATCH" path="/api/v1/auth/me">
        <Code>{`{ "defaultCurrency": "JPY" }`}</Code>
        <p>
          Sets the preferred currency (expense-entry default and display
          conversions). Must be a code from{" "}
          <code>GET /api/v1/categories/currencies</code>. Returns the same{" "}
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
          <code>groupType</code> is one of <code>home</code>, <code>trip</code>,{" "}
          <code>couple</code>, <code>event</code>, <code>project</code>,{" "}
          <code>other</code>. <code>201</code> with{" "}
          <code>{`{ group, inviteUrl }`}</code>.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/groups/:id">
        <p>
          <code>{`{ group, members, balances }`}</code>.{" "}
          <code>group.inviteUrl</code> is the join link; the raw token is not
          sent.
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
        <Code>{`{ "firstName": "Hubert", "lastName": "Lim", "email": "optional@example.com" }`}</Code>
        <p>
          Name alone is enough to track a debt. An email creates a ghost and
          sends (or returns) an invite. Ghosts cannot call this.
        </p>
      </Endpoint>
      <Endpoint method="GET" path="/api/v1/friends/:id" />
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
        <p>Every expense you are on, group and not.</p>
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

      <h3>Invites and guests</h3>
      <p>
        A group invite link creates a <em>ghost</em>: no email, no password,
        identity is the session plus a one-time recovery code. Anyone with the
        link can join and read that group&apos;s expenses.
      </p>
      <Endpoint method="GET" path="/api/v1/invite/:token/preview" auth="public">
        <p>
          Group name and member names. No money. So a scanner can tell it has
          the right link without seeing balances.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/invite/:token/join" auth="public">
        <Code>{`{ "displayName": "Alex" }`}</Code>
        <p>Creates a ghost (or adds the current user) and sets a session.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/invite/recover" auth="public">
        <Code>{`{ "recoveryCode": "K7M2-9QXR-4TWP" }`}</Code>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/invite/claim">
        <Code>{`{ "email": "you@example.com", "password": "at-least-8" }`}</Code>
        <p>Upgrade a ghost to a real account in place. Same user id, same debts.</p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/invite/groups/:groupId/rotate">
        <p>Mint a new invite token. Existing members stay; the old URL stops working.</p>
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
          <code>skipped[]</code> with reasons, and <code>nextOffset</code>.
        </p>
      </Endpoint>
      <Endpoint method="POST" path="/api/v1/import/run">
        <Code>{`{ "apiKey": "…", "maxPages": 50 }`}</Code>
        <p>Friends, groups, then expenses up to the page cap.</p>
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
