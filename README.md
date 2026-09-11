# @octri/node

**Error and performance monitoring for Node backends.** Report errors out of
Express or Fastify with original-source context per stack frame, time every
request into a waterfall, and join each server error to the client SDK error for
the same request through the W3C `traceparent` header. In the dashboard you see
the full client → server stack under one trace.

Octri turns an OpenAPI spec into a documentation site, client SDKs for ten
languages, an MCP server your AI assistant can call, and monitoring for the
API behind them. This package is the Node monitoring runtime, and it works on
its own: a generated Octri API SDK is not required. See
[octri.dev/monitoring](https://octri.dev/monitoring).

Siblings: [Python](https://github.com/octridev/octri-python),
[Go](https://github.com/octridev/octri-go),
[Ruby](https://github.com/octridev/octri-ruby), and six more below.

## Install

```bash
npm install @octri/node
```

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
the current request, with no per-call code. Calls to your monitoring backend are
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
them as one trace: the client call that failed and the server frame that threw.

Source context is read from the running process, so it shows your original code
when the source is deployed alongside the server (it always is for a Node app).

---

## What gets redacted

Payloads are scrubbed on the way out, so a credential that ended up in a log
line or a context object never reaches the dashboard.

Any key whose name looks like a credential (`password`, `secret`, `token`,
`apiKey`, `authorization`, `cookie`, `ssn` and the rest of the usual list) has
its value replaced with `[redacted]`, at any depth. Matching ignores case and
separators, so `api_key`, `apiKey` and `X-API-KEY` are all the same key.

Free text is swept too: the message, an error message and its stack, and
anything else you send as a string. Bearer tokens, JWTs, card numbers and email
addresses come out as `[redacted]`. A card number has to pass the Luhn check
first, so an order number or a timestamp survives.

`user` is the exception. It is the field you fill with an identity on purpose,
so `user.email` is reported exactly as you set it. Credential-shaped keys inside
it are still redacted.

Add your own key names:

```ts
addScrubFields("accountNumber", "otp");
```

Or take the payload yourself, and return `null` to drop the event:

```ts
setBeforeSend((payload) => (payload.path === "/health" ? null : payload));
```

Redaction runs after your hook, so a hook cannot leak a credential by accident.

## The rest of Octri

| Product | What it does |
|---|---|
| [API Studio](https://octri.dev/api-studio) | Your OpenAPI spec becomes a hosted documentation site with a live request playground, editable page by page. |
| [SDK Studio](https://octri.dev/sdk-studio) | The same spec becomes client libraries for ten languages, versioned and released together. |
| [MCP](https://octri.dev/mcp) | Your endpoints and docs become tools an AI assistant can call, generated from the same spec. |
| [Monitoring](https://octri.dev/monitoring) | Errors, traces, uptime and releases for the API, joined to the SDK calls that reached it. |

### Monitoring runtimes

[Node](https://github.com/octridev/octri-node) ·
[Python](https://github.com/octridev/octri-python) ·
[Go](https://github.com/octridev/octri-go) ·
[Ruby](https://github.com/octridev/octri-ruby) ·
[Rust](https://github.com/octridev/octri-rust) ·
[PHP](https://github.com/octridev/octri-php) ·
[Java](https://github.com/octridev/octri-java) ·
[Kotlin](https://github.com/octridev/octri-kotlin) ·
[Swift](https://github.com/octridev/octri-swift) ·
[Dart](https://github.com/octridev/octri-dart)

[Documentation](https://docs.octri.dev/docs) ·
[Pricing](https://octri.dev/pricing) ·
[Changelog](https://docs.octri.dev/changelog)

MIT licensed.
