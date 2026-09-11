import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import sdk from "../dist/index.js";

test("captureEvent sends a standalone, idempotent event without generated SDK state", async () => {
  let resolveRequest;
  const received = new Promise((resolve) => { resolveRequest = resolve; });
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      resolveRequest({ request, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      response.writeHead(202).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    sdk.init({ url: `http://127.0.0.1:${address.port}`, environment: "project-1" });
    sdk.captureEvent("checkout.completed", {
      eventId: "event-123",
      tags: { plan: "growth" },
      context: { orderId: "order-1" },
    });

    const { request, body } = await received;
    assert.equal(request.url, "/ingest");
    assert.equal(request.headers["idempotency-key"], "event-123");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(body.eventId, "event-123");
    assert.equal(body.environment, "project-1");
    assert.equal(body.message, "checkout.completed");
    assert.deepEqual(body.tags, { "octri.origin": "standalone", plan: "growth" });
    assert.deepEqual(body.context, { orderId: "order-1" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("traceFromHeader trims valid context and rejects zero W3C identifiers", () => {
  const valid = sdk.traceFromHeader(
    "  00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01  ",
  );
  assert.deepEqual(valid, {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    parentSpanId: "00f067aa0ba902b7",
  });

  for (const header of [
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
  ]) {
    const fresh = sdk.traceFromHeader(header);
    assert.match(fresh.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(fresh.traceId, "0".repeat(32));
    assert.equal(fresh.parentSpanId, undefined);
  }
});

test("captureEvent normalizes safe ids, replaces unsafe ids, and bounds requests", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
  };

  try {
    sdk.init({ url: "https://monitoring.example.com", environment: "project-1" });
    for (const eventId of ["  event-123  ", " \t ", "bad\r\nX-Injected: true", "x".repeat(257)]) {
      sdk.captureEvent("test", { eventId });
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 4);
    assert.equal(JSON.parse(calls[0].init.body).eventId, "event-123");
    assert.equal(calls[0].init.headers["idempotency-key"], "event-123");
    for (const { init } of calls.slice(1)) {
      const body = JSON.parse(init.body);
      assert.match(body.eventId, /^[0-9a-f]{32}$/);
      assert.equal(init.headers["idempotency-key"], body.eventId);
      assert.ok(init.signal instanceof AbortSignal);
    }

    sdk.init({
      url: "https://monitoring.example.com",
      environment: "project-1",
      token: "token\r\nX-Injected: true",
    });
    sdk.captureEvent("suppressed");
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("captureSpan suppresses invalid required fields and reporting stays best-effort", () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
  };

  try {
    sdk.init({ url: "https://monitoring.example.com", environment: "project-1" });
    sdk.captureSpan({ traceId: "", spanId: "span-1", name: "test", startTime: new Date().toISOString() });
    sdk.captureSpan({ traceId: "trace-1", spanId: "span-1", name: " ", startTime: new Date().toISOString() });
    sdk.captureSpan({ traceId: "trace-1", spanId: "span-1", name: "test", startTime: "not-a-date" });
    sdk.captureSpan({
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      name: "test",
      startTime: new Date().toISOString(),
    });
    assert.equal(calls.length, 0);

    // A context that will not serialize is dropped rather than thrown. A cycle
    // does serialize (the scrubber marks it), so that event is still reported.
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => sdk.captureEvent("circular", { context: circular }));
    assert.doesNotThrow(() => sdk.captureEvent("bigint", { context: { size: 1n } }));
    assert.doesNotThrow(() => sdk.captureError(Object.create(null)));
    assert.equal(calls.length, 1, "only the cyclic context is reportable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
