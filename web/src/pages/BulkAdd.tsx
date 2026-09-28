import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../App.tsx";
import { useGroups, useGroupMembers, useMirrorReady, useRelatedPeople } from "../localData.ts";
import { categoryPath, useCategories } from "../categories.tsx";
import { Amounts, useCurrencies } from "../money.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { ulid } from "../../../src/domain/ulid.ts";
import { DataLoading } from "../DataLoading.tsx";
import { BULK_COLUMNS, MAX_CSV_BYTES, MAX_BULK_ROWS, bulkPrompt, parseBulkCsv, validateBulkRow, type BulkContext, type BulkDefaults, type BulkPerson, type BulkRow } from "../bulkAdd.ts";

export function BulkAdd() {
  const { user } = useAuth();
  const related = useRelatedPeople();
  const groupData = useGroups();
  const groups = groupData?.groups ?? [];
  const members = useGroupMembers(groups.map((g) => g.id));
  const categories = useCategories();
  const { currencies, loaded } = useCurrencies();
  const ready = useMirrorReady();
  const [params] = useSearchParams();
  if (!user || !ready || !related || !groupData || !members || !loaded || !categories.length) {
    return <><div className="page-head"><h1>Bulk add</h1></div><DataLoading /></>;
  }
  const context: BulkContext = {
    selfId: user.id,
    people: [...new Map([user, ...related.people, ...[...members.values()].flat()].map((p) => [p.id, p])).values()],
    groups: groups.map((g) => ({ id: g.id, name: g.name, memberIds: (members.get(g.id) ?? []).map((m) => m.id) })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, path: categoryPath(categories, c.id) ?? c.name })),
    currencies,
  };
  const group = groups.find((g) => g.id === params.get("group"));
  const friend = related.people.find((p) => p.id === params.get("friend"));
  return <BulkAddForm context={context} initial={{
    currency: group?.default_currency ?? user.defaultCurrency,
    group: group?.id ?? "", payer: user.id,
    splitWith: group ? (members.get(group.id) ?? []).map((m) => m.id) : friend ? [user.id, friend.id] : [],
  }} />;
}

function personLabel(person: BulkPerson, selfId: string) {
  return `${person.id === selfId ? "You · " : ""}${person.nickname || person.name} (${person.id.slice(-6)})`;
}

function PeopleSelect({ value, onChange, people, context, label }: {
  value: string[]; onChange: (ids: string[]) => void; people: BulkPerson[]; context: BulkContext; label: string;
}) {
  const unknown = value.filter((id) => !people.some((p) => p.id === id));
  return <details className="bulk-people">
    <summary aria-label={label}>{value.length ? value.map((id) => {
      const person = context.people.find((p) => p.id === id);
      return person ? person.id === context.selfId ? "You" : person.nickname || person.name : `Unknown: ${id || "blank"}`;
    }).join(", ") : "Choose people"}</summary>
    <div className="bulk-people-list" role="group" aria-label={label}>
      {unknown.map((id) => <label key={id} className="error"><input type="checkbox" checked onChange={() => onChange(value.filter((v) => v !== id))} />Remove: {id || "blank"}</label>)}
      {people.map((person) => <label key={person.id}><input type="checkbox" checked={value.includes(person.id)} onChange={(e) => onChange(e.target.checked ? [...value, person.id] : value.filter((id) => id !== person.id))} />{personLabel(person, context.selfId)}</label>)}
    </div>
  </details>;
}

