/**
 * ZIP writer: a handful of text files round-trip as a real archive.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { zipFiles, zipFilenames, unzipFile } from "./zip.ts";

describe("zipFiles", () => {
  test("names come back in the order they were added", () => {
    const zip = zipFiles([
      { name: "README.txt", body: "hello\n" },
      { name: "expenses.csv", body: "date,cost\n" },
    ]);
    assert.deepEqual(zipFilenames(zip), ["README.txt", "expenses.csv"]);
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
  });

  test("deflated bodies inflate to the original UTF-8", () => {
    const body = 'The "Best" Café, downtown\n';
    const zip = zipFiles([{ name: "notes.csv", body }]);
    assert.equal(unzipFile(zip, "notes.csv"), body);
  });
});
