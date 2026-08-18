/**
 * Public changelog. Hardcoded on purpose: this is a list of what shipped,
 * not a feed generated from git. Prepend a new ENTRIES object when something
 * user-visible lands.
 */
type Entry = {
  /** Display date, already formatted. Newest first. */
  date: string;
  intro?: string;
  items: string[];
};

const ENTRIES: Entry[] = [
  {
    date: "18 August 2026",
    intro: "First usable version hopefully",
    items: [
      "Friends, groups, and expenses.",
      "Six split types.",
      "Settle up, with suggested simplifications and auto estimated conversions.",
      "Comments on a expense. Edit, delete, or restore one and a note shows up saying what changed. Deletes aren't gone forever.",
      "Recurring expenses.",
      "Search, filters, CSV of whatever you're looking at.",
      "Guest accounts, accessible with expiring links.",
      "Guest account claiming.",
      "Offline mode for real accounts, with local database and syncing.",
      "PWA installable on Android and iOS.",
      "Import from Splitwise. API key is not saved.",
      "A normal JSON API, and enough of Splitwise's v3.0 that the Toshl sync I already had can point here. Ids are ULIDs, not integers.",
    ],
  },
];

export function Changelog() {
  return (
    <article className="mkt-prose">
      <h1>Changelog</h1>
      {ENTRIES.map((entry) => (
        <section key={entry.date} className="mkt-changelog-entry">
          <h2>{entry.date}</h2>
          {entry.intro ? <p>{entry.intro}</p> : null}
          <ul>
            {entry.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
