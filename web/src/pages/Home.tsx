import { Link } from "react-router-dom";

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
          <h1>Less arguing about who paid for dinner.</h1>
          <p className="mkt-lede">
            SplitSmart is a Splitwise replacement you can run yourself. Track
            shared expenses with housemates, trips, and friends, including on a
            plane with no signal. No account required to settle a one-off group.
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
            Or open a group invite link and pick a name. That is the whole signup.
          </p>
        </div>

        <div className="mkt-hero-visual" aria-hidden="true">
          <div className="mkt-receipt">
            <div className="mkt-receipt-head">
              <span>Ramen, Fukuoka</span>
              <span className="mkt-pill">Saved on this device</span>
            </div>
            <p className="mkt-receipt-meta">Itemized · 3 people · JPY</p>
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
              <span>Jia paid</span>
              <span className="amount">¥2,838</span>
            </div>
            <div className="mkt-receipt-owe">
              <span>You owe Jia</span>
              <span className="amount negative">¥946</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-band" aria-label="Highlights">
        <div className="mkt-tiles">
          <article className="mkt-tile mkt-tile-accent">
            <h2>Works without a signal</h2>
            <p>
              Install it on your phone. Add the dinner while you are still at the
              table, even in airplane mode. It writes locally and syncs when you
              are back online.
            </p>
          </article>
          <article className="mkt-tile">
            <h2>No account for a one-off trip</h2>
            <p>
              Share a group link. People join with a display name; no email, no
              password. They get a recovery code if they need the same ledger on
              another phone.
            </p>
          </article>
          <article className="mkt-tile">
            <h2>A real API, not a locked garden</h2>
            <p>
              Bearer tokens for the native API, plus a Splitwise-compatible
              surface so tools you already pointed at Splitwise can keep working.
              See the{" "}
              <Link to="/docs" className="mkt-inline">
                API docs
              </Link>
              .
            </p>
          </article>
          <article className="mkt-tile mkt-tile-deep">
            <h2>Open source, free to use</h2>
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
              . This instance is free for now. Read the{" "}
              <Link to="/about" className="mkt-inline">
                about page
              </Link>{" "}
              before you trust it with anything you cannot afford to lose.
            </p>
          </article>
        </div>
      </section>

      <section className="mkt-list-wrap">
        <div className="mkt-list-intro">
          <h2>What it actually does</h2>
          <p className="muted">
            The same jobs Splitwise is for, without a Pro upsell in the middle
            of adding a taxi.
          </p>
        </div>
        <ul className="mkt-checklist">
          <li>Groups, friends, and one-off expenses with no group at all</li>
          <li>Six split types: equal, exact, percent, shares, adjustment, itemized</li>
          <li>Itemized bills with per-line sharers and proportional tax and tip</li>
          <li>Settle up, with suggested transfers so the group can simplify</li>
          <li>168 currencies as parallel ledgers; JPY is not treated as cents</li>
          <li>A currency picker that remembers what you actually use</li>
          <li>Activity feed for the groups and expenses you are on</li>
          <li>Import your Splitwise history without storing the API key</li>
          <li>Installable offline PWA; the ledger stays on the device</li>
          <li>Native JSON API and a Splitwise v3.0-compatible shim</li>
        </ul>
      </section>

      <section className="mkt-close">
        <h2>Built because the alternative started charging rent on a spreadsheet.</h2>
        <p>
          The full story is on the{" "}
          <Link to="/about">about page</Link>. The endpoints are on the{" "}
          <Link to="/docs">API docs</Link>. If you just want to split a bill,{" "}
          <Link to="/login?register">make an account</Link> or wait for someone
          to send you a group link.
        </p>
      </section>
    </div>
  );
}
