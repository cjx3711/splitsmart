import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_VERSION } from "./version.ts";

test("package.json version matches APP_VERSION", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(pkg.version, APP_VERSION);
});

test("changelog latest version matches APP_VERSION", () => {
  const changelog = readFileSync(new URL("../web/src/pages/Changelog.tsx", import.meta.url), "utf8");
  const match = changelog.match(/version:\s*"(\d+\.\d+\.\d+)"/);
  assert.ok(match, "changelog has a version");
  assert.equal(match[1], APP_VERSION);
});
