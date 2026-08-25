/**
 * The shared request shape for creating an expense.
 *
 * Group expenses and one-on-one expenses accept the same body; they differ
 * only in who is allowed to appear in `participants`, which each route enforces
 * for itself. The schema lives here so a new split type cannot be added to one
 * endpoint and forgotten on the other.
 *
 * Validation here is structural only: shapes, ranges, and types. Whether the
 * numbers actually add up is the split engine's job (src/domain/split.ts), and
 * duplicating those rules in Zod would just create two places to be wrong.
 */
import { z } from "zod";
import { isUlid } from "../../domain/ulid.ts";
import { REPEAT_INTERVALS } from "../../domain/recurring.ts";

export const ulidSchema = z.string().refine(isUlid, { message: "Invalid id" });

export const splitTypeSchema = z.enum([
  "equal",
  "exact",
  "percent",
  "shares",
  "adjustment",
  "itemized",
]);

export const participantSchema = z.object({
  userId: ulidSchema,
  paidMinor: z.number().int().min(0),
  /**
   * Per-person figure whose meaning depends on splitType: minor units for
   * exact and adjustment, a percentage for percent, a count for shares. Not an
   * integer, because percentages and share counts are legitimately fractional.
   */
  input: z.number().optional(),
});

export const itemSchema = z.object({
  label: z.string().max(200).nullable().optional(),
  amountMinor: z.number().int().min(0),
  participantIds: z.array(ulidSchema).min(1),
});

/**
 * Capped at 200 lines. A restaurant bill does not have a thousand lines, and
 * split_meta is read back whole on every expense load, so an unbounded list is
 * a payload-size problem rather than a feature.
 *
 * `taxMinor` / `tipMinor` are itemized-only and are NOT a third split
 * mechanism: they are the named part of the gap between the lines and the
 * total, which the engine already spreads in proportion to what each person
 * ordered. They are carried so the editor can reopen the bill with the same
 * two boxes the user typed into, and createExpense checks they agree with that
 * gap rather than trusting them.
 */
export const expenseBodyFields = {
  description: z.string().min(1).max(500),
  details: z.string().max(5000).optional(),
  costMinor: z.number().int().min(0),
  currencyCode: z.string().length(3).toUpperCase(),
  date: z.string(),
  categoryId: z.number().int().positive().nullable().optional(),
  splitType: splitTypeSchema,
  participants: z.array(participantSchema).min(1),
  items: z.array(itemSchema).min(1).max(200).optional(),
  taxMinor: z.number().int().min(0).optional(),
  tipMinor: z.number().int().min(0).optional(),
  /**
   * Makes this a recurring template. THREE STATES, and they differ:
   *
   *   absent  leave the schedule as it is (what the guest editor and the
   *           settle-up form send, since neither has a repeat control)
   *   null    stop repeating
   *   a value repeat on that interval
   *
   * `next_repeat` is never accepted from a client; the server derives it from the
   * expense's own date, because the schedule belongs to the server clock.
   */
  repeatInterval: z.enum(REPEAT_INTERVALS).nullable().optional(),
  /** Client-minted expense id. Absent: the server mints one. */
  id: ulidSchema.optional(),
  /**
   * A client-owned bag, merged into `metadata.extra` rather than replacing it
   * (src/domain/metadata.ts: metadataWithExtra). Absent on a PATCH means
   * "leave it alone" - every other web-UI edit must not erase what a client
   * like the finance toolkit wrote here.
   */
  extra: z
    .record(z.unknown())
    .refine((v) => JSON.stringify(v).length <= 4096, "extra must serialize to 4KB or less")
    .optional(),
} as const;

/**
 * The itemized-only rules, applied to every variant of the body so a new
 * endpoint cannot accidentally accept line items on a percent split.
 *
 * A superRefine rather than a chain of .refine() calls because superRefine
 * leaves the object's inferred type alone; a plain .refine() on a generic
 * would widen every field to `any` at the call sites.
 */
function checkItemRules(
  body: {
    splitType: z.infer<typeof splitTypeSchema>;
    items?: unknown;
    taxMinor?: number;
    tipMinor?: number;
  },
  ctx: z.RefinementCtx,
): void {
  if (body.splitType === "itemized") {
    if (body.items === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An itemized split needs line items",
        path: ["items"],
      });
    }
    return;
  }

  if (body.items !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Line items are only meaningful for an itemized split",
      path: ["items"],
    });
  }
  if (body.taxMinor !== undefined || body.tipMinor !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Tax and tip are only meaningful for an itemized split",
      path: ["taxMinor"],
    });
  }
}

export const expenseBodySchema = z.object(expenseBodyFields).superRefine(checkItemRules);

/**
 * The same body plus the group it belongs to, for the endpoint that is not
 * already scoped to one. A null group is a non-group expense (Splitwise's
 * "Non-group expenses" bucket, not a missing value.
 */
export const genericExpenseBodySchema = z
  .object({
    ...expenseBodyFields,
    groupId: ulidSchema.nullable().optional(),
  })
  .superRefine(checkItemRules);
