export function About() {
  return (
    <article className="mkt-prose">
      <h1>About</h1>
      <p>
        SplitSmart is a self-hosted Splitwise replacement. I&apos;m{" "}
        <a href="https://github.com/cjx3711" target="_blank" rel="noreferrer">
          cjx3711
        </a>{" "}
        and I built it for myself out of spite. The code is on GitHub at{" "}
        <a
          href="https://github.com/cjx3711/splitsmart"
          target="_blank"
          rel="noreferrer">
          cjx3711/splitsmart
        </a>
        .
      </p>

      <h2>This instance</h2>
      <p>
        Data integrity and security are <strong>not guaranteed</strong>. This
        copy runs on my personal machine with daily backups. I&apos;ve given it
        the basics of security: hashed passwords, httpOnly sessions, bearer
        tokens that are shown once. Your data isn&apos;t hanging off an open
        endpoint at least. But a sufficiently motivated attacker could probably
        still compromise it. That said, there's no real financial data in here
        so it's quite pointless. If you put money data in here, treat it as a
        convenient copy of a spreadsheet.
      </p>

      <h2>Why</h2>
      <p>
        Splitwise has been tightening what its app and platform let you do for a
        while now. (Limiting daily expenses, throwing up a nag screen every 5
        seconds etc) I don&apos;t mind paying for software, but they&apos;re
        charging a lot for what is ultimately a glorified Excel spreadsheet.
      </p>
      <p>
        I've been using their API to automated a bunch of my financial tasks,
        but as of September 2026, they're paywalling that. I can understand the
        need for them to monetize their API, but I'd rather make my own solution
        that fixes all the small issues that have bothered me anyway. Their
        platform has always been way too US centric for me anyway.
      </p>
      <p>
        Then there&apos;s the website. The phone app is mostly fine, apart from
        capping me at four expenses a day. Every time I add an expense I scroll
        past a hundred and fifty currencies to find JPY. One mis-tap outside the
        box and the whole draft is gone. Alone, all of these can be ignored,
        especially for a free service. But it's not going to be free anymore
        will it?
      </p>
      <p>So I&apos;m building my own glorified Excel spreadsheet.</p>
      <p>
        That&apos;s the whole pitch: track expenses between people I already
        know, in the currencies we actually spent, without converting them into
        a fake total, without a paywall on the API, without requiring people to
        have an account to edit things, and without losing the draft simply
        because I clicked 2 pixels too far to the left.
      </p>

      <h2>A few things worth knowing</h2>
      <ul>
        <li>
          There are no receipts or file uploads, or integration with payment
          processors. Storing other people&apos;s images is pain in the ass, so
          this app is just for the numbers.
        </li>
        <li>
          You can import from splitwise, but after September 2026, you'll
          probably need to subscribe for a month to do that one time.
        </li>
        <li>
          Anyone holding a guest link can read and edit the expenses it covers,
          as whichever placeholder person it acts as.
        </li>
      </ul>
    </article>
  );
}
