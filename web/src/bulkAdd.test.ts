import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bulkPrompt, MAX_BULK_ROWS, parseBulkCsv, readCsv, validateBulkRow, type BulkContext, type BulkDefaults } from "./bulkAdd.ts";
import { computeSplit } from "../../src/domain/split.ts";

const context: BulkContext = {
  selfId: "me-id",
  people: [{ id: "me-id", name: "Alice" }, { id: "bob-id", name: "Bob", nickname: "Bobby", email: "bob@example.com" }, { id: "sam1", name: "Sam" }, { id: "sam2", name: "Sam" }],
  groups: [{ id: "trip-id", name: "Trip", memberIds: ["me-id", "bob-id"] }],
  categories: [{ id: 1, name: "Dining out", path: "Food · Dining out" }, { id: 2, name: "Other", path: "Food · Other" }, { id: 3, name: "Other", path: "Travel · Other" }],
  currencies: [{ code: "USD", decimal_places: 2 }, { code: "JPY", decimal_places: 0 }, { code: "KWD", decimal_places: 3 }],
};
const defaults: BulkDefaults = { group: "", currency: "USD", payer: "me-id", splitWith: ["me-id", "bob-id"] };
const row = () => parseBulkCsv("date,description,amount\n2026-09-24,Dinner,10.01", context, defaults)[0]!;

