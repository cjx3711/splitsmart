import { Link } from "react-router-dom";
import { HomeGallery } from "../HomeGallery.tsx";
import { Avatar } from "../Avatar.tsx";
import { useHasLocalAccount } from "../lastUser.ts";

/** Core Splitwise jobs this app also does. The other column is the point. */
const SAME_AS_SPLITWISE = [
  "Groups, friends, and one-off expenses",
  "Six split types: equal, exact, percent, shares, adjustment, itemised",
  "Settle up, with suggested transfers if the group wants to simplify",
  "An activity feed for the groups and expenses you're on",
  "Offline support",
  "100+ currencies",
];

/**
 * The reasons to switch, mostly small and specific. Display ≈ estimates and
 * convert-balance write real payments; the ledger still does not invent a
 * combined total on its own.
 */
const IMPROVEMENTS = [
  "As many expenses a day as you want",
  "Clicking just outside the add-expense box doesn't dump the draft",
  "Currencies with no decimals don't show any, so 3000 JPY is 3000 JPY, not 3000.00",
  "Mixed balances show a live ≈ estimate, and you can convert them into your default currency at today's rate",
  "A currency picker that puts the ones you frequently use at the top",
  "Free API for scripts or AI agents",
];

/**
 * Things Splitwise markets that this app does not do. Sourced from their
 * homepage, Pro page, and app-store feature lists. The right-hand column is
 * supposed to be the worse one.
 */
const MISSING: { feature: string; them: string; us: string }[] = [
  {
    feature: "Native iOS and Android apps",
    them: "Yes",
    us: "Just a the webapp. You can put it on the home screen.",
  },
  {
    feature: "Splitwise Pay, Pay by Bank",
    them: "Yes, US only",
    us: "Nope",
  },
  {
    feature: "PayPal, Venmo, Paytm",
    them: "Yes",
    us: "Nope",
  },
  {
    feature: "Push notifications",
    them: "Yes",
    us: "None",
  },
  {
    feature: "Email when someone adds a bill",
    them: "Yes",
    us: "They can tell you. Or you can look.",
  },
  {
    feature: "Monthly email reports",
    them: "Yes",
    us: "Nope",
  },
  {
    feature: "Receipt scanning",
    them: "Pro",
    us: "Nope, but maybe in the future with a MCP",
  },
  {
    feature: "Charts and graphs",
    them: "Pro",
    us: "Maybe in the future.",
  },
  {
    feature: "Saved default splits",
    them: "Pro",
    us: "Nope",
  },
  {
    feature: "Import from a credit card",
    them: "Pro, US",
    us: "Type it.",
  },
  {
    feature: "7+ languages",
    them: "Yes",
    us: "English + browser translation.",
  },
  {
    feature: "Avatars and group cover photos",
    them: "Yes",
    us: "No images",
  },
  {
    feature: "Actual security team",
    them: "Yes",
    us: "Just one dude and his AI agent",
  },
  {
    feature: "Someone to email when it breaks",
    them: "Yes",
    us: "A GitHub issue, if I see it.",
  },
];

/**
 * Marketing landing page. The app chrome (sidebar, add-expense) stays in /app;
 * this page explains the product. If this browser already has an account, the
 * CTA is "Open app" rather than "Log in".
 */
