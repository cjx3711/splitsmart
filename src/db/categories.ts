/**
 * Splitwise's real category tree.
 *
 * CAPTURED FROM THE LIVE API, not a reconstruction. The raw response is kept
 * verbatim at fixtures/splitwise/get_categories.json, and this file is derived
 * from it. Both are checked in because Splitwise is moving API access behind a
 * paywall and this data becomes unobtainable.
 *
 * WHY THE REAL IDS MATTER: an imported expense or a client carrying a
 * Splitwise `category_id` must land on the same category here. Guessing is not
 * an option: the real ids are
 * non-sequential and interleaved (parents are 1, 2, 19, 25, 27, 31, 40 while
 * children are scattered from 3 to 50), and parents and children share ONE id
 * space rather than having separate ranges.
 *
 * Structure: exactly two levels. Splitwise's 7 parents and 43 leaves are
 * frozen (the tests diff them against the fixture). Only leaves are
 * assignable to an expense; parents exist purely as display groupings.
 * Extra native categories live in EXTRA_PARENTS / EXTRA_LEAVES, ids ≥ 51.
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
 * Splitwise's fallback leaf, "Uncategorized > General". Native create uses this
 * when an expense has no category.
 */
export const DEFAULT_CATEGORY_ID = 18;

/** Highest id in use, so locally-created categories can start above it. */
export const MAX_SPLITWISE_CATEGORY_ID = Math.max(
  ...CATEGORIES.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]),
);

/**
 * Categories Splitwise never shipped.
 *
 * Ids start at 51 so they cannot collide with a Splitwise id (the highest
 * captured one is 50). `splitwise_id` stays NULL: import still matches in the
 * Splitwise id space, and these only appear in the native picker. Do not reuse
 * a number ≤ 50, and do not rename or move a Splitwise row to "make room".
 *
 * EXTRA_PARENTS are whole new groups. EXTRA_LEAVES attach to an existing
 * Splitwise parent (Coffee under Food and drink, and so on).
 */
export const EXTRA_PARENTS: CategoryDefinition[] = [
  {
    id: 51,
    name: "Travel",
    children: [
      { id: 52, name: "Accommodation" },
      { id: 53, name: "Activities" },
      { id: 54, name: "Visas and fees" },
      { id: 55, name: "Souvenirs" },
    ],
  },
  {
    id: 56,
    name: "Health",
    children: [
      { id: 57, name: "Dental" },
      { id: 58, name: "Therapy" },
      { id: 59, name: "Fitness" },
      { id: 60, name: "Vision" },
    ],
  },
  {
    id: 61,
    name: "Work",
    children: [
      { id: 62, name: "Office" },
      { id: 63, name: "Software" },
      { id: 64, name: "Coworking" },
    ],
  },
  {
    id: 86,
    name: "Shopping",
    children: [
      { id: 87, name: "General" },
      { id: 88, name: "Online" },
    ],
  },
];

export interface ExtraLeaf {
  id: number;
  parentId: number;
  name: string;
}

export const EXTRA_LEAVES: ExtraLeaf[] = [
  { id: 65, parentId: 25, name: "Coffee" },
  { id: 66, parentId: 25, name: "Takeout" },
  { id: 67, parentId: 25, name: "Fast food" },
  { id: 68, parentId: 19, name: "Concerts" },
  { id: 69, parentId: 19, name: "Streaming" },
  { id: 70, parentId: 19, name: "Books" },
  { id: 71, parentId: 19, name: "Nightlife" },
  { id: 72, parentId: 19, name: "Hobbies" },
  { id: 73, parentId: 19, name: "Attractions" },
  { id: 74, parentId: 31, name: "Rideshare" },
  { id: 75, parentId: 31, name: "Tolls" },
  { id: 76, parentId: 31, name: "Car rental" },
  { id: 77, parentId: 31, name: "Vehicle" },
  { id: 78, parentId: 40, name: "Personal care" },
  { id: 79, parentId: 40, name: "Pharmacy" },
  { id: 80, parentId: 40, name: "Charity" },
  { id: 81, parentId: 40, name: "Subscriptions" },
  { id: 82, parentId: 40, name: "Laundry" },
  { id: 83, parentId: 27, name: "Garden" },
  { id: 84, parentId: 27, name: "Moving" },
  { id: 89, parentId: 40, name: "Kids" },
];

/** Highest id we seed. User-created rows, if they ever exist, start above this. */
export const MAX_SEEDED_CATEGORY_ID = Math.max(
  MAX_SPLITWISE_CATEGORY_ID,
  ...EXTRA_PARENTS.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]),
  ...EXTRA_LEAVES.map((c) => c.id),
);
