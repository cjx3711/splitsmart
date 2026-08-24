/**
 * The Splitwise import wizard.
 *
 * Deliberately thin. Every decision (what matches what, what gets skipped and
 * why, what the user must be warned about) is made by /api/v1/import and shown
 * here verbatim. This file holds no import logic, so the endpoints stay the
 * single source of truth and can be driven without a browser.
 *
 * THE API KEY LIVES IN COMPONENT STATE AND NOWHERE ELSE. Not localStorage, not
 * sessionStorage, not a query string. It is resent on each step because the
 * server refuses to keep it, and it is dropped the moment this page unmounts.
 *
 * Four steps: key -> review -> run -> done. The run step drives the paged
 * expense and comment endpoints in a loop so progress is real rather than a
 * spinner, then matches Splitwise group nets and friend totals and records
 * leftover-cent settle-ups.
 *
 * Comments run after expenses, because `comments.expense_id` is a foreign key.
 * Rounding runs last: it needs the imported balances to exist.
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
  type ImportPausedSeries,
  type ImportRounding,
} from "../api.ts";
import { useSidebarRefresh } from "../App.tsx";
import { NeedsConnection, useOnline } from "../OnlineOnly.tsx";
import { Amount } from "../money.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { WipeLedgerButton } from "../WipeLedger.tsx";
import {
  isRepeatInterval,
  nextOccurrenceOnOrAfter,
  repeatLabel,
  type RepeatInterval,
} from "../../../src/domain/recurring.ts";

type Step = "key" | "review" | "running" | "done";

type PhaseStatus = "pending" | "active" | "done";

interface PhaseProgress {
  status: PhaseStatus;
  current?: number;
  total?: number;
  totalCapped?: boolean;
  /** When this phase became active. Used to estimate remaining time. */
  startedAt?: number;
}

interface Progress {
  friendsCount: number;
  groupsCount: number;
  friends: PhaseProgress;
  groups: PhaseProgress;
  expenses: PhaseProgress;
  comments: PhaseProgress;
  rounding: PhaseProgress;
}

function initialProgress(preview: ImportPreview): Progress {
  return {
    friendsCount: preview.counts.friends,
    groupsCount: preview.counts.groups,
    friends: { status: "active" },
    groups: { status: "pending" },
    expenses: {
      status: "pending",
      current: 0,
      total: preview.counts.expenses,
      totalCapped: preview.counts.expensesCapped,
    },
    comments: {
      status: "pending",
      current: 0,
    },
    rounding: { status: "pending" },
  };
}

/** The expense endpoint's default page size. Used to estimate progress. */
const EXPENSE_PAGE_SIZE = 500;

interface Outcome {
  peopleCreated: number;
  peopleMatched: number;
  groupsCreated: number;
  expensesImported: number;
  expensesAlreadyPresent: number;
  /** Already here, changed in Splitwise, and overwritten because nothing had edited it. */
  expensesRefreshed: number;
  commentsImported: number;
  skipped: ImportSkip[];
  /** Imported with extra digits dropped. Same shape as skipped, different meaning. */
  warnings: ImportSkip[];
  /** Placeholders created this run. They get no guest link; see the note below. */
  newPeople: ImportPerson[];
  /** Splitwise repeating bills landed as stopped series this run. */
  pausedSeries: ImportPausedSeries[];
  rounding: ImportRounding;
}

