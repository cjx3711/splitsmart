/**
 * The Splitwise import wizard.
 *
 * Deliberately thin. Every decision — what matches what, what gets skipped and
 * why, what the user must be warned about — is made by /api/v1/import and shown
 * here verbatim. This file holds no import logic, so the endpoints stay the
 * single source of truth and can be driven without a browser.
 *
 * THE API KEY LIVES IN COMPONENT STATE AND NOWHERE ELSE. Not localStorage, not
 * sessionStorage, not a query string. It is resent on each step because the
 * server refuses to keep it, and it is dropped the moment this page unmounts.
 *
 * Four steps: key -> review -> run -> done. The run step drives the paged
 * expense endpoint in a loop so progress is real rather than a spinner.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  type ImportStatus,
  type ImportPreview,
  type ImportPerson,
  type ImportSkip,
} from "../api.ts";
import { useSidebarRefresh } from "../App.tsx";

type Step = "key" | "review" | "running" | "done";

interface Progress {
  label: string;
  /** Expenses seen so far; the total is a floor, so this can pass it. */
  expensesSeen: number;
  expensesTotal: number;
}

interface Outcome {
  peopleCreated: number;
  peopleMatched: number;
  groupsCreated: number;
  expensesImported: number;
  expensesAlreadyPresent: number;
  skipped: ImportSkip[];
  /** Placeholders created this run, with their one-time recovery codes. */
  newPeople: ImportPerson[];
}

export function Import() {
  const refreshSidebar = useSidebarRefresh();
  const [step, setStep] = useState<Step>("key");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Loaded before the key is asked for: the "you already have data" warning has
  // to be on screen while the user is still deciding whether to start.
  useEffect(() => {
    void api
      .importStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function handlePreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.importPreview(apiKey.trim()));
      setStep("review");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach Splitwise");
    } finally {
      setBusy(false);
    }
  }

  async function handleRun() {
    const key = apiKey.trim();
    const total = preview?.counts.expenses ?? 0;

    setStep("running");
    setError(null);
    setProgress({ label: "Importing people…", expensesSeen: 0, expensesTotal: total });

    try {
      const friends = await api.importFriends(key);

      setProgress({ label: "Importing groups…", expensesSeen: 0, expensesTotal: total });
      const groups = await api.importGroups(key);

      const result: Outcome = {
        peopleCreated: friends.created + groups.created,
        peopleMatched: friends.matched,
        groupsCreated: groups.groups.filter((g) => g.created).length,
        expensesImported: 0,
        expensesAlreadyPresent: 0,
        skipped: [],
        newPeople: [...friends.people, ...groups.people].filter((p) => p.recoveryCode),
      };

      // Paged rather than one long request: progress is real, and a failure
      // costs one page instead of the whole run. Every page is resumable
      // because the server matches on splitwise_id.
      let offset: number | null = 0;
      let seen = 0;
      while (offset !== null) {
        const page = await api.importExpenses(key, offset);
        seen += page.fetched;
        result.expensesImported += page.imported;
        result.expensesAlreadyPresent += page.alreadyPresent;
        result.skipped.push(...page.skipped);

        setProgress({
          label: `Importing expenses… ${seen} of ~${total}`,
          expensesSeen: seen,
          expensesTotal: total,
        });

        offset = page.done ? null : page.nextOffset;
      }

      setOutcome(result);
      setStep("done");
      refreshSidebar();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The import stopped partway through");
      setStep("review");
    }
  }

  return (
    <>
      <h1>Import from Splitwise</h1>

      {error && <p className="error">{error}</p>}

      {step === "key" && (
        <KeyStep
          apiKey={apiKey}
          setApiKey={setApiKey}
          status={status}
          busy={busy}
          onSubmit={handlePreview}
        />
      )}

      {step === "review" && preview && (
        <ReviewStep preview={preview} onBack={() => setStep("key")} onRun={handleRun} />
      )}

      {step === "running" && progress && <RunningStep progress={progress} />}

      {step === "done" && outcome && <DoneStep outcome={outcome} />}
    </>
  );
}

// ---------------------------------------------------------------------------

