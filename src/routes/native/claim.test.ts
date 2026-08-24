/**
 * Claim and link management: who may mint, and who may become whom.
 *
 * The single most important test in this file is "a logged-in user with no
 * link cannot eat a random placeholder". Without the link token in the body,
 * claim would be a way to attach yourself to a stranger's ledger by guessing a
 * ULID, and every balance that placeholder was part of would silently become
 * yours. See docs/GUEST.md.
 *
 * DATABASE_PATH is set before importing anything that reaches src/db/index.ts.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-claim-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db, sqlite, transaction } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { ulid } = await import("../../domain/ulid.ts");

let ownerId: string;
let ownerToken: string;
let claimerId: string;
let claimerToken: string;
let outsiderToken: string;

async function makeAccount(name: string): Promise<{ id: string; token: string }> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      email: `${name}-${id}@example.com`.toLowerCase(),
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name,
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();
  return { id, token: (await createApiToken(id, "test")).token };
}

async function makeGhost(name: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({ id, name, default_currency: "USD", is_ghost: 1 })
    .execute();
  return id;
}

async function makeGroup(name: string, members: string[]): Promise<string> {
  const id = ulid();
  await db
    .insertInto("groups")
    .values({ id, name, group_type: "trip", default_currency: "USD", created_by: ownerId })
    .execute();
  for (const userId of members) {
    await db
      .insertInto("group_members")
      .values({
        group_id: id,
        user_id: userId,
        role: userId === ownerId ? "owner" : "member",
        joined_via: userId === ownerId ? "creator" : "added",
      })
      .execute();
  }
  return id;
}

async function mintFor(input: {
  kind: "group" | "group_member" | "friend";
  groupId?: string | null;
  userId?: string | null;
}): Promise<string> {
  const minted = await transaction((trx) =>
    mintAccessLink(trx, { ...input, createdBy: ownerId }),
  );
  return minted.secret;
}

function as(token: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  const owner = await makeAccount("Olive");
  ownerId = owner.id;
  ownerToken = owner.token;

  const claimer = await makeAccount("Alicia");
  claimerId = claimer.id;
  claimerToken = claimer.token;

  outsiderToken = (await makeAccount("Outsider")).token;
});

after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("minting links", () => {
  test("returns the URL at mint and again when listed", async () => {
    const ghost = await makeGhost("Alice");
    const groupId = await makeGroup("Mintable", [ownerId, ghost]);

    const res = await as(ownerToken, "/api/v1/links", {
      method: "POST",
      body: JSON.stringify({ kind: "group", groupId }),
    });
    assert.equal(res.status, 201);
    const minted = await json<{ id: string; url: string; expiresAt: string }>(res);
    assert.match(minted.url, /\/guest\/l\/.+/);
    assert.ok(minted.expiresAt);

    const listed = await json<{ links: Array<{ id: string; url: string | null }> }>(
      await as(ownerToken, `/api/v1/links?groupId=${groupId}`),
    );
    assert.equal(listed.links.length, 1);
    assert.equal(listed.links[0]!.url, minted.url);
  });

  test("defaults expiry to 3 months and caps longer requests", async () => {
    const ghost = await makeGhost("Bob");
    const groupId = await makeGroup("Expiry", [ownerId, ghost]);

    const defaultMint = await json<{ expiresAt: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "group", groupId }),
      }),
    );
    const defaultExpiry = new Date(defaultMint.expiresAt).getTime();
    const ninetyDays = Date.now() + 90 * 86_400_000;
    assert.ok(Math.abs(defaultExpiry - ninetyDays) < 60_000);

    const capped = await json<{ expiresAt: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({
          kind: "group",
          groupId,
          expiresAt: new Date(Date.now() + 120 * 86_400_000).toISOString(),
        }),
      }),
    );
    const cappedExpiry = new Date(capped.expiresAt).getTime();
    assert.ok(Math.abs(cappedExpiry - ninetyDays) < 60_000);
  });

  test("rotating the general link does not kill the member links", async () => {
    const ghost = await makeGhost("Alice");
    const groupId = await makeGroup("Rotation", [ownerId, ghost]);

    const general = await json<{ url: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "group", groupId }),
      }),
    );
    const member = await json<{ url: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "group_member", groupId, userId: ghost }),
      }),
    );

    const oldGeneral = general.url.split("/guest/l/")[1]!;
    const memberSecret = member.url.split("/guest/l/")[1]!;

    // Minting the same slot again IS the rotation.
    const rotated = await json<{ url: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "group", groupId }),
      }),
    );
    const newGeneral = rotated.url.split("/guest/l/")[1]!;
    assert.notEqual(newGeneral, oldGeneral);

    const check = (secret: string) =>
      app.request("/api/v1/guest/session", {
        headers: { Authorization: `Bearer link_${secret}` },
      });

    assert.equal((await check(oldGeneral)).status, 401, "the old secret dies immediately");
    assert.equal((await check(newGeneral)).status, 200);
    assert.equal((await check(memberSecret)).status, 200, "the member link is untouched");
  });

  test("revoking a member link leaves the general one alone", async () => {
    const ghost = await makeGhost("Alice");
    const groupId = await makeGroup("Independence", [ownerId, ghost]);

    const general = await json<{ url: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "group", groupId }),
      }),
    );
    const member = await json<{ id: string; url: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "group_member", groupId, userId: ghost }),
      }),
    );

    assert.equal(
      (await as(ownerToken, `/api/v1/links/${member.id}`, { method: "DELETE" })).status,
      200,
    );

    const generalSecret = general.url.split("/guest/l/")[1]!;
    const memberSecret = member.url.split("/guest/l/")[1]!;

    const check = (secret: string) =>
      app.request("/api/v1/guest/session", {
        headers: { Authorization: `Bearer link_${secret}` },
      });

    assert.equal((await check(memberSecret)).status, 401);
    assert.equal(
      (await check(generalSecret)).status,
      200,
      "they can still pick themselves there until you turn that off too",
    );
  });

  test("removing a member from a group revokes their member link", async () => {
    const ghost = await makeGhost("Alice");
    const groupId = await makeGroup("Removal", [ownerId, ghost]);

    const member = await json<{ url: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "group_member", groupId, userId: ghost }),
      }),
    );
    const secret = member.url.split("/guest/l/")[1]!;

    assert.equal(
      (await as(ownerToken, `/api/v1/groups/${groupId}/members/${ghost}`, { method: "DELETE" }))
        .status,
      200,
    );

    const res = await app.request("/api/v1/guest/session", {
      headers: { Authorization: `Bearer link_${secret}` },
    });
    assert.equal(res.status, 401, "a removal that leaves a working door open is not one");
  });

  test("only the group owner may mint, and never for a real account", async () => {
    const ghost = await makeGhost("Alice");
    const groupId = await makeGroup("Guarded", [ownerId, ghost, claimerId]);

    // A plain member is not the owner.
    assert.equal(
      (
        await as(claimerToken, "/api/v1/links", {
          method: "POST",
          body: JSON.stringify({ kind: "group", groupId }),
        })
      ).status,
      403,
    );

    // Not a member at all.
    assert.equal(
      (
        await as(outsiderToken, "/api/v1/links", {
          method: "POST",
          body: JSON.stringify({ kind: "group", groupId }),
        })
      ).status,
      403,
    );

    // A link that acts as someone with a password would be impersonation.
    const res = await as(ownerToken, "/api/v1/links", {
      method: "POST",
      body: JSON.stringify({ kind: "group_member", groupId, userId: claimerId }),
    });
    assert.equal(res.status, 400);
    assert.match((await json<{ error: string }>(res)).error, /own account/i);
  });

  test("lists a friend link by friendId for the signed-in owner", async () => {
    const ghost = await makeGhost("Pat");
    await makeGroup("One-on-one", [ownerId, ghost]);

    const minted = await json<{ url: string }>(
      await as(ownerToken, "/api/v1/links", {
        method: "POST",
        body: JSON.stringify({ kind: "friend", userId: ghost }),
      }),
    );
    assert.match(minted.url, /\/guest\/l\/.+/);

    const listed = await json<{ links: Array<{ url: string | null }> }>(
      await as(ownerToken, `/api/v1/links?friendId=${ghost}`),
    );
    assert.equal(listed.links.length, 1);
    assert.equal(listed.links[0]!.url, minted.url);

    assert.equal(
      (await app.request(`/api/v1/links?friendId=${ghost}`)).status,
      401,
      "no session is unauthorized, not a missing friend",
    );
  });
});

describe("claim candidates", () => {
  test("a member opening a group link is sent to the app, not offered a picker", async () => {
    const ghost = await makeGhost("Alice");
    const groupId = await makeGroup("Already in it", [ownerId, ghost, claimerId]);
    const secret = await mintFor({ kind: "group", groupId });

    const body = await json<{ status: string; group: { id: string } }>(
      await as(claimerToken, "/api/v1/claim/candidates", {
        method: "POST",
        body: JSON.stringify({ linkToken: `link_${secret}` }),
      }),
    );

    assert.equal(body.status, "already_member");
    assert.equal(body.group.id, groupId);
  });

  test("a non-member is offered the unclaimed ghosts and nobody else", async () => {
    const alice = await makeGhost("Alice");
    const bob = await makeGhost("Bob");
    const groupId = await makeGroup("Claimable", [ownerId, alice, bob]);
    const secret = await mintFor({ kind: "group", groupId });

    const body = await json<{ status: string; candidates: Array<{ id: string }> }>(
      await as(claimerToken, "/api/v1/claim/candidates", {
        method: "POST",
        body: JSON.stringify({ linkToken: `link_${secret}` }),
      }),
    );

    assert.equal(body.status, "claimable");
    assert.deepEqual(body.candidates.map((p) => p.id).sort(), [alice, bob].sort());
  });
});

describe("claiming", () => {
  test("previews the overlap, then combines on confirm", async () => {
    const ghost = await makeGhost("Alice");
    const groupId = await makeGroup("Overlap", [ownerId, ghost, claimerId]);
    const secret = await mintFor({ kind: "group_member", groupId, userId: ghost });

    // One expense both are on, one only the ghost is on.
    await createExpense({
      groupId,
      description: "Both of us",
      costMinor: 3_000,
      currencyCode: "USD",
      date: "2026-05-01",
      splitType: "equal",
      participants: [
        { userId: ownerId, paidMinor: 3_000 },
        { userId: ghost, paidMinor: 0 },
        { userId: claimerId, paidMinor: 0 },
      ],
      createdBy: ownerId,
    });
    await createExpense({
      groupId,
      description: "Ghost only",
      costMinor: 2_000,
      currencyCode: "USD",
      date: "2026-05-02",
      splitType: "equal",
      participants: [
        { userId: ownerId, paidMinor: 2_000 },
        { userId: ghost, paidMinor: 0 },
      ],
      createdBy: ownerId,
    });

    const preview = await json<{
      overlappingCount: number;
      transferredCount: number;
      overlapping: Array<{ description: string }>;
    }>(
      await as(claimerToken, "/api/v1/claim/preview", {
        method: "POST",
        body: JSON.stringify({ linkToken: `link_${secret}`, userId: ghost }),
      }),
    );

    assert.equal(preview.overlappingCount, 1);
    assert.equal(preview.transferredCount, 1);
    assert.equal(preview.overlapping[0]!.description, "Both of us");

    const owedBefore = 1_000 + 1_000; // ghost's third + claimer's third
    const confirmed = await as(claimerToken, "/api/v1/claim", {
      method: "POST",
      body: JSON.stringify({ linkToken: `link_${secret}`, userId: ghost }),
    });
    assert.equal(confirmed.status, 200);

    const shares = await db
      .selectFrom("expense_users")
      .innerJoin("expenses", "expenses.id", "expense_users.expense_id")
      .select(["expense_users.owed_share_minor", "expenses.description"])
      .where("expense_users.user_id", "=", claimerId)
      .where("expenses.group_id", "=", groupId)
      .execute();

    const both = shares.find((s) => s.description === "Both of us")!;
    assert.equal(both.owed_share_minor, owedBefore, "shares combined, not re-split");

    // And the link that acted as them is dead.
    const res = await app.request("/api/v1/guest/session", {
      headers: { Authorization: `Bearer link_${secret}` },
    });
    assert.equal(res.status, 401);
  });

  test("a logged-in user with no link cannot claim a placeholder", async () => {
    const ghost = await makeGhost("Unrelated");
    await makeGroup("Somewhere else", [ownerId, ghost]);

    // No linkToken at all: the body will not even validate.
    const bare = await as(outsiderToken, "/api/v1/claim", {
      method: "POST",
      body: JSON.stringify({ userId: ghost }),
    });
    assert.equal(bare.status, 400);

    // A made-up one is no better.
    const bogus = await as(outsiderToken, "/api/v1/claim", {
      method: "POST",
      body: JSON.stringify({ linkToken: "link_not-a-real-secret", userId: ghost }),
    });
    assert.equal(bogus.status, 400);

    const row = await db
      .selectFrom("users")
      .select(["is_ghost", "merged_into_user_id"])
      .where("id", "=", ghost)
      .executeTakeFirstOrThrow();
    assert.equal(row.is_ghost, 1);
    assert.equal(row.merged_into_user_id, null);
  });

  test("a valid link cannot claim someone it does not cover", async () => {
    const mine = await makeGhost("Mine");
    const theirs = await makeGhost("Theirs");
    const groupId = await makeGroup("Mine only", [ownerId, mine]);
    await makeGroup("Theirs only", [ownerId, theirs]);

    const secret = await mintFor({ kind: "group_member", groupId, userId: mine });

    const res = await as(claimerToken, "/api/v1/claim", {
      method: "POST",
      body: JSON.stringify({ linkToken: `link_${secret}`, userId: theirs }),
    });
    assert.equal(res.status, 403);
  });

  test("claiming twice is refused", async () => {
    const ghost = await makeGhost("Once");
    const groupId = await makeGroup("Once only", [ownerId, ghost]);
    const secret = await mintFor({ kind: "group_member", groupId, userId: ghost });

    assert.equal(
      (
        await as(claimerToken, "/api/v1/claim", {
          method: "POST",
          body: JSON.stringify({ linkToken: `link_${secret}`, userId: ghost }),
        })
      ).status,
      200,
    );

    // The link died with the merge, so the second attempt cannot even resolve.
    const again = await as(claimerToken, "/api/v1/claim", {
      method: "POST",
      body: JSON.stringify({ linkToken: `link_${secret}`, userId: ghost }),
    });
    assert.equal(again.status, 400);
  });

  test("a friend link claim folds the placeholder into the account", async () => {
    const ghost = await makeGhost("Erin");
    const account = await makeAccount("ErinReal");
    const secret = await transaction((trx) =>
      mintAccessLink(trx, { kind: "friend", userId: ghost, createdBy: ownerId }),
    );

    await createExpense({
      groupId: null,
      description: "Coffee",
      costMinor: 1_000,
      currencyCode: "USD",
      date: "2026-05-03",
      splitType: "equal",
      participants: [
        { userId: ownerId, paidMinor: 1_000 },
        { userId: ghost, paidMinor: 0 },
      ],
      createdBy: ownerId,
    });

    const res = await as(account.token, "/api/v1/claim", {
      method: "POST",
      body: JSON.stringify({ linkToken: `link_${secret.secret}`, userId: ghost }),
    });
    assert.equal(res.status, 200);

    const share = await db
      .selectFrom("expense_users")
      .select("owed_share_minor")
      .where("user_id", "=", account.id)
      .executeTakeFirstOrThrow();
    assert.equal(share.owed_share_minor, 500, "the debt followed them, unchanged");

    const stub = await db
      .selectFrom("users")
      .select(["merged_into_user_id", "deleted_at"])
      .where("id", "=", ghost)
      .executeTakeFirstOrThrow();
    assert.equal(stub.merged_into_user_id, account.id);
    assert.ok(stub.deleted_at);
  });

  test("two accounts cannot race to claim the same ghost", async () => {
    const ghost = await makeGhost("Racer");
    const groupId = await makeGroup("Race", [ownerId, ghost]);
    const secret = await mintFor({ kind: "group_member", groupId, userId: ghost });
    const second = await makeAccount("Second");

    await createExpense({
      groupId,
      description: "Split cab",
      costMinor: 2_000,
      currencyCode: "USD",
      date: "2026-05-04",
      splitType: "equal",
      participants: [
        { userId: ownerId, paidMinor: 2_000 },
        { userId: ghost, paidMinor: 0 },
      ],
      createdBy: ownerId,
    });

    assert.equal(
      (
        await as(claimerToken, "/api/v1/claim", {
          method: "POST",
          body: JSON.stringify({ linkToken: `link_${secret}`, userId: ghost }),
        })
      ).status,
      200,
    );

    const again = await as(second.token, "/api/v1/claim", {
      method: "POST",
      body: JSON.stringify({ linkToken: `link_${secret}`, userId: ghost }),
    });
    assert.ok(again.status >= 400, "the link died with the first merge");

    const stub = await db
      .selectFrom("users")
      .select("merged_into_user_id")
      .where("id", "=", ghost)
      .executeTakeFirstOrThrow();
    assert.equal(stub.merged_into_user_id, claimerId, "the first claimer keeps the shares");

    const secondShare = await db
      .selectFrom("expense_users")
      .select("user_id")
      .where("user_id", "=", second.id)
      .execute();
    assert.deepEqual(secondShare, [], "the loser did not absorb anything");
  });
});