export function Import() {
  const refreshSidebar = useSidebarRefresh();
  const online = useOnline();
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
    if (!preview) return;
    const key = apiKey.trim();
    const total = preview.counts.expenses;

    setStep("running");
    setError(null);
    setProgress(initialProgress(preview));

    try {
      const friends = await api.importFriends(key);

      setProgress((prev) =>
        prev
          ? {
              ...prev,
              friends: { status: "done" },
              groups: { status: "active" },
            }
          : prev,
      );
      const groups = await api.importGroups(key);

      setProgress((prev) =>
        prev
          ? {
              ...prev,
              groups: { status: "done" },
              expenses: {
                status: "active",
                current: 0,
                total,
                totalCapped: preview.counts.expensesCapped,
                startedAt: Date.now(),
              },
            }
          : prev,
      );

      const result: Outcome = {
        peopleCreated: friends.created + groups.created,
        peopleMatched: friends.matched,
        groupsCreated: groups.groups.filter((g) => g.created).length,
        expensesImported: 0,
        expensesAlreadyPresent: 0,
        expensesRefreshed: 0,
        commentsImported: 0,
        skipped: [],
        warnings: [],
        newPeople: [...friends.people, ...groups.people].filter((p) => p.matchedBy === "created"),
        pausedSeries: [],
        rounding: { created: [], skipped: [] },
      };

      // Paged rather than one long request: progress is real, and a failure
      // costs one page instead of the whole run. Every page is resumable
      // because the server matches on metadata.splitwise_id.
      let offset: number | null = 0;
      let seen = 0;
      while (offset !== null) {
        const page = await api.importExpenses(key, offset);
        seen += page.fetched;
        result.expensesImported += page.imported;
        result.expensesAlreadyPresent += page.alreadyPresent;
        result.expensesRefreshed += page.refreshed;
        result.commentsImported += page.commentsImported;
        result.skipped.push(...page.skipped);
        result.warnings.push(...page.warnings);
        result.pausedSeries.push(...page.pausedSeries);

        setProgress((prev) => {
          if (!prev) return prev;
          // A short or empty page is the real end: the preview may have stopped
          // at 5000, but `seen` is how many Splitwise actually handed over.
          const exact = page.done || page.fetched < EXPENSE_PAGE_SIZE;
          return {
            ...prev,
            expenses: {
              status: "active",
              current: seen,
              total: exact ? seen : Math.max(total, seen),
              totalCapped: !exact && preview.counts.expensesCapped,
              startedAt: prev.expenses.startedAt,
            },
          };
        });

        offset = page.done ? null : page.nextOffset;
      }

      // Step 4. Only expenses Splitwise said have comments, 10 fetches per call.
      let commentsFetched = 0;
      let commentsTotal = 0;
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              expenses: {
                status: "done",
                current: seen,
                total: seen,
                totalCapped: false,
              },
              comments: {
                status: "active",
                current: 0,
                startedAt: Date.now(),
              },
            }
          : prev,
      );

      for (;;) {
        const page = await api.importComments(key);
        if (commentsFetched === 0) commentsTotal = page.total;
        commentsFetched += page.fetched;
        result.commentsImported += page.imported;
        result.skipped.push(...page.skipped);

        setProgress((prev) =>
          prev
            ? {
                ...prev,
                comments: {
                  status: "active",
                  current: commentsFetched,
                  total: commentsTotal,
                  totalCapped: false,
                  startedAt: prev.comments.startedAt,
                },
              }
            : prev,
        );

        if (page.done) break;
      }

      setProgress((prev) =>
        prev
          ? {
              ...prev,
              comments: {
                status: "done",
                current: commentsFetched,
                total: commentsTotal,
                totalCapped: false,
              },
              rounding: { status: "active", startedAt: Date.now() },
            }
          : prev,
      );

      result.rounding = await api.importRounding(key);

      setProgress((prev) =>
        prev
          ? {
              ...prev,
              rounding: { status: "done" },
            }
          : prev,
      );

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
      <div className="page-head">
        <h1>Import from Splitwise</h1>
      </div>

      {!online && <NeedsConnection what="Importing from Splitwise" />}

      {error && <p className="error">{error}</p>}

      {online && step === "key" && (
        <KeyStep
          apiKey={apiKey}
          setApiKey={setApiKey}
          status={status}
          busy={busy}
          onSubmit={handlePreview}
          onWiped={() => {
            void api
              .importStatus()
              .then(setStatus)
              .catch(() => setStatus(null));
          }}
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
  onWiped,
}: {
  apiKey: string;
  setApiKey: (value: string) => void;
  status: ImportStatus | null;
  busy: boolean;
  onSubmit: () => void;
  onWiped: () => void;
}) {
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      {status?.hasData && (
        <div className="notice stack">
          <strong>This account already has data</strong>
          <p style={{ margin: 0 }}>
            {status.local.groups} group(s), {status.local.friends} friend(s) and{" "}
            {status.local.expenses} expense(s) are already here. Importing <em>adds to</em> that -
            nothing is deleted or replaced.
          </p>
          {status.previouslyImported && (
            <p style={{ margin: 0 }}>
              {status.local.previouslyImported} of those expenses came from a previous Splitwise
              import. They are matched on their Splitwise id, so running this again will not
              duplicate them.
            </p>
          )}
          <WipeLedgerButton onWiped={onWiped} />
        </div>
      )}

      <div className="notice">
        <strong>How people are matched. </strong>
        {status?.matchingRule ??
          "People from Splitwise are matched to existing SplitSmart accounts by Splitwise id, then by email address."}{" "}
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
          <div className="label-with-help">
            <label htmlFor="apiKey">Splitwise API key</label>
            <HelpTip label="About the API key">
              The key is used for this import only; it is never saved to the database, and it is
              forgotten as soon as you leave this page.
            </HelpTip>
          </div>
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
          .
        </p>
        <button
          type="submit"
          disabled={busy || apiKey.trim().length < 10}
          style={{ marginTop: "0.35rem" }}
        >
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
  const linked = preview.people.filter(
    (p) => p.matchedBy === "splitwise_id" || p.matchedBy === "invite_email",
  );

  return (
    <div className="stack">
      <div className="card">
        <div className="muted">Splitwise account</div>
        <strong>{preview.splitwiseAccount.name}</strong>
        <div className="muted">{preview.splitwiseAccount.email ?? "no email"}</div>
      </div>

      <div className="card import-counts">
        <span>{preview.counts.groups} group(s)</span>
        <span>{preview.counts.friends} friend(s)</span>
        <span>
          {preview.counts.expensesCapped ? "at least " : ""}
          {preview.counts.expenses} expense(s)
        </span>
        {preview.counts.comments > 0 && (
          // A floor: counted from the first page of expenses only, which is all
          // the preview reads. Said as "at least" rather than implying a total.
          <span>at least {preview.counts.comments} comment(s)</span>
        )}
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
          title="Already on your books"
          people={linked}
          empty=""
        />
      )}
      <PeopleList
        title="Will be created as placeholder people"
        people={creating}
        empty="Nobody: everyone already has an account here."
      />

      <div className="import-actions">
        <button className="secondary" onClick={onBack}>
          Back
        </button>
        <button onClick={onRun}>Import {preview.counts.expenses} expense(s)</button>
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
  const expensesEta = useImportEta(progress.expenses);
  const commentsEta = useImportEta(progress.comments);

  return (
    <div className="card stack">
      <div className="import-progress">
        <ImportPhaseRow
          label="Friends"
          count={progress.friendsCount}
          phase={progress.friends}
        />
        <ImportPhaseRow label="Groups" count={progress.groupsCount} phase={progress.groups} />
        <ImportPhaseRow
          label="Expenses"
          count={progress.expenses.totalCapped ? undefined : progress.expenses.total}
          phase={progress.expenses}
          eta={expensesEta}
        />
        <ImportPhaseRow
          label="Comments"
          count={progress.comments.totalCapped ? undefined : progress.comments.total}
          phase={progress.comments}
          eta={commentsEta}
        />
        <ImportPhaseRow label="Balances" phase={progress.rounding} />
      </div>
      <span className="muted">
        Leave this page open. Anything already imported is matched on its Splitwise id, so if this
        is interrupted you can start again without duplicating a thing.
      </span>
    </div>
  );
}

