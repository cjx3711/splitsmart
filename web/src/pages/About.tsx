export function About() {
  return (
    <article className="mkt-prose">
      <h1>About</h1>
      <p>
        SplitSmart is made by{" "}
        <a href="https://github.com/cjx3711" target="_blank" rel="noreferrer">
          cjx3711
        </a>
        , a self-hosted Splitwise replacement built for personal use. The code is
        on GitHub at{" "}
        <a href="https://github.com/cjx3711/splitsmart" target="_blank" rel="noreferrer">
          cjx3711/splitsmart
        </a>
        .
      </p>

      <h2>This instance</h2>
      <p>
        Data integrity and security are <strong>not guaranteed</strong>. This
        copy of the app runs on a single machine with daily backups. I have
        tried to give it actual basic security: hashed passwords, httpOnly
        sessions, bearer tokens that are shown once, so it is not vibe-coded
        slop with everyone&apos;s ledger hanging off an open endpoint. That is
        not the same as a promise. If you put money data here, treat it as a
        convenience copy of a spreadsheet, not as a bank.
      </p>

      <h2>Why</h2>
      <p>
        Splitwise has been tightening what its app and platform allow for a
        while now. I don&apos;t mind paying for software, but they&apos;re
        charging too much for what&apos;s ultimately a glorified Excel
        spreadsheet.
      </p>
      <p>
        The part that actually broke my setup was the API. I used it to
        automate the boring bits: pull expenses, push them into Toshl, keep a
        second ledger without retyping every ramen bowl. Splitwise throttles
        that work down to a handful of requests a day, which is enough to make
        a sync job feel like it is begging. As of September 2026 they are
        putting API access behind a paid plan. The workflows I already built
        against their v3.0 shape either start costing rent or they stop.
      </p>
      <p>
        And then there is the app itself. Every time I add an expense I get to
        scroll past a hundred and fifty currencies to find JPY, again. A single
        mis-tap outside the dialog dumps the whole draft. None of these are
        crimes. They are just a pile of small frictions on a job that is
        supposed to be &quot;record who paid for dinner.&quot; At some point
        the time spent swearing at the tool outgrew the time it would take to
        write a tool that does that one job the way I want.
      </p>
      <p>So I&apos;m building my own glorified Excel spreadsheet.</p>
      <p>
        That is the entire product brief: track debts between people I already
        know, in the currencies we actually spent, without converting them into
        a fake total, without a paywall on the API, and without losing the
        draft because I clicked 12 pixels too far to the left.
      </p>
    </article>
  );
}