function BulkAddForm({ context, initial }: { context: BulkContext; initial: BulkDefaults }) {
  const { engine } = useSync();
  const [defaults, setDefaults] = useState(initial);
  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const saving = useRef(false);
  const readVersion = useRef(0);
  const prompt = bulkPrompt(context, defaults);
  const validations = useMemo(() => rows.map((row) => validateBulkRow(row, context)), [rows, context]);
  const invalidCount = validations.filter((v) => v.errors.length).length;
  const totals = new Map<string, number>();
  for (const result of validations) if (result.input) totals.set(result.input.currencyCode, (totals.get(result.input.currencyCode) ?? 0) + result.input.costMinor);
  const peopleFor = (group: string) => group ? context.people.filter((p) => context.groups.find((g) => g.id === group)?.memberIds.includes(p.id)) : context.people;
  const patch = (key: string, value: Partial<BulkRow>) => setRows((current) => current.map((row) => row.key === key ? { ...row, ...value } : row));
  const currencyOptions = (value: string) => <>{!context.currencies.some((c) => c.code === value) && <option value={value}>{value || "Choose currency"} (unrecognized)</option>}{context.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</>;
  const groupOptions = (value: string) => <><option value="">No group</option>{value && !context.groups.some((g) => g.id === value) && <option value={value}>{value} (unrecognized)</option>}{context.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</>;
  const payerOptions = (value: string, group: string) => <>{!peopleFor(group).some((p) => p.id === value) && <option value={value}>{value || "Choose payer"} (unrecognized)</option>}{peopleFor(group).map((p) => <option key={p.id} value={p.id}>{personLabel(p, context.selfId)}</option>)}</>;

  async function readFile(file: File | undefined) {
    if (!file) return;
    const version = ++readVersion.current;
    setReading(true); setError(""); setFilename(""); setCsv("");
    try {
      if (file.size > MAX_CSV_BYTES) throw new Error("CSV files must be 2 MB or smaller.");
      const text = await file.text();
      if (version !== readVersion.current) return;
      setCsv(text); setFilename(file.name);
    } catch (err) {
      if (version === readVersion.current) setError(err instanceof Error ? err.message : "Could not read the file.");
    } finally { if (version === readVersion.current) setReading(false); }
  }
  function review() {
    setError("");
    try { setRows(parseBulkCsv(csv, context, defaults)); setReviewing(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not read the CSV."); }
  }
  async function save() {
    if (saving.current || !engine || !rows.length || invalidCount) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await engine.enqueueExpenses(validations.map((v) => ({ kind: "expense.create", id: ulid(), payload: v.input! })));
      setDone(rows.length); setRows([]); setCsv("");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not add expenses. No rows were saved; please retry."); }
    finally { saving.current = false; setBusy(false); }
  }

  if (done) return <>
    <div className="page-head"><h1>Bulk add</h1></div>
    <div className="card stack" role="status">
      <h2>{done} {done === 1 ? "expense" : "expenses"} added</h2>
      <p>Saved on this device and queued to sync. The sync indicator shows progress and any items that need attention.</p>
      <div className="bulk-actions"><Link to="/expenses">View all expenses</Link><button className="secondary inline" onClick={() => { setDone(0); setReviewing(false); setFilename(""); }}>Add another CSV</button></div>
    </div>
  </>;

  return <>
    <div className="page-head"><div><h1>Bulk add</h1><p className="muted">{reviewing ? "2. Review and correct every expense before adding." : "1. Upload a CSV or use your LLM to prepare one."}</p></div></div>
    {error && <p className="error" role="alert">{error}</p>}
    <fieldset className="bulk-fieldset stack" disabled={busy}>
      <details className="card bulk-defaults" open={!reviewing || undefined}>
        <summary>{reviewing ? "Apply corrections to all rows" : "Defaults for missing CSV fields"}</summary>
        <div className="bulk-default-grid">
          <div><label htmlFor="bulk-group">Group</label><select id="bulk-group" value={defaults.group} onChange={(e) => setDefaults({ ...defaults, group: e.target.value, splitWith: context.groups.find((g) => g.id === e.target.value)?.memberIds ?? [], payer: context.selfId })}>{groupOptions(defaults.group)}</select>{reviewing && <button className="link" onClick={() => setRows(rows.map((row) => ({ ...row, group: defaults.group })))}>Apply group to all</button>}</div>
          <div><label htmlFor="bulk-currency">Currency</label><select id="bulk-currency" value={defaults.currency} onChange={(e) => setDefaults({ ...defaults, currency: e.target.value })}>{currencyOptions(defaults.currency)}</select>{reviewing && <button className="link" onClick={() => setRows(rows.map((row) => ({ ...row, currency: defaults.currency })))}>Apply currency to all</button>}</div>
          <div><label htmlFor="bulk-payer">Paid by</label><select id="bulk-payer" value={defaults.payer} onChange={(e) => setDefaults({ ...defaults, payer: e.target.value })}>{payerOptions(defaults.payer, defaults.group)}</select>{reviewing && <button className="link" onClick={() => setRows(rows.map((row) => ({ ...row, payer: defaults.payer })))}>Apply payer to all</button>}</div>
          <div><label>Split between (equally)</label><PeopleSelect label="Default split between" value={defaults.splitWith} onChange={(splitWith) => setDefaults({ ...defaults, splitWith })} people={peopleFor(defaults.group)} context={context} />{reviewing && <button className="link" onClick={() => setRows(rows.map((row) => ({ ...row, splitWith: defaults.splitWith })))}>Apply people to all</button>}</div>
        </div>
        <p className="muted">Select everyone who owes a share. Include the payer if they share the cost. Changing currency keeps the entered amount; it does not convert it.</p>
      </details>
      {!reviewing ? <>
        <details className="card stack">
          <summary>LLM prompt</summary>
          <p>Copy this prompt into your LLM of choice, then append your receipts or expense notes. It includes the people, groups, and categories shown in this account.</p>
          <label htmlFor="bulk-prompt">Prompt to copy</label>
          <textarea id="bulk-prompt" rows={10} readOnly value={prompt} onFocus={(e) => e.target.select()} />
          <button className="secondary inline" onClick={async () => {
            try { await navigator.clipboard.writeText(prompt); setCopied(true); }
            catch { setError("Clipboard unavailable. Select and copy the prompt above."); }
          }}>{copied ? "Copied" : "Copy LLM prompt"}</button>
        </details>
        <div className="card stack">
          <label htmlFor="bulk-file">CSV file</label><input id="bulk-file" type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} />
          <p className="muted">{filename ? `${filename} · ` : ""}Up to {MAX_BULK_ROWS} expenses, 2 MB. Nothing is added until you finish reviewing.</p>
          <label htmlFor="bulk-csv">Or paste CSV</label><textarea id="bulk-csv" rows={8} value={csv} disabled={reading} onChange={(e) => { setCsv(e.target.value); setFilename(""); }} placeholder={BULK_COLUMNS.join(",")} spellCheck={false} />
          <details><summary>CSV format and example</summary><p>Required: date, description, amount. Other columns are optional. Use names or IDs for people and groups; separate people with semicolons. Unknown or ambiguous names must be corrected in review.</p><pre className="bulk-example">{BULK_COLUMNS.join(",")}{"\n"}2026-09-24,Dinner,42,USD,me,me;Alex,,,{"\n"}2026-09-24,Taxi,1800,JPY,Alex,me,,,Airport ride</pre><p>Shares are equal between the selected people. For unequal splits or multiple payers, add that expense with the regular expense form.</p></details>
          <button className="inline" disabled={reading || !csv.trim()} onClick={review}>{reading ? "Reading…" : "Review expenses"}</button>
        </div>
      </> : <>
        <div className="bulk-review-summary" role="status"><strong>{rows.length} {rows.length === 1 ? "expense" : "expenses"} · {invalidCount ? `${invalidCount} need correction` : "Ready to add"}</strong><Amounts balances={[...totals].map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor }))} /><span className="muted">Totals include valid rows only.</span></div>
        <p className="muted">All cells are editable; scroll sideways to see every field. Remove any rows you do not want to add. Re-importing a previously added CSV creates new expenses.</p>
        <div className="bulk-table-scroll" tabIndex={0} role="region" aria-label="Detected expenses; scroll horizontally to review all fields">
          <table className="bulk-table"><caption>Detected expenses</caption><thead><tr>{["CSV record", "Date", "Description", "Amount", "Currency", "Paid by", "Split between (equally)", "Group", "Category", "Notes", "Review"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => {
            const errors = validations[index]!.errors;
            const textField = (field: "date" | "description" | "amount" | "notes", label: string) => <input aria-label={`${label}, record ${row.key}`} aria-describedby={errors.length ? `bulk-errors-${row.key}` : undefined} value={row[field]} inputMode={field === "amount" ? "decimal" : undefined} placeholder={field === "date" ? "YYYY-MM-DD" : undefined} onChange={(e) => patch(row.key, { [field]: e.target.value })} />;
            return <tr key={row.key} className={errors.length ? "bulk-row-invalid" : ""}>
              <th scope="row">{row.key}</th><td>{textField("date", "Date")}</td><td>{textField("description", "Description")}</td><td>{textField("amount", "Amount")}</td>
              <td><select aria-label={`Currency, record ${row.key}`} value={row.currency} onChange={(e) => patch(row.key, { currency: e.target.value })}>{currencyOptions(row.currency)}</select></td>
              <td><select aria-label={`Paid by, record ${row.key}`} value={row.payer} onChange={(e) => patch(row.key, { payer: e.target.value })}>{payerOptions(row.payer, row.group)}</select></td>
              <td><PeopleSelect label={`Split between, record ${row.key}`} value={row.splitWith} onChange={(splitWith) => patch(row.key, { splitWith })} people={peopleFor(row.group)} context={context} /></td>
              <td><select aria-label={`Group, record ${row.key}`} value={row.group} onChange={(e) => patch(row.key, { group: e.target.value })}>{groupOptions(row.group)}</select></td>
              <td><select aria-label={`Category, record ${row.key}`} value={row.category} onChange={(e) => patch(row.key, { category: e.target.value })}><option value="">Uncategorized</option>{row.category && !context.categories.some((c) => String(c.id) === row.category) && <option value={row.category}>{row.category} (unrecognized)</option>}{context.categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}</select></td>
              <td>{textField("notes", "Notes")}</td><td>{errors.length ? <ul className="error" id={`bulk-errors-${row.key}`}>{errors.map((e) => <li key={e}>{e}</li>)}</ul> : <span className="positive">Ready</span>}<button className="link" aria-label={`Remove record ${row.key}`} onClick={() => setRows(rows.filter((r) => r.key !== row.key))}>Remove</button></td>
            </tr>;
          })}</tbody></table>
        </div>
        <div className="bulk-actions"><button className="secondary inline" onClick={() => setReviewing(false)}>Back to CSV</button><button className="inline" disabled={invalidCount > 0 || !rows.length || !engine} onClick={() => void save()}>{busy ? "Adding…" : `Add ${rows.length} ${rows.length === 1 ? "expense" : "expenses"}`}</button></div>
        <p className="muted">Back to CSV lets you reparse the source; reviewing again replaces your table corrections. Expenses are saved together on this device, then synced using the normal expense flow.</p>
      </>}
    </fieldset>
  </>;
}