function ImportPhaseRow({
  label,
  count,
  phase,
  eta,
}: {
  label: string;
  count?: number;
  phase: PhaseProgress;
  eta?: string | null;
}) {
  const done = phase.status === "done";
  const active = phase.status === "active";
  const countLabel = count !== undefined ? ` (${count})` : "";
  const progressLabel =
    active && phase.current !== undefined && phase.total !== undefined
      ? `${phase.current} of ${phase.totalCapped ? "~" : ""}${phase.total}`
      : null;

  let rowLabel = label;
  if (done) rowLabel = `${label}${countLabel}`;
  else if (active) rowLabel = progressLabel ? `Importing ${label.toLowerCase()}… ${progressLabel}` : `Importing ${label.toLowerCase()}…`;
  else rowLabel = `${label}${countLabel}`;

  return (
    <div
      className={`import-phase${active ? " import-phase-active" : ""}${done ? " import-phase-done" : ""}`}
    >
      <div className="import-phase-head">
        <span className="import-phase-icon" aria-hidden="true">
          {done ? "✓" : ""}
        </span>
        <span className="import-phase-label">{rowLabel}</span>
        {active && eta && <span className="import-phase-eta">{eta}</span>}
      </div>
      {done ? (
        <progress value={1} max={1} />
      ) : active && phase.current !== undefined && phase.total !== undefined ? (
        <progress
          value={Math.min(phase.current, phase.total)}
          max={Math.max(phase.total, 1)}
        />
      ) : active ? (
        <progress />
      ) : (
        <progress value={0} max={1} />
      )}
    </div>
  );
}