describe("CSV bulk add", () => {
  it("handles BOM, CRLF, escaped quotes, commas, multiline notes and blank lines", () => {
    assert.deepEqual(readCsv('\uFEFFdate,description,notes\r\n2026-09-24,"Dinner, \\"friends\\"","line 1\r\nline 2"\r\n'.replaceAll('\\"', '""')), [
      ["date", "description", "notes"], ["2026-09-24", 'Dinner, "friends"', "line 1\r\nline 2"],
    ]);
    assert.equal(readCsv("a,b\n\n1,2\n\n").length, 2);
  });
  it("refuses malformed records and unsupported columns instead of discarding data", () => {
    for (const text of ['a,b\n"unclosed,b', 'a,b\na"b,c', 'a,b\n"a"oops,b']) assert.throws(() => readCsv(text));
    assert.throws(() => parseBulkCsv("date,description,amount\n2026-01-01,Taxi,10,USD", context, defaults), /Record 2/);
    assert.throws(() => parseBulkCsv("date,description,amount,repeats\n2026-01-01,Taxi,10,monthly", context, defaults), /Unsupported/);
    assert.throws(() => parseBulkCsv("date,description,amount,amount\n2026-01-01,Taxi,10,10", context, defaults), /unique/);
    assert.throws(() => parseBulkCsv("description,amount\nTaxi,10", context, defaults), /date/);
    assert.throws(() => parseBulkCsv("date,description,amount", context, defaults), /no expenses/);
  });
  it("bounds file size and record count without truncating", () => {
    assert.throws(() => parseBulkCsv("x".repeat(2 * 1024 * 1024 + 1), context, defaults), /2 MB/);
    assert.throws(() => parseBulkCsv("date,description,amount\n" + "2026-01-01,Dinner,1\n".repeat(MAX_BULK_ROWS + 1), context, defaults), /at most/);
    assert.equal(parseBulkCsv("date,description,amount\n" + "2026-01-01,Dinner,1\n".repeat(MAX_BULK_ROWS), context, defaults).length, MAX_BULK_ROWS);
  });
  it("resolves unique names, nicknames, emails, groups and categories", () => {
    const [parsed] = parseBulkCsv("date,description,amount,currency,paid_by,split_with,group,category\n2026-09-24,Dinner,1234,jpy,bob@example.com,me;Bobby,Trip,dining_out", context, defaults);
    assert.equal(parsed!.payer, "bob-id");
    assert.deepEqual(parsed!.splitWith, ["me-id", "bob-id"]);
    assert.equal(parsed!.group, "trip-id");
    assert.equal(parsed!.category, "1");
    assert.equal(validateBulkRow(parsed!, context).input!.costMinor, 1234);
  });
  it("leaves ambiguous people and categories unresolved until explicitly corrected", () => {
    const [parsed] = parseBulkCsv("date,description,amount,paid_by,split_with,category\n2026-09-24,Dinner,10,Sam,me;Sam,Other", context, defaults);
    assert.equal(parsed!.payer, "Sam");
    assert.equal(parsed!.category, "Other");
    assert.equal(validateBulkRow(parsed!, context).input, undefined);
    assert.ok(validateBulkRow({ ...parsed!, payer: "sam1", splitWith: ["me-id", "sam1"], category: "2" }, context).input);
  });
  it("rejects impossible dates, precision loss, negative amounts, overflow and invalid currency", () => {
    for (const patch of [{ date: "2026-02-30" }, { date: "yesterday" }, { amount: "1.234" }, { amount: "12.50", currency: "JPY" }, { amount: "-1" }, { amount: "0" }, { amount: "999999999999999999999" }, { currency: "XYZ" }]) {
      assert.ok(validateBulkRow({ ...row(), ...patch }, context).errors.length, JSON.stringify(patch));
    }
    assert.equal(validateBulkRow({ ...row(), amount: "1.234", currency: "KWD" }, context).input!.costMinor, 1234);
    assert.equal(validateBulkRow({ ...row(), amount: "1234", currency: "JPY" }, context).input!.costMinor, 1234);
  });
  it("checks group membership, payer, participant selection and non-group self inclusion", () => {
    for (const patch of [{ group: "missing" }, { group: "trip-id", payer: "sam1" }, { group: "trip-id", splitWith: ["sam1"] }, { payer: "bob-id", splitWith: ["sam1"] }, { splitWith: [] }]) {
      assert.ok(validateBulkRow({ ...row(), ...patch }, context).errors.length);
    }
  });
  it("supports equal splits and one-sided debts using the shared split engine", () => {
    const input = validateBulkRow(row(), context).input!;
    const shares = computeSplit(input.costMinor, input.splitType, input.participants);
    assert.equal(shares.reduce((sum, share) => sum + share.owedMinor, 0), 1001);
    const oneSided = validateBulkRow({ ...row(), payer: "bob-id", splitWith: ["me-id"] }, context).input!;
    const debt = computeSplit(oneSided.costMinor, oneSided.splitType, oneSided.participants);
    assert.equal(debt.find((p) => p.userId === "me-id")!.owedMinor, 1001);
    assert.equal(debt.find((p) => p.userId === "bob-id")!.owedMinor, 0);
  });
  it("selects the CSV group's members for missing split fields and includes concrete IDs in the prompt", () => {
    const [parsed] = parseBulkCsv("date,description,amount,group\n2026-09-24,Dinner,10,Trip", context, { ...defaults, splitWith: [] });
    assert.deepEqual(parsed!.splitWith, ["me-id", "bob-id"]);
    const prompt = bulkPrompt(context, defaults);
    assert.match(prompt, /date,description,amount,currency,paid_by,split_with,group,category,notes/);
    assert.match(prompt, /bob-id/);
    assert.match(prompt, /Food · Dining out/);
    assert.match(prompt, /Never convert currencies/);
  });
});

