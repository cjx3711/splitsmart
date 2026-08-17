import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  generateToken,
  hashToken,
  PasswordError,
} from "./password.ts";

describe("password hashing", () => {
  test("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.ok(await verifyPassword("correct horse battery staple", hash));
  });

  test("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("wrong password here", hash), false);
  });

  test("produces a different hash each time (salted)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    assert.notEqual(a, b);
    assert.ok(await verifyPassword("same password", a));
    assert.ok(await verifyPassword("same password", b));
  });

  test("hash is self-describing", async () => {
    const hash = await hashPassword("some password");
    const parts = hash.split("$");
    assert.equal(parts.length, 6);
    assert.equal(parts[0], "scrypt");
    assert.equal(Number(parts[1]), 1 << 17);
  });

  test("rejects short passwords", async () => {
    await assert.rejects(() => hashPassword("short"), PasswordError);
  });

  test("rejects absurdly long passwords", async () => {
    await assert.rejects(() => hashPassword("x".repeat(2000)), PasswordError);
  });

  test("fails closed on a malformed stored hash", async () => {
    for (const bad of ["", "garbage", "scrypt$1$2$3", "argon2$x$y$z$a$b"]) {
      assert.equal(await verifyPassword("anything", bad), false);
    }
  });

  test("normalises unicode so equivalent inputs match", async () => {
    // "é" composed vs decomposed: same password to a human.
    const hash = await hashPassword("cafépassword");
    assert.ok(await verifyPassword("cafépassword", hash));
  });

  test("needsRehash flags weaker parameters", async () => {
    const current = await hashPassword("some password");
    assert.equal(needsRehash(current), false);
    assert.equal(needsRehash("scrypt$16384$8$1$c2FsdA$aGFzaA"), true);
    assert.equal(needsRehash("not-a-hash"), true);
  });
});

describe("tokens", () => {
  test("generates distinct high-entropy tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    assert.equal(tokens.size, 100);
    assert.ok(generateToken().length >= 42);
  });

  test("token hashing is deterministic and one-way", () => {
    const token = generateToken();
    assert.equal(hashToken(token), hashToken(token));
    assert.notEqual(hashToken(token), token);
  });

});