function KeyStep({
  apiKey,
  setApiKey,
  status,
  busy,
  onSubmit,
}: {
  apiKey: string;
  setApiKey: (value: string) => void;
  status: ImportStatus | null;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="stack">
      {status?.hasData && (
        <div className="notice stack">
          <strong>This account already has data</strong>
          <p style={{ margin: 0 }}>
            {status.local.groups} group(s), {status.local.friends} friend(s) and{" "}
            {status.local.expenses} expense(s) are already here. Importing <em>adds to</em> that —
            nothing is deleted or replaced.
          </p>
          {status.previouslyImported && (
            <p style={{ margin: 0 }}>
              {status.local.previouslyImported} of those expenses came from a previous Splitwise
              import. They are matched on their Splitwise id, so running this again will not
              duplicate them.
            </p>
          )}
        </div>
      )}

      <div className="notice">
        <strong>How people are matched. </strong>
        {status?.matchingRule ??
          "People from Splitwise are matched to existing SplitSmart accounts by email address."}{" "}
        You will see exactly who matched before anything is written.
      </div>

      <form
        className="card stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div>
          <label htmlFor="apiKey">Splitwise API key</label>
          <input
            id="apiKey"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your personal API key"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Create one under <em>Your apps</em> at{" "}
          <a href="https://secure.splitwise.com/apps" target="_blank" rel="noreferrer">
            secure.splitwise.com/apps
          </a>
          . The key is used for this import only — it is never saved to the database, and it is
          forgotten as soon as you leave this page.
        </p>
        <button type="submit" disabled={busy || apiKey.trim().length < 10}>
          {busy ? "Checking your Splitwise account…" : "Check my Splitwise account"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReviewStep({
  preview,
  onBack,
  onRun,
}: {
  preview: ImportPreview;
  onBack: () => void;
  onRun: () => void;
}) {
  const matched = preview.people.filter((p) => p.matchedBy === "email");
  const creating = preview.people.filter((p) => p.matchedBy === "created");
  const linked = preview.people.filter((p) => p.matchedBy === "splitwise_id");

  return (
    <div className="stack">
      <div className="card">
        <div className="muted">Splitwise account</div>
        <strong>{preview.splitwiseAccount.name}</strong>
        <div className="muted">{preview.splitwiseAccount.email ?? "no email"}</div>
      </div>

      <div className="card row">
        <span>{preview.counts.groups} group(s)</span>
        <span>{preview.counts.friends} friend(s)</span>
        <span>
          {preview.counts.expensesCapped ? "at least " : ""}
          {preview.counts.expenses} expense(s)
        </span>
      </div>

      {/* Server-authored, shown verbatim. Rewording them here is how the UI and
          the API end up promising different things. */}
      {preview.warnings.map((warning) => (
        <p key={warning} className="notice">
          {warning}
        </p>
      ))}

      <PeopleList
        title="Matched to an existing account by email"
        people={matched}
        empty="Nobody. Every Splitwise contact is new here."
      />
      {linked.length > 0 && (
        <PeopleList
          title="Already imported previously"
          people={linked}
          empty=""
        />
      )}
      <PeopleList
        title="Will be created as placeholder people"
        people={creating}
        empty="Nobody — everyone already has an account here."
      />

      <div className="row">
        <button className="secondary" style={{ width: "auto" }} onClick={onBack}>
          Back
        </button>
        <button style={{ width: "auto" }} onClick={onRun}>
          Import {preview.counts.expenses} expense(s)
        </button>
      </div>
    </div>
  );
}

function PeopleList({
  title,
  people,
  empty,
}: {
  title: string;
  people: ImportPerson[];
  empty: string;
}) {
  return (
    <div className="card stack">
      <strong>
        {title} ({people.length})
      </strong>
      {people.length === 0 ? (
        <span className="muted">{empty}</span>
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
          {people.map((person) => (
            <li key={person.splitwiseId}>
              {person.name}
              {person.email && <span className="muted"> · {person.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RunningStep({ progress }: { progress: Progress }) {
  return (
    <div className="card stack">
      <strong>{progress.label}</strong>
      <progress
        // The total is a floor when the account is large, so clamp rather than
        // letting the bar overrun and look broken.
        value={Math.min(progress.expensesSeen, progress.expensesTotal)}
        max={Math.max(progress.expensesTotal, 1)}
        style={{ width: "100%" }}
      />
      <span className="muted">
        Leave this page open. Anything already imported is matched on its Splitwise id, so if this
        is interrupted you can start again without duplicating a thing.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DoneStep({ outcome }: { outcome: Outcome }) {
  return (
    <div className="stack">
      <div className="notice">
        <strong>Import finished.</strong> {outcome.expensesImported} expense(s) imported,{" "}
        {outcome.groupsCreated} group(s) created, {outcome.peopleCreated} person/people created and{" "}
        {outcome.peopleMatched} matched to existing accounts.
        {outcome.expensesAlreadyPresent > 0 && (
          <> {outcome.expensesAlreadyPresent} were already here and were left alone.</>
        )}
      </div>

      {outcome.newPeople.length > 0 && (
        <div className="card stack">
          <strong>Invite codes for the people just created ({outcome.newPeople.length})</strong>
          <p className="muted" style={{ margin: 0 }}>
            These are shown once and cannot be retrieved again — only their hashes are stored. Send
            someone their link and they can claim their account with all their history intact.
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {outcome.newPeople.map((person) => (
              <li key={person.splitwiseId} style={{ marginBottom: "0.4rem" }}>
                {person.name}
                {person.email && <span className="muted"> · {person.email}</span>}
                <br />
                <code>{`${window.location.origin}/accept/${person.recoveryCode}`}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.skipped.length > 0 && (
        <div className="card stack">
          <strong>Skipped ({outcome.skipped.length})</strong>
          <p className="muted" style={{ margin: 0 }}>
            Nothing was written for these. A row we cannot import exactly is left out rather than
            guessed at.
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {outcome.skipped.map((skip) => (
              <li key={skip.splitwiseId}>
                {skip.description} <span className="muted">— {skip.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row">
        <Link to="/expenses">See your expenses</Link>
        <Link to="/groups">See your groups</Link>
      </div>
    </div>
  );
}