describe("compact bulk prompts", () => {
  const self = "01M0TEV4HAN92758Y0SELF0001";
  const bob = "01M0TEV4HAN92758Y0FRIEND02";
  const other = "01M0TEV4HAN92758Y0OTHER003";
  const group = "01M0TEV4HAN92758Y0GROUP001";
  const scoped: BulkContext = {
    ...context, selfId: self,
    people: [{ id: self, name: "Alice" }, { id: bob, name: "Bob" }, { id: other, name: "Unrelated person" }],
    groups: [
      { id: group, name: "Japan trip", memberIds: [self, bob], defaultCurrency: "JPY" },
      { id: "01M0TEV4HAN92758Y0GROUP002", name: "Unrelated group", memberIds: [self, other] },
    ],
  };
  const selected: BulkDefaults = { payer: self, splitWith: [self, bob], group, currency: "JPY" };

  it("explains expense sharing and includes only selected people, group and currency", () => {
    const prompt = bulkPrompt(scoped, selected);
    assert.match(prompt, /expense-sharing service.*who owes whom/);
    assert.match(prompt, /SELF0001: "Alice"/);
    assert.match(prompt, /FRIEND02: "Bob"/);
    assert.match(prompt, /Group: "Japan trip".*GROUP001/);
    assert.match(prompt, /JPY \(0 decimal places\)/);
    for (const absent of [self, bob, group, "Unrelated person", "Unrelated group", "OTHER003", "GROUP002", "USD", "KWD"])
      assert.ok(!prompt.includes(absent), `${absent} should not be included`);
  });

  it("narrows to a selected subset while retaining a payer who does not owe a share", () => {
    const largerGroup = { ...scoped, groups: [{ ...scoped.groups[0]!, memberIds: [self, bob, other] }] };
    const prompt = bulkPrompt(largerGroup, { ...selected, splitWith: [bob] });
    assert.match(prompt, /SELF0001: "Alice"/);
    assert.match(prompt, /Default split_with: FRIEND02/);
    assert.ok(!prompt.includes("Unrelated person"));
  });

  it("keeps friend and unselected imports from dumping the whole account", () => {
    const prompt = bulkPrompt(scoped, { ...selected, group: "" });
    assert.match(prompt, /FRIEND02: "Bob"/);
    assert.match(prompt, /No group selected/);
    assert.ok(!prompt.includes("Japan trip"));
    assert.ok(!prompt.includes("Unrelated person"));
    const empty = bulkPrompt(scoped, { ...selected, group: "", splitWith: [] });
    assert.ok(!empty.includes("Bob"));
    assert.match(empty, /Default split_with: REVIEW_REQUIRED/);
  });

  it("round trips prompt short IDs into full ledger IDs, including group IDs", () => {
    const [parsed] = parseBulkCsv("date,description,amount,paid_by,split_with,group\n2026-09-29,Dinner,1200,FRIEND02,SELF0001;FRIEND02,GROUP001", scoped, selected);
    assert.equal(parsed!.group, group);
    assert.equal(parsed!.payer, bob);
    assert.deepEqual(parsed!.splitWith, [self, bob]);
    assert.equal(parsed!.currency, "JPY");
    assert.equal(validateBulkRow(parsed!, scoped).input!.costMinor, 1200);
  });

  it("extends colliding suffixes across the whole account and refuses ambiguous input", () => {
    const collision = "01M0TEV4HAN92758Z0FRIEND02";
    const withCollision = { ...scoped, people: [...scoped.people, { id: collision, name: "Outside group" }] };
    const prompt = bulkPrompt(withCollision, selected);
    assert.match(prompt, /Y0FRIEND02: "Bob"/);
    assert.ok(!prompt.includes("Outside group"));
    const csv = (payer: string) => `date,description,amount,paid_by\n2026-09-29,Dinner,1200,${payer}`;
    const [ambiguous] = parseBulkCsv(csv("FRIEND02"), withCollision, selected);
    assert.equal(ambiguous!.payer, "FRIEND02");
    assert.equal(validateBulkRow(ambiguous!, withCollision).input, undefined);
    const [resolved] = parseBulkCsv(csv("Y0FRIEND02"), withCollision, selected);
    assert.equal(resolved!.payer, bob);
    assert.ok(validateBulkRow(resolved!, withCollision).input);
  });

  it("does not confuse an ID suffix with another person's name or an out-of-group person", () => {
    const withName = { ...scoped, people: [...scoped.people, { id: "01M0TEV4HAN92758Y0NAMED004", name: "FRIEND02" }] };
    assert.match(bulkPrompt(withName, selected), /0FRIEND02: "Bob"/);
    const [ambiguous] = parseBulkCsv("date,description,amount,paid_by\n2026-09-29,Dinner,1200,FRIEND02", withName, selected);
    assert.equal(validateBulkRow(ambiguous!, withName).input, undefined);
    const [outside] = parseBulkCsv("date,description,amount,paid_by\n2026-09-29,Dinner,1200,OTHER003", scoped, selected);
    assert.equal(outside!.payer, other);
    assert.equal(validateBulkRow(outside!, scoped).input, undefined);
  });
});
