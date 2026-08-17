import { Link } from "react-router-dom";

/**
 * Things Splitwise markets that this app does not do. Sourced from their
 * homepage, Pro page, and app-store feature lists. The right-hand column is
 * supposed to be the worse one.
 */
const MISSING: { feature: string; them: string; us: string }[] = [
  {
    feature: "Native iOS and Android apps",
    them: "Yes",
    us: "A website. You can put it on the home screen.",
  },
  {
    feature: "Splitwise Pay, Pay by Bank",
    them: "Yes, US",
    us: "We are not a bank.",
  },
  {
    feature: "PayPal, Venmo, Paytm",
    them: "Yes",
    us: "Record that you paid. The money still moves wherever you already send it.",
  },
  {
    feature: "Push notifications",
    them: "Yes",
    us: "None. Open the page.",
  },
  {
    feature: "Email when someone adds a bill",
    them: "Yes",
    us: "They can tell you. Or you can look.",
  },
  {
    feature: "Monthly email reports",
    them: "Yes",
    us: "No newsletter of who owes whom.",
  },
  {
    feature: "Receipt scanning",
    them: "Pro",
    us: "Type the number. Storing other people's photos is a product I don't want to run.",
  },
  {
    feature: "Charts and graphs",
    them: "Pro",
    us: "It's a ledger, not Mint.",
  },
  {
    feature: "Saved default splits",
    them: "Pro",
    us: "Set it each time.",
  },
  {
    feature: "Import from a credit card",
    them: "Pro, US",
    us: "Type it.",
  },
  {
    feature: "Comments on expenses",
    them: "Yes",
    us: "The group chat still exists.",
  },
  {
    feature: "Export to CSV",
    them: "Yes",
    us: "Not yet.",
  },
  {
    feature: "7+ languages",
    them: "Yes",
    us: "English.",
  },
  {
    feature: "Avatars and group cover photos",
    them: "Yes",
    us: "Names.",
  },
  {
    feature: "Someone to email when it breaks",
    them: "Yes",
    us: "A GitHub issue, if I see it.",
  },
];

/**
 * Logged-out landing page. The app chrome (sidebar, add-expense) is for people
 * who already have a session; this is the page that explains what the thing is.
 */
