import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import sdk from "../dist/index.js";

// One server for the file: every test captures the next payload it receives.
let pending = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    response.writeHead(202).end();
    const resolve = pending.shift();
    if (resolve) resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  });
});

test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  sdk.init({ url: `http://127.0.0.1:${server.address().port}`, environment: "test" });
});
test.after(() => server.close());

function next() {
  return new Promise((resolve) => pending.push(resolve));
}

async function capture(message, options) {
  const received = next();
  sdk.captureEvent(message, options);
  return received;
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

test("credential-shaped keys are redacted however they are spelled", async () => {
  const payload = await capture("checkout failed", {
    context: {
      api_key: "sk_live_1",
      apiKey: "sk_live_2",
      "X-API-KEY": "sk_live_3",
      stripeSecretKey: "sk_live_4",
      Authorization: "Bearer abc",
      refresh_token: "rt_1",
      cookie: "sid=1",
      orderId: "A-1024",
    },
  });

  const context = payload.context;
  assert.equal(context.api_key, "[redacted]");
  assert.equal(context.apiKey, "[redacted]");
  assert.equal(context["X-API-KEY"], "[redacted]");
  assert.equal(context.stripeSecretKey, "[redacted]");
  assert.equal(context.Authorization, "[redacted]");
  assert.equal(context.refresh_token, "[redacted]");
  assert.equal(context.cookie, "[redacted]");
  assert.equal(context.orderId, "A-1024", "ordinary fields are left alone");
});

test("nested and array values are redacted too", async () => {
  const payload = await capture("upstream rejected the call", {
    context: { upstream: { headers: [{ authorization: "Bearer abc" }] } },
  });

  assert.equal(payload.context.upstream.headers[0].authorization, "[redacted]");
});

test("keys that merely contain a scrub word are not redacted", async () => {
  const payload = await capture("import failed", {
    context: { author: "ada", wildcard: "*.csv", discarded: 3 },
  });

  assert.deepEqual(payload.context, { author: "ada", wildcard: "*.csv", discarded: 3 });
});

test("extra scrub fields are additive", async () => {
  sdk.addScrubFields("accountNumber");
  const payload = await capture("payout failed", {
    context: { accountNumber: "12345678", orderId: "A-1024" },
  });

  assert.equal(payload.context.accountNumber, "[redacted]");
  assert.equal(payload.context.orderId, "A-1024");
});

// ─── Free text ────────────────────────────────────────────────────────────────

test("secrets that leaked into a message are stripped", async () => {
  const payload = await capture(
    "401 from billing: Authorization: Bearer sk_live_abc123 rejected",
  );

  assert.equal(payload.message.includes("sk_live_abc123"), false);
  assert.equal(payload.message.includes("[redacted]"), true);
});

test("a JWT in a message is stripped", async () => {
  const payload = await capture(
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.7Hk2 expired",
  );

  assert.equal(payload.message, "token [redacted] expired");
});

test("an email in a message is stripped", async () => {
  const payload = await capture("no account for ada@example.com");

  assert.equal(payload.message, "no account for [redacted]");
});

test("a card number is stripped, an order number is not", async () => {
  const payload = await capture("charge 4242 4242 4242 4242 failed for order 1234567890123");

  assert.equal(payload.message.includes("4242"), false);
  assert.equal(payload.message.includes("1234567890123"), true);
});

test("an error message and its stack are scrubbed", async () => {
  const received = next();
  sdk.captureError(new Error("mail to ada@example.com bounced"));
  const payload = await received;

  assert.equal(payload.error.message, "mail to [redacted] bounced");
  assert.equal(payload.error.stack.includes("ada@example.com"), false);
});

// ─── The user field ───────────────────────────────────────────────────────────

test("user identity survives, user credentials do not", async () => {
  const payload = await capture("profile update failed", {
    user: { id: "u_1", email: "ada@example.com", sessionToken: "st_1" },
  });

  assert.equal(payload.user.email, "ada@example.com");
  assert.equal(payload.user.id, "u_1");
  assert.equal(payload.user.sessionToken, "[redacted]");
});

// ─── beforeSend ───────────────────────────────────────────────────────────────

test("beforeSend can edit a payload, and redaction still runs after it", async () => {
  sdk.setBeforeSend((payload) => {
    payload.context = { ...payload.context, note: "call ada@example.com" };
    return payload;
  });
  try {
    const payload = await capture("build failed", { context: { step: "compile" } });
    assert.equal(payload.context.step, "compile");
    assert.equal(payload.context.note, "call [redacted]");
  } finally {
    sdk.setBeforeSend(null);
  }
});

test("beforeSend returning null drops the event", async () => {
  sdk.setBeforeSend((payload) => (payload.message === "noise" ? null : payload));
  try {
    sdk.captureEvent("noise");
    const payload = await capture("signal");
    assert.equal(payload.message, "signal");
  } finally {
    sdk.setBeforeSend(null);
  }
});
