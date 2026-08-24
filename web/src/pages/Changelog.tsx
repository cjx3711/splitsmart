/**
 * Public changelog. Hardcoded on purpose: this is a list of what shipped,
 * not a feed generated from git. Prepend a new ENTRIES object when something
 * user-visible lands, and bump `APP_VERSION` / `package.json` to match.
 */
type Entry = {
  /** Semver, newest first. The latest entry should match `APP_VERSION`. */
  version: string;
  /** Display date, already formatted. */
  date: string;
  intro?: string;
  items: string[];
};

const ENTRIES: Entry[] = [
  {
    version: "0.2.0",
    date: "24 August 2026",
    intro: "The actual first usable version.",
    items: [
      "Email verification flow",
      "Forgot password flow",
      "Splitwise import ensures parity with splitwise.",
      "Repeating Splitwise can be resumed.",
      "Convert a mixed-currency friend or group balance into one currency.",
      "More fun avatars",
      "Daily SQLite backups to S3.",
      "Dropped the Splitwise-compatible API. /api/v1 is the API.",
    ],
  },
  {
    version: "0.1.0",
    date: "18 August 2026",
    intro: "What I hoped was the first usable version",
    items: [
      "Friends, groups, and expenses.",
      "Six split types.",
      "Settle up, with suggested simplifications and auto estimated conversions.",
      "Comments on a expense. Edit, delete, or restore one and a note shows up saying what changed.",
      "Recurring expenses.",
      "Search, filters, CSV of whatever you're looking at.",
      "Guest accounts, accessible with expiring links.",
      "Guest account claiming.",
      "Offline mode for real accounts, with local database and syncing.",
      "PWA installable on Android and iOS.",
      "Import from Splitwise. API key is not saved.",
      "A basic JSON API.",
    ],
  },
];

export function Changelog() {
  return (
    <article className="mkt-prose">
      <h1>Changelog</h1>
      {ENTRIES.map((entry) => (
        <section key={entry.version} className="mkt-changelog-entry">
          <h2>
            {entry.version} <span className="mkt-changelog-date">{entry.date}</span>
          </h2>
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