export function Home() {
  return (
    <div className="mkt">
      <section className="mkt-hero">
        <div className="mkt-hero-copy">
          <p className="mkt-kicker">Open source · Self-hosted · Free</p>
          <h1>Keep track of who paid for dinner.</h1>
          <p className="mkt-lede">
            SplitSmart is a Splitwise replacement you can run yourself. Groups,
            friends, one-off bills, 100+ currencies, and it still works on a
            plane with no signal. You don&apos;t need an account to settle a
            single trip, someone can just send you a link.
          </p>
          <div className="mkt-cta">
            <Link to="/login?register" className="mkt-btn">
              Create an account
            </Link>
            <Link to="/login" className="mkt-btn mkt-btn-ghost">
              Log in
            </Link>
          </div>
          <p className="mkt-fine">
            Or open a group invite link and pick a name. That&apos;s the whole
            signup.
          </p>
        </div>

        <div className="mkt-hero-visual" aria-hidden="true">
          <div className="mkt-receipt">
            <div className="mkt-receipt-head">
              <span>Ramen, Fukuoka</span>
              <span className="mkt-pill">Saved on this device</span>
            </div>
            <p className="mkt-receipt-meta">Itemised · 3 people · JPY</p>
            <ul className="mkt-receipt-lines">
              <li>
                <span>Tonkotsu ×2</span>
                <span className="amount">¥1,900</span>
              </li>
              <li>
                <span>Gyoza</span>
                <span className="amount">¥680</span>
              </li>
              <li>
                <span>Tax</span>
                <span className="amount">¥258</span>
              </li>
            </ul>
            <div className="mkt-receipt-total">
              <span>X paid</span>
              <span className="amount">¥2,838</span>
            </div>
            <div className="mkt-receipt-owe">
              <span>You owe X</span>
              <span className="amount negative">¥946</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-band" aria-label="Highlights">
        <div className="mkt-tiles">
          <article className="mkt-tile mkt-tile-accent">
            <h2>Works with no signal</h2>
            <p>
              Install it on your phone and add the dinner while you&apos;re
              still at the table, airplane mode and all. It writes to the device
              and syncs once you&apos;re back online.
            </p>
          </article>
          <article className="mkt-tile">
            <h2>No account for a one-off trip</h2>
            <p>
              Send people a group link. They join with a display name, no email
              and no password. Everyone gets a recovery code in case they need
              the same ledger on a second phone.
            </p>
          </article>
          <article className="mkt-tile">
            <h2>The API isn&apos;t paywalled</h2>
            <p>
              Bearer tokens for the native API, and it also speaks the basic
              Splitwise API shapes, so whatever you already pointed at Splitwise
              has a good chance of just working. The endpoints are in the{" "}
              <Link to="/docs" className="mkt-inline">
                API docs
              </Link>
              .
            </p>
          </article>
          <article className="mkt-tile mkt-tile-deep">
            <h2>Open source and free</h2>
            <p>
              The code is on{" "}
              <a
                href="https://github.com/cjx3711/splitsmart"
                target="_blank"
                rel="noreferrer"
                className="mkt-inline"
              >
                GitHub
              </a>
              , and this instance is free for now. Read the{" "}
              <Link to="/about" className="mkt-inline">
                about page
              </Link>{" "}
              before you trust it with anything you can&apos;t afford to lose.
            </p>
          </article>
        </div>
      </section>

      <section className="mkt-list-wrap">
        <div className="mkt-list-intro">
          <h2>What&apos;s in it</h2>
          <p className="muted">
            The same jobs Splitwise does, minus the upsell that shows up while
            you&apos;re adding a taxi.
          </p>
        </div>
        <ul className="mkt-checklist">
          <li>Groups, friends, and one-off expenses that belong to neither</li>
          <li>As many expenses a day as you want, because that&apos;s a strange thing to ration</li>
          <li>Six split types: equal, exact, percent, shares, adjustment, itemised</li>
          <li>Itemised bills, where each line has its own sharers and tax and tip get spread proportionally</li>
          <li>Settle up, with suggested transfers if the group wants to simplify</li>
          <li>100+ currencies, each its own ledger. Nothing is converted, and JPY isn&apos;t treated as cents</li>
          <li>A currency picker that puts the ones you actually use at the top</li>
          <li>An activity feed for the groups and expenses you&apos;re on</li>
          <li>Splitwise import, and your API key is used for the request and then dropped</li>
          <li>Installable as a PWA, and the ledger stays on the device</li>
          <li>A native JSON API, plus compatibility with the basic Splitwise API shapes</li>
        </ul>
      </section>

      <section className="mkt-compare" aria-labelledby="mkt-compare-heading">
        <div className="mkt-compare-intro">
          <h2 id="mkt-compare-heading">What we don&apos;t have</h2>
          <p className="muted">
            Splitwise has a company, two phone apps, and a payments product.
            This is a ledger. The column on the right is the honest one.
          </p>
        </div>
        <div className="mkt-compare-scroll">
          <table className="mkt-compare-table">
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Splitwise</th>
                <th scope="col">SplitSmart</th>
              </tr>
            </thead>
            <tbody>
              {MISSING.map((row) => (
                <tr key={row.feature}>
                  <th scope="row">{row.feature}</th>
                  <td className="mkt-compare-them">{row.them}</td>
                  <td className="mkt-compare-us">{row.us}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mkt-compare-foot muted">
          If any of those are the reason you use Splitwise, stay there. That is
          a real product with a team. This writes down who paid for dinner.
        </p>
      </section>

      <section className="mkt-close">
        <h2>That&apos;s the whole pitch.</h2>
        <p>
          The longer version of why this exists is on the{" "}
          <Link to="/about">about page</Link>, and the endpoints are in the{" "}
          <Link to="/docs">API docs</Link>. If you just want to split a bill,{" "}
          <Link to="/login?register">make an account</Link> or wait for someone
          to send you a group link.
        </p>
      </section>
    </div>
  );
}
