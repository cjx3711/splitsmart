import { useState } from "react";
import { localToday, shiftExpenseDate } from "./expenseDate.ts";

export function ExpenseDateField({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [showDate, setShowDate] = useState(false);
  const today = localToday();
  const label = value
    ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
      })
    : "Choose a date";

  return (
    <div className="expense-date stack-tight" role="group" aria-label="Expense date">
      <div className="expense-date-heading">
        <span className="expense-date-label">Date</span>
        <time dateTime={value || undefined} className="split-hint" aria-live="polite">{label}</time>
      </div>
      <div className="expense-date-buttons">
        <button type="button" className="secondary inline" aria-pressed={value === today} onClick={() => onChange(localToday())}>
          Today
        </button>
        <button type="button" className="secondary inline" aria-label="Previous day" onClick={() => onChange(shiftExpenseDate(value, -1))}>−</button>
        <button type="button" className="secondary inline" aria-label="Next day" onClick={() => onChange(shiftExpenseDate(value, 1))}>+</button>
        <button type="button" className="secondary inline" aria-expanded={showDate} aria-controls="expense-full-date" onClick={() => setShowDate((show) => !show)}>
          {showDate ? "Hide date field" : "Choose date"}
        </button>
      </div>
      {showDate && (
        <div id="expense-full-date">
          <input id="date" aria-label="Date" type="date" min="0001-01-01" max="9999-12-31" value={value} onChange={(event) => onChange(event.target.value)} required />
        </div>
      )}
    </div>
  );
}
