/**
 * Mail transport: provider selection and the two HTTP adapters.
 *
 * No provider is configured here. sendEmail's unconfigured path is covered by
 * verification.test.ts; this file tests resolveEmailProvider and the Resend /
 * Postmark fetch bodies against a mocked fetch.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_ADDRESS;
delete process.env.POSTMARK_SERVER_TOKEN;
delete process.env.POSTMARK_FROM_ADDRESS;

const { resolveEmailProvider } = await import("../env.ts");
const { sendViaResend, sendViaPostmark } = await import("./send.ts");

const message = {
  to: "friend@example.com",
  subject: "Hello",
  htmlBody: "<p>Hi</p>",
  textBody: "Hi",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(status: number, body: unknown): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("resolveEmailProvider", () => {
  test("returns null when nothing is set", () => {
    assert.equal(resolveEmailProvider({}), null);
  });

  test("ignores an incomplete pair", () => {
    assert.equal(resolveEmailProvider({ RESEND_API_KEY: "re_x" }), null);
    assert.equal(resolveEmailProvider({ POSTMARK_FROM_ADDRESS: "a@b.com" }), null);
  });

  test("picks Resend when only that pair is complete", () => {
    assert.equal(
      resolveEmailProvider({
        RESEND_API_KEY: "re_x",
        RESEND_FROM_ADDRESS: "SplitSmart <mail@example.com>",
      }),
      "resend",
    );
  });

  test("picks Postmark when only that pair is complete", () => {
    assert.equal(
      resolveEmailProvider({
        POSTMARK_SERVER_TOKEN: "tok",
        POSTMARK_FROM_ADDRESS: "mail@example.com",
      }),
      "postmark",
    );
  });

  test("refuses both complete pairs", () => {
    assert.throws(
      () =>
        resolveEmailProvider({
          RESEND_API_KEY: "re_x",
          RESEND_FROM_ADDRESS: "a@b.com",
          POSTMARK_SERVER_TOKEN: "tok",
          POSTMARK_FROM_ADDRESS: "a@b.com",
        }),
      /not both/,
    );
  });
});

describe("sendViaResend", () => {
  test("posts html and text to api.resend.com", async () => {
    const calls = mockFetch(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });

    const result = await sendViaResend({
      apiKey: "re_test",
      from: "SplitSmart <mail@example.com>",
      message,
    });

    assert.deepEqual(result, {
      delivered: true,
      reason: null,
      messageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.resend.com/emails");
    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(headers.get("Authorization"), "Bearer re_test");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      from: "SplitSmart <mail@example.com>",
      to: ["friend@example.com"],
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  test("treats a non-2xx as failure", async () => {
    mockFetch(422, { statusCode: 422, name: "validation_error", message: "Invalid from" });

    const result = await sendViaResend({
      apiKey: "re_test",
      from: "bad",
      message,
    });

    assert.equal(result.delivered, false);
    assert.match(result.reason ?? "", /resend_error_422: Invalid from/);
  });
});

describe("sendViaPostmark", () => {
  test("posts to Postmark with the server token", async () => {
    const calls = mockFetch(200, { ErrorCode: 0, Message: "OK", MessageID: "pm-1" });

    const result = await sendViaPostmark({
      serverToken: "tok",
      from: "mail@example.com",
      stream: "outbound",
      message,
    });

    assert.deepEqual(result, { delivered: true, reason: null, messageId: "pm-1" });
    assert.equal(calls[0]!.url, "https://api.postmarkapp.com/email");
    const headers = new Headers(calls[0]!.init.headers);
    assert.equal(headers.get("X-Postmark-Server-Token"), "tok");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      From: "mail@example.com",
      To: "friend@example.com",
      Subject: "Hello",
      HtmlBody: "<p>Hi</p>",
      TextBody: "Hi",
      MessageStream: "outbound",
    });
  });

  test("treats a non-zero ErrorCode as failure", async () => {
    mockFetch(200, { ErrorCode: 400, Message: "Sender signature not found" });

    const result = await sendViaPostmark({
      serverToken: "tok",
      from: "mail@example.com",
      stream: "outbound",
      message,
    });

    assert.equal(result.delivered, false);
    assert.match(result.reason ?? "", /postmark_error_400: Sender signature not found/);
  });
});
