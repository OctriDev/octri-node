# @octri/node

Server-side error monitoring for **Node** backends. Add it to your live API and
it reports backend errors to your Octri monitoring project — with original-source
context per stack frame — and **links each one to the client SDK error for the
same request** via the W3C `traceparent` header. In the dashboard you then see
the full client → server stack under one trace.

## Setup

```ts
import { init } from "@octri/node";

init({
  url: "https://monitoring.example.com", // your monitoring base URL
  token: process.env.OCTRI_TOKEN,         // your project ingest token
  environment: "<your project id>",       // the dashboard project id
  release: process.env.GIT_SHA,           // optional
});
```

Hosted users can copy the project-scoped URL, token, and environment from the
Monitoring connection settings (or its API). Omit `token` only when pointing at
an open self-hosted ingest endpoint. Every request carries an idempotency key.

## Standalone events

The package can be used directly; a generated Octri API SDK is not required.

```ts
import { captureEvent } from "@octri/node";

captureEvent("checkout.completed", {
  level: "info",
  user: { id: customer.id },
  tags: { region: "eu-west", plan: "growth" },
  context: { orderId: order.id, total: order.total },
});
```

Delivery is asynchronous and best-effort. Supplying `eventId` makes a retried
delivery idempotent.

### Express

```ts
import { octriErrorHandler } from "@octri/node/express";

// ...your routes...
app.use(octriErrorHandler()); // mount AFTER routes + before your own error handler
```

### Fastify

```ts
import { octriFastify } from "@octri/node/fastify";

await app.register(octriFastify);
```

### Manual capture

```ts
import { captureError, traceFromHeader } from "@octri/node";

captureError(err, {
  trace: traceFromHeader(req.headers.traceparent),
  method: req.method,
  path: req.url,
  statusCode: 500,
});
```

## Spans & the request waterfall

The middleware times each request as a span. To see where time goes inside it,
either let Octri instrument common I/O automatically, or open spans yourself.

### Automatic

```ts
import { autoInstrument, instrument } from "@octri/node";

autoInstrument();                          // traces every outbound `fetch`, and
                                           // pg / mysql2 / ioredis if installed
instrument(pool, ["query"], { op: "db" }); // your own client / util module, once
instrument(cache, ["get", "set"], { op: "cache" });
```

Every call to an instrumented method (and every `fetch`) becomes a sub-span under
the current request — no per-call code. Calls to your monitoring backend are
never traced (no feedback loop).

### Manual

```ts
import { withSpan, startSpan } from "@octri/node";

const rows = await withSpan("orders.list", () => db.query(sql), { op: "db" });

const span = startSpan("render", { op: "view" });
// ...work...
span.finish();
```

`op` ("db", "cache", "http", …) colour-codes the bar in the dashboard waterfall.

## How the linking works

Your generated client SDK sends a `traceparent: 00-<traceId>-<spanId>-01` header
with every request. This package reads it on the server, and when a handler
throws it reports the error stamped with the **same `traceId`** (tagged
`octri.origin=server`). The dashboard groups both events by `traceId` and shows
them as one trace — the client call that failed and the server frame that threw.

Source context is read from the running process, so it shows your original code
when the source is deployed alongside the server (it always is for a Node app).
