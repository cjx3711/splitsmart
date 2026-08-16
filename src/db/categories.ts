/**
 * Splitwise's real category tree.
 *
 * CAPTURED FROM THE LIVE API — not a reconstruction. The raw response is kept
 * verbatim at fixtures/splitwise/get_categories.json, and this file is derived
 * from it. Both are checked in because Splitwise is moving API access behind a
 * paywall and this data becomes unobtainable.
 *
 * WHY THE REAL IDS MATTER: `category_id` is passed straight through to the
 * compat API, so any client or imported expense carrying a Splitwise id must
 * land on the same category here. Guessing is not an option — the real ids are
 * non-sequential and interleaved (parents are 1, 2, 19, 25, 27, 31, 40 while
 * children are scattered from 3 to 50), and parents and children share ONE id
 * space rather than having separate ranges.
 *
 * Structure: exactly two levels, 7 parents and 43 leaves. Only leaves are
 * assignable to an expense; parents exist purely as display groupings.
 *
 * Ordering below is the API's own, preserved so our get_categories response
 * matches Splitwise's ordering as well as its contents.
 */

export interface CategoryDefinition {
  id: number;
  name: string;
  children: Array<{ id: number; name: string }>;
}

/** [parentId, parentName, [[childId, childName], ...]] */
const RAW: Array<[number, string, Array<[number, string]>]> = [
  [1, "Utilities", [
    [48, "Cleaning"],
    [5, "Electricity"],
    [6, "Heat/gas"],
    [11, "Other"],
    [37, "Trash"],
    [8, "TV/Phone/Internet"],
    [7, "Water"]
  ]],
  [2, "Uncategorized", [
    [18, "General"]
  ]],
  [19, "Entertainment", [
    [20, "Games"],
    [21, "Movies"],
    [22, "Music"],
    [23, "Other"],
    [24, "Sports"]
  ]],
  [25, "Food and drink", [
    [13, "Dining out"],
    [12, "Groceries"],
    [38, "Liquor"],
    [26, "Other"]
  ]],
  [27, "Home", [
    [39, "Electronics"],
    [16, "Furniture"],
    [14, "Household supplies"],
    [17, "Maintenance"],
    [4, "Mortgage"],
    [28, "Other"],
    [29, "Pets"],
    [3, "Rent"],
    [30, "Services"]
  ]],
  [31, "Transportation", [
    [46, "Bicycle"],
    [32, "Bus/train"],
    [15, "Car"],
    [33, "Gas/fuel"],
    [47, "Hotel"],
    [34, "Other"],
    [9, "Parking"],
    [35, "Plane"],
    [36, "Taxi"]
  ]],
  [40, "Life", [
    [50, "Childcare"],
    [41, "Clothing"],
    [49, "Education"],
    [42, "Gifts"],
    [10, "Insurance"],
    [43, "Medical expenses"],
    [44, "Other"],
    [45, "Taxes"]
  ]],];

export const CATEGORIES: CategoryDefinition[] = RAW.map(([id, name, children]) => ({
  id,
  name,
  children: children.map(([childId, childName]) => ({ id: childId, name: childName })),
}));

/**
 * Splitwise's fallback leaf, "Uncategorized > General". The compat layer names
 * this when an expense has no category, matching what Splitwise returns.
 */
export const DEFAULT_CATEGORY_ID = 18;

/** Highest id in use, so locally-created categories can start above it. */
export const MAX_SPLITWISE_CATEGORY_ID = Math.max(
  ...CATEGORIES.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]),
);
