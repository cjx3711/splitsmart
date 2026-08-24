/**
 * Verifies our category tree against the REAL Splitwise response.
 *
 * fixtures/splitwise/get_categories.json was captured from the live API. These
 * tests diff src/db/categories.ts against it, so if anyone "tidies" the ids or
 * renames a category the mismatch surfaces immediately rather than silently
 * breaking category_id parity.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CATEGORIES,
  DEFAULT_CATEGORY_ID,
  EXTRA_LEAVES,
  EXTRA_PARENTS,
  MAX_SEEDED_CATEGORY_ID,
  MAX_SPLITWISE_CATEGORY_ID,
} from "./categories.ts";
import { CURRENCIES, LEGACY_CODES } from "./currencies.ts";

interface SwCategory {
  id: number;
  name: string;
  subcategories?: SwCategory[];
}

const fixture = JSON.parse(
  readFileSync("fixtures/splitwise/get_categories.json", "utf8"),
) as { categories: SwCategory[] };

const currencyFixture = JSON.parse(
  readFileSync("fixtures/splitwise/get_currencies.json", "utf8"),
) as { currencies: Array<{ currency_code: string; unit?: string }> };

describe("categories match the real Splitwise API", () => {
  test("same number of parents, in the same order", () => {
    assert.equal(CATEGORIES.length, fixture.categories.length);
    assert.deepEqual(
      CATEGORIES.map((c) => c.id),
      fixture.categories.map((c) => c.id),
    );
  });

  test("every parent id and name matches exactly", () => {
    for (const [i, expected] of fixture.categories.entries()) {
      const actual = CATEGORIES[i]!;
      assert.equal(actual.id, expected.id, `parent ${i} id`);
      assert.equal(actual.name, expected.name, `parent ${i} name`);
    }
  });

  test("every child id and name matches exactly", () => {
    for (const [i, expectedParent] of fixture.categories.entries()) {
      const actualParent = CATEGORIES[i]!;
      const expectedChildren = expectedParent.subcategories ?? [];

      assert.equal(
        actualParent.children.length,
        expectedChildren.length,
        `${expectedParent.name} child count`,
      );

      for (const [j, expectedChild] of expectedChildren.entries()) {
        const actualChild = actualParent.children[j]!;
        assert.equal(actualChild.id, expectedChild.id, `${expectedParent.name}[${j}] id`);
        assert.equal(actualChild.name, expectedChild.name, `${expectedParent.name}[${j}] name`);
      }
    }
  });

  test("ids are unique across parents AND children (one shared id space)", () => {
    const ids = CATEGORIES.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]);
    assert.equal(new Set(ids).size, ids.length, "duplicate category id");
  });

  test("the default category is Uncategorized > General", () => {
    const uncategorized = CATEGORIES.find((c) => c.name === "Uncategorized");
    assert.ok(uncategorized);
    const general = uncategorized.children.find((c) => c.id === DEFAULT_CATEGORY_ID);
    assert.equal(general?.name, "General");
  });

  test("MAX_SPLITWISE_CATEGORY_ID covers every Splitwise id", () => {
    const ids = CATEGORIES.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]);
    assert.equal(MAX_SPLITWISE_CATEGORY_ID, Math.max(...ids));
  });

  test("the tree is exactly two levels", () => {
    // Splitwise has no grandchildren; the native tree is the same shape.
    for (const parent of CATEGORIES) {
      for (const child of parent.children) {
        assert.equal(typeof child.id, "number");
        assert.ok(!("children" in child), `${child.name} has nested children`);
      }
    }
  });
});

describe("extra native categories stay above Splitwise's id space", () => {
  const splitwiseIds = new Set(
    CATEGORIES.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]),
  );
  const extraIds = [
    ...EXTRA_PARENTS.flatMap((p) => [p.id, ...p.children.map((c) => c.id)]),
    ...EXTRA_LEAVES.map((c) => c.id),
  ];
  const splitwiseParentIds = new Set(CATEGORIES.map((p) => p.id));

  test("every extra id is unique and greater than every Splitwise id", () => {
    assert.equal(new Set(extraIds).size, extraIds.length, "duplicate extra id");
    for (const id of extraIds) {
      assert.ok(id > MAX_SPLITWISE_CATEGORY_ID, `${id} collides with Splitwise`);
      assert.ok(!splitwiseIds.has(id), `${id} reuses a Splitwise id`);
    }
  });

  test("extra leaves attach to a real parent", () => {
    const extraParentIds = new Set(EXTRA_PARENTS.map((p) => p.id));
    for (const leaf of EXTRA_LEAVES) {
      assert.ok(
        splitwiseParentIds.has(leaf.parentId) || extraParentIds.has(leaf.parentId),
        `${leaf.name} parent ${leaf.parentId} is unknown`,
      );
    }
  });

  test("MAX_SEEDED_CATEGORY_ID covers Splitwise and extras", () => {
    assert.equal(MAX_SEEDED_CATEGORY_ID, Math.max(MAX_SPLITWISE_CATEGORY_ID, ...extraIds));
  });
});

describe("currencies cover the real Splitwise list", () => {
  const ours = new Set(CURRENCIES.map((c) => c.code));
  const theirs = currencyFixture.currencies.map((c) => c.currency_code);

  test("every Splitwise currency exists locally", () => {
    // A missing code is not cosmetic: currency_code is a foreign key, so an
    // expense denominated in it cannot be imported at all.
    const missing = theirs.filter((code) => !ours.has(code));
    assert.deepEqual(missing, [], `missing currencies: ${missing.join(", ")}`);
  });

  test("legacy codes Splitwise still lists are present", () => {
    // Demonetised currencies (HRK, LTL, VEF...) remain in Splitwise's list
    // because users have historical expenses in them.
    for (const code of ["HRK", "LTL", "VEF", "STD", "SLL", "BYR", "CUC", "ZWL", "BTC"]) {
      assert.ok(ours.has(code), `missing legacy code ${code}`);
      assert.ok(LEGACY_CODES.has(code), `${code} should be marked legacy`);
    }
  });

  test("BTC uses satoshi precision", () => {
    const btc = CURRENCIES.find((c) => c.code === "BTC");
    assert.equal(btc?.decimals, 8);
  });

  test("no decimal place exceeds the schema CHECK", () => {
    // migrations/001 sets this CHECK to 0..8 specifically to fit BTC.
    for (const c of CURRENCIES) {
      assert.ok(c.decimals >= 0 && c.decimals <= 8, `${c.code}: ${c.decimals}`);
    }
  });
});