/**
 * Remaining-time caption from elapsed work. Null until a page has landed, so
 * we have a real rate rather than a guess from a 0/N bar.
 */
function useImportEta(phase: PhaseProgress): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phase.status !== "active") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase.status]);

  if (
    phase.status !== "active" ||
    phase.startedAt === undefined ||
    phase.current === undefined ||
    phase.total === undefined ||
    phase.current <= 0 ||
    phase.totalCapped
  ) {
    return null;
  }

  const remaining = phase.total - phase.current;
  if (remaining <= 0) return "a few seconds left";

  const elapsed = now - phase.startedAt;
  if (elapsed < 400) return null;

  const ms = (elapsed / phase.current) * remaining;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return formatEta(ms);
}

function formatEta(ms: number): string {
  if (ms <= 8_000) return "a few seconds left";
  const seconds = Math.round(ms / 1000);
  if (seconds < 50) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "about 1 minute left" : `about ${minutes} minutes left`;
  }
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "about 1 hour left" : `about ${hours} hours left`;
}

// ---------------------------------------------------------------------------

function DoneStep({ outcome }: { outcome: Outcome }) {
  const refreshSidebar = useSidebarRefresh();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(outcome.pausedSeries.map((s) => s.id)),
  );
  const [seriesState, setSeriesState] = useState<"pick" | "busy" | "continued" | "left">(
    outcome.pausedSeries.length > 0 ? "pick" : "left",
  );
  const [continuedCount, setContinuedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const allSelected =
    outcome.pausedSeries.length > 0 && outcome.pausedSeries.every((s) => selected.has(s.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(outcome.pausedSeries.map((s) => s.id)));
  }

  async function continueSelected() {
    const ids = outcome.pausedSeries.map((s) => s.id).filter((id) => selected.has(id));
    if (ids.length === 0) {
      setSeriesState("left");
      return;
    }
    setError(null);
    setSeriesState("busy");
    try {
      const result = await api.importContinueRecurring(ids);
      setContinuedCount(result.continued.length);
      setSeriesState("continued");
      refreshSidebar();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not continue those series");
      setSeriesState("pick");
    }
  }

  return (
    <div className="stack">
      <div className="notice">
        <strong>Import finished.</strong> {outcome.expensesImported} expense(s) imported,{" "}
        {outcome.groupsCreated} group(s) created, {outcome.peopleCreated} person/people created and{" "}
        {outcome.peopleMatched} matched to existing accounts.
        {outcome.expensesAlreadyPresent > 0 && (
          <> {outcome.expensesAlreadyPresent} were already here and were left alone.</>
        )}
        {outcome.expensesRefreshed > 0 && (
          <>
            {" "}
            {outcome.expensesRefreshed} had changed in Splitwise and were updated here, because
            nothing had edited them since the last import.
          </>
        )}
        {outcome.commentsImported > 0 && (
          <> {outcome.commentsImported} comment(s) came across as well.</>
        )}
      </div>

      {/* An operator step, said out loud rather than assumed: the invariants that
          matter here span rows, so the audit is a command, not a code path. */}
      <div className="notice">
        <strong>Worth doing now.</strong> Run <code>yarn db:check</code> and spot-check a couple of
        balances against the Splitwise UI before you trust this. A row that could not be imported
        exactly was skipped rather than guessed at, and the list below says which.
      </div>

      {outcome.pausedSeries.length > 0 && seriesState !== "left" && seriesState !== "continued" && (
        <div className="card stack">
          <strong className="with-help">
            Repeating bills ({outcome.pausedSeries.length})
            <HelpTip label="About imported repeats">
              These came across as stopped series, so import does not start creating future bills on
              its own. Continue any you still want generated here. Resume starts from today and does
              not create months that already happened.
            </HelpTip>
          </strong>
          <label className="import-series-all">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            Select all
          </label>
          <ul className="import-series-list">
            {outcome.pausedSeries.map((series) => {
              if (!isRepeatInterval(series.interval)) return null;
              const interval: RepeatInterval = series.interval;
              const nextOn = nextOccurrenceOnOrAfter(series.date, interval).slice(0, 10);
              return (
                <li key={series.id}>
                  <label className="import-series-row">
                    <input
                      type="checkbox"
                      checked={selected.has(series.id)}
                      onChange={() => toggle(series.id)}
                    />
                    <span className="import-series-body">
                      <span>
                        {series.description} · {repeatLabel(interval)}
                      </span>
                      <span className="muted">
                        <Amount minor={series.costMinor} currency={series.currencyCode} />
                        {" · "}
                        last {series.date.slice(0, 10)}
                        {" · "}
                        next {nextOn}
                      </span>
                      {series.participants.length > 0 && (
                        <span className="muted">{series.participants.join(", ")}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {error && <p className="error">{error}</p>}
          <div className="import-actions">
            <button
              className="secondary"
              disabled={seriesState === "busy"}
              onClick={() => setSeriesState("left")}
            >
              Leave stopped
            </button>
            <button
              disabled={seriesState === "busy" || selected.size === 0}
              onClick={() => void continueSelected()}
            >
              {seriesState === "busy" ? "Continuing…" : "Continue selected"}
            </button>
          </div>
        </div>
      )}

      {seriesState === "continued" && (
        <div className="notice">
          {continuedCount} series will now repeat. The next bill is dated from today; months that
          already happened are not created.
        </div>
      )}

      {outcome.newPeople.length > 0 && (
        <div className="card stack">
          <strong className="with-help">
            People created ({outcome.newPeople.length})
            <HelpTip label="About people created">
              These are placeholders, with no way in yet. Importing your history is not the same as
              deciding to share it, so no guest links were made. Open someone&apos;s friend page and
              create one when you want them to see what you have split.
            </HelpTip>
          </strong>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {outcome.newPeople.map((person) => (
              <li key={person.splitwiseId} style={{ marginBottom: "0.4rem" }}>
                {person.name}
                {person.email && <span className="muted"> · {person.email}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.skipped.length > 0 && (
        <div className="card stack">
          <strong className="with-help">
            Skipped ({outcome.skipped.length})
            <HelpTip label="About skipped rows">
              Nothing was written for these. A row we cannot import exactly is left out rather than
              guessed at.
            </HelpTip>
          </strong>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {outcome.skipped.map((skip) => (
              <li key={skip.splitwiseId}>
                {skip.description} <span className="muted">: {skip.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.warnings.length > 0 && (
        <div className="card stack">
          <strong className="with-help">
            Warnings ({outcome.warnings.length})
            <HelpTip label="About import warnings">
              These were imported. Extra digits past what the currency allows were dropped, and a
              note was left on each bill.
            </HelpTip>
          </strong>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {outcome.warnings.map((warning) => (
              <li key={warning.splitwiseId}>
                {warning.description} <span className="muted">: {warning.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.rounding.created.length > 0 && (
        <div className="card stack">
          <strong className="with-help">
            Rounding settle-ups ({outcome.rounding.created.length})
            <HelpTip label="About rounding settle-ups">
              Splitwise sometimes stores more decimal places than a currency allows. Those extra
              digits are dropped on each bill, which can leave a group or a friend total a few
              cents apart. Groups are settled first, including leftover yen between two other
              people. Each of these payments restores the Splitwise total. The bills themselves
              are unchanged.
            </HelpTip>
          </strong>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {outcome.rounding.created.map((row) => (
              <li key={row.expenseId}>
                <Link to={`/expenses/${row.expenseId}`}>{row.friendName}</Link>
                {row.groupName ? ` · ${row.groupName}` : ""}
                {" · "}
                <Amount minor={row.amountMinor} currency={row.currencyCode} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.rounding.skipped.length > 0 && (
        <div className="card stack">
          <strong className="with-help">
            Friend totals not auto-settled ({outcome.rounding.skipped.length})
            <HelpTip label="About friend totals that were not auto-settled">
              A gap larger than leftover cents is left alone rather than covered up. Check whether
              an expense was skipped, then settle by hand if you still want to.
            </HelpTip>
          </strong>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {outcome.rounding.skipped.map((row) => (
              <li key={`${row.splitwiseId}:${row.currencyCode ?? ""}`}>
                {row.name}
                {row.currencyCode ? ` · ${row.currencyCode}` : ""}
                <span className="muted">: {row.reason}</span>
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
