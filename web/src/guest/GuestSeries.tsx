/**
 * Every bill in a repeating series, seen through a guest link.
 *
 * Guests cannot start or stop a series, but they can see the bills they are on.
 * There is no Dexie here: the list is whatever the link currently allows.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { ExpenseDetail, ExpenseSummary } from "../api.ts";
import { SeriesView } from "../SeriesView.tsx";
import { seriesCrumbs } from "./guestCrumbs.ts";
import { useGuest } from "./GuestApp.tsx";
import { guestApi, guestFullName } from "./guestApi.ts";
import {
  isRepeatInterval,
  seriesTemplateId,
  type RepeatInterval,
} from "../../../src/domain/recurring.ts";

interface SeriesPayload {
  templateId: string;
  title: string;
  interval: RepeatInterval | null;
  nextRepeat: string | null;
  stoppedReason: "deleted" | "ended" | null;
  bills: ExpenseSummary[];
  groupId: string | null;
  groupName: string | null;
}

export function GuestSeries() {
  const { id } = useParams<{ id: string }>();
  const { session } = useGuest();
  const me = session.actingAs!;

  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [view, setView] = useState<SeriesPayload | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [{ expense: seed }, listed] = await Promise.all([
        guestApi.expense(id),
        guestApi.expenses(),
      ]);
      const templateId = seriesTemplateId(seed.id, seed.repeat_of, seed.repeat_interval);
      if (!templateId) {
        setView(null);
        setMissing(true);
        return;
      }

      const template = await loadTemplate(seed, templateId);
      const bills = listed.expenses
        .filter((e) => e.id === templateId || e.repeat_of === templateId)
        .sort(byDateAsc);

      const interval =
        template && isRepeatInterval(template.repeat_interval) ? template.repeat_interval : null;
      const stoppedReason: "deleted" | "ended" | null =
        template === null ? "deleted" : interval === null ? "ended" : null;
      const head = template ?? seed;

      setView({
        templateId,
        title: head.is_payment === 1 ? "Settle up" : head.description,
        interval,
        nextRepeat: stoppedReason ? null : (template?.next_repeat ?? null),
        stoppedReason,
        bills,
        groupId: head.group_id,
        groupName: head.group_name,
      });
      setMissing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this series");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (missing) return <p className="empty">This expense is not part of a repeating series.</p>;
  if (!view) return <p className="muted">Loading…</p>;

  const nameOf = (userId: string) => {
    if (userId === me.id) return "You";
    const person = session.people.find((p) => p.id === userId);
    return person ? guestFullName(person) : `User ${userId}`;
  };

  return (
    <SeriesView
      title={view.title}
      interval={view.interval}
      nextRepeat={view.nextRepeat}
      stoppedReason={view.stoppedReason}
      bills={view.bills}
      currentUserId={me.id}
      nameOf={nameOf}
      trail={seriesCrumbs(session, {
        expenseId: view.templateId,
        groupId: view.groupId,
        groupName: view.groupName,
        title: view.title,
      })}
      personLinks={false}
    />
  );
}

async function loadTemplate(
  seed: ExpenseDetail,
  templateId: string,
): Promise<ExpenseDetail | null> {
  if (seed.id === templateId) return seed;
  try {
    return (await guestApi.expense(templateId)).expense;
  } catch {
    return null;
  }
}

function byDateAsc(a: ExpenseSummary, b: ExpenseSummary): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}
