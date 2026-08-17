export function About() {
  return (
    <article className="mkt-prose">
      <h1>About</h1>
      <p>
        SplitSmart is a self-hosted Splitwise replacement. I&apos;m{" "}
        <a href="https://github.com/cjx3711" target="_blank" rel="noreferrer">
          cjx3711
        </a>{" "}
        and I built it for myself. The code is on GitHub at{" "}
        <a href="https://github.com/cjx3711/splitsmart" target="_blank" rel="noreferrer">
          cjx3711/splitsmart
        </a>
        .
      </p>

      <h2>This instance</h2>
      <p>
        Data integrity and security are <strong>not guaranteed</strong>. This
        copy runs on one machine with daily backups. I&apos;ve given it the
        basics: hashed passwords, httpOnly sessions, bearer tokens that are shown
        once, so your ledger isn&apos;t hanging off an open endpoint. But the
        basics aren&apos;t a guarantee. If you put money data in here, treat it
        as a convenient copy of a spreadsheet, not a bank.
      </p>

      <h2>Why</h2>
      <p>
        Splitwise has been tightening what its app and platform let you do for a
        while now. I don&apos;t mind paying for software, but they&apos;re
        charging a lot for what is ultimately a glorified Excel spreadsheet.
      </p>
      <p>
        The thing that actually broke my setup was the API. I used it to automate
        the boring parts: pull expenses out, push them into Toshl, keep a second
        ledger without retyping every ramen bowl. They throttled that down to a
        handful of requests a day, which is enough to make a sync job feel like
        it&apos;s begging, and as of September 2026 API access needs a paid plan.
        So the workflows I already built against their API either start costing
        money or they stop working.
      </p>
      <p>
        Then there&apos;s the website. The phone app is mostly fine, apart from
        capping me at four expenses a day, which is a strange thing to ration on
        an app whose entire job is writing down expenses. The website is where it
        actually gets annoying. Every time I add an expense I scroll past a
        hundred and fifty currencies to find JPY. One mis-tap outside the box and
        the whole draft is gone. None of that is a crime, it&apos;s just a
        pile of small friction on a job that&apos;s supposed to be &quot;write
        down who paid for dinner&quot;. Eventually the time I spent being annoyed
        at it got longer than the time it would take to write something that does
        that job the way I want.
      </p>
      <p>So I&apos;m building my own glorified Excel spreadsheet.</p>
      <p>
        That&apos;s the whole brief: track debts between people I already know,
        in the currencies we actually spent, without converting them into a fake
        total, without a paywall on the API, and without losing the draft
        because I clicked 12 pixels too far to the left.
      </p>

      <h2>A few things worth knowing</h2>
      <ul>
        <li>
          Currencies are never converted. Balances are one ledger per currency,
          so you get two numbers side by side instead of a made-up total. The app
          can show a labelled ≈ estimate next to them, but that&apos;s display
          only and it&apos;s never stored.
        </li>
        <li>
          Nothing is hard deleted. Deleted expenses are kept as tombstones so
          balances stay auditable.
        </li>
        <li>
          There are no receipts or file uploads. Storing other people&apos;s
          images is a real feature with real consequences, so it isn&apos;t
          something I want to add by accident.
        </li>
        <li>
          The Splitwise import runs per user and never stores your API key. It
          gets used for that request and then dropped, so a dump of this
          database has no credentials to anyone&apos;s Splitwise account in it.
        </li>
        <li>
          Anyone holding a guest link can read and edit the expenses it covers,
          as whichever placeholder person it acts as. That is the point of it,
          so share one the way you would share the group itself. Turning a link
          off takes effect on the very next tap, because the secret is checked
          on every request.
        </li>
      </ul>
    </article>
  );
}