export function Home() {
  const signedIn = useHasLocalAccount();

  return (
    <div className="mkt">
      <section className="mkt-hero">
        <div className="mkt-hero-copy">
          <p className="mkt-kicker">Open source / Self-hostable</p>
          <h1>Keep track of who paid for dinner.</h1>
          <p className="mkt-lede">
            SplitSmart is a Splitwise replacement you can run yourself, or use
            here if you&apos;re willing to trust a random person on the internet
            with who paid for dinner. Groups, friends, one-off bills, 100+
            currencies, and it still works on a plane with no signal. You
            don&apos;t need an account to settle a single trip. Someone can just
            send you a link.
          </p>
          <div className="mkt-cta">
            {signedIn ? (
              <a href="/app" className="mkt-btn">
                Open app
              </a>
            ) : (
              <>
                <a href="/app/login?register" className="mkt-btn">
                  Create an account
                </a>
                <a href="/app/login" className="mkt-btn mkt-btn-ghost">
                  Log in
                </a>
              </>
            )}
          </div>
          <p className="mkt-fine">
            Or open a link someone sends you and start managing splits. No
            signup at all.
          </p>
        </div>

        <div className="mkt-hero-visual" aria-hidden="true">
          <OweageChart />
        </div>
      </section>

      <section className="mkt-band" aria-label="Highlights">
        <div className="mkt-tiles">
          <article className="mkt-tile mkt-tile-accent mkt-tile-a">
            <h2>Offline support</h2>
            <p>
              It writes to the device and syncs once you&apos;re back online.
            </p>
          </article>
          <article className="mkt-tile mkt-tile-b">
            <h2>No forced accounts</h2>
            <p>
              Send someone a guest link and they get edit access. Your friends
              can create an account if they want to keep using it.
            </p>
          </article>
          <article className="mkt-tile mkt-tile-deep mkt-tile-c">
            <h2>Open source</h2>
            <p>
              The code is on{" "}
              <a
                href="https://github.com/cjx3711/splitsmart"
                target="_blank"
                rel="noreferrer"
                className="mkt-inline">
                GitHub
              </a>{" "}
              if you want to self-host, though this instance is free for now.
            </p>
          </article>
          <article className="mkt-tile mkt-tile-d">
            <h2>Free API access</h2>
            <p>
              For your scripts or AI agents to manage expenses. The endpoints
              are in the{" "}
              <Link to="/docs" className="mkt-inline">
                API docs
              </Link>
              .
            </p>
          </article>
        </div>
      </section>

      <HomeGallery />

      <section className="mkt-list-wrap" aria-labelledby="mkt-whats-in-it">
        <div className="mkt-list-intro">
          <h2 id="mkt-whats-in-it">What&apos;s in it</h2>
          <p className="muted">
            The same jobs Splitwise does, minus the upsell that shows up while
            you&apos;re adding a bill. Plus a whole bunch of small fixes to
            things that have irritated me for years.
          </p>
        </div>
        <div className="mkt-list-cols">
          <div className="mkt-list-col">
            <h3>Same as Splitwise</h3>
            <ul className="mkt-checklist">
              {SAME_AS_SPLITWISE.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="mkt-list-col mkt-list-col-better">
            <h3>Improvements</h3>
            <ul className="mkt-checklist">
              {IMPROVEMENTS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mkt-compare" aria-labelledby="mkt-compare-heading">
        <div className="mkt-compare-intro">
          <h2 id="mkt-compare-heading">What we don&apos;t have</h2>
          <p className="muted">
            Splitwise is a company, has two phone apps, and a payments product.
            <br />
            This is a toy app I built in 2 weeks.
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
          If any of those are the reason you use Splitwise this ain't for you.
        </p>
      </section>

      <section className="mkt-close">
        <h2>That&apos;s the whole pitch.</h2>
        <p>
          The longer version of why this exists is on the{" "}
          <Link to="/about">about page</Link>, what just landed is in the{" "}
          <Link to="/changelog">changelog</Link>, and the endpoints are in the{" "}
          <Link to="/docs">API docs</Link>. If you just want to split a bill,{" "}
          {signedIn ? (
            <a href="/app">open the app</a>
          ) : (
            <a href="/app/login?register">make an account</a>
          )}{" "}
          or wait for someone to send you a group link.
        </p>
      </section>
    </div>
  );
}

/**
 * Decorative dashboard excerpt. Names match scripts/seed-demo.ts so a later
 * screenshot of the real dashboard still rhymes with this widget.
 */
function OweageChart() {
  return (
    <div className="mkt-owe">
      <section>
        <h2>You owe</h2>
        <div className="list">
          <OweRow
            id="mkt-ahbeng"
            name="Tan Ah Beng"
            direction="negative"
            amounts={["71.10 USD"]}
          />
          <OweRow
            id="mkt-jas"
            name="Jasmine Lim Jia Hui"
            direction="negative"
            amounts={["65.00 USD"]}
          />
        </div>
      </section>
      <section>
        <h2>You are owed</h2>
        <div className="list">
          <OweRow
            id="mkt-jj"
            name="Lee Jin Jie"
            direction="positive"
            amounts={["1200 JPY", "140.00 USD"]}
            breakdown={[
              { amount: "140.00 USD", where: "Ski Trip 2026" },
              { amount: "1200 JPY", where: "Weekend in Tokyo" },
            ]}
          />
          <OweRow
            id="mkt-taro"
            name="Tanaka Taro"
            direction="positive"
            amounts={["39.10 USD"]}
          />
        </div>
      </section>
    </div>
  );
}

function OweRow({
  id,
  name,
  direction,
  amounts,
  breakdown,
}: {
  id: string;
  name: string;
  direction: "positive" | "negative";
  amounts: string[];
  breakdown?: { amount: string; where: string }[];
}) {
  return (
    <div className="list-item">
      <Avatar id={id} name={name} />
      <div className="list-item-body">
        <div className="list-item-title">{name}</div>
        <div className={direction}>
          {direction === "positive" ? "owes you " : "you owe "}
          <span className="amounts">
            {amounts.map((value) => (
              <span key={value} className="amount">
                {value}
              </span>
            ))}
          </span>
        </div>
        {breakdown && breakdown.length > 1 ? (
          <ul className="breakdown">
            {breakdown.map((entry) => (
              <li key={entry.where}>
                <span className="amount">{entry.amount}</span> in {entry.where}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
