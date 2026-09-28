import assert from "node:assert/strict";
import { test } from "node:test";
// The browser's parseMoney delegates to this shared parser. Import it directly
// because the API client's parameter properties need compilation in Node tests.
import { parseAmount as parseMoney } from "../../src/domain/money.ts";
import { computeSplit } from "../../src/domain/split.ts";
import { parseBulkCsv, validateBulkRow, type BulkContext } from "./bulkAdd.ts";

test("grouped amounts work in the expense form's exact split without changing the total", () => {
  const amounts = ["1000", "1000", "3742", "3,742"];
  const shares = computeSplit(parseMoney("9,484", 0), "exact", amounts.map((amount, index) => ({
    userId: String(index), input: parseMoney(amount, 0), paidMinor: index === 0 ? 9484 : 0,
  })));
  assert.deepEqual(shares.map((share) => share.owedMinor), [1000, 1000, 3742, 3742]);
  assert.equal(parseMoney("3,742.50", 2), 374250);
  assert.equal(parseMoney("3\u202f742.00", 0), 3742);
  for (const bad of ["12,50", "3,742.001", "9007199254740992", "-."]) {
    assert.throws(() => parseMoney(bad, 2));
  }
});

test("CSV imports accept quoted grouped amounts through the same parser", () => {
  const context: BulkContext = {
    selfId: "me", people: [{ id: "me", name: "Me" }], groups: [], categories: [],
    currencies: [{ code: "JPY", decimal_places: 0 }],
  };
  const [row] = parseBulkCsv('date,description,amount\n2026-09-29,Dinner,"3,742"', context, {
    currency: "JPY", group: "", payer: "me", splitWith: ["me"],
  });
  assert.equal(validateBulkRow(row!, context).input!.costMinor, 3742);
});
