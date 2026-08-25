import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ORIGIN_PLACEHOLDER, applyAppOrigin } from "./open-graph.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("applyAppOrigin", () => {
  test("substitutes the placeholder and strips a trailing slash", () => {
    assert.equal(
      applyAppOrigin(
        `content="${APP_ORIGIN_PLACEHOLDER}/og.png"`,
        "https://splitsmart.example/",
      ),
      'content="https://splitsmart.example/og.png"',
    );
  });
});

describe("marketing Open Graph", () => {
  test("the shell names the share image with the same placeholder Hono rewrites", () => {
    const html = readFileSync(resolve(root, "web/index.html"), "utf8");
    assert.match(html, new RegExp(`property="og:title"`));
    assert.match(
      html,
      new RegExp(`content="${APP_ORIGIN_PLACEHOLDER}/og.png"`),
    );
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
  });
});
