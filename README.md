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
  token: process.env.OCTRI_TOKEN!,        // your project ingest token
  environment: "<your project id>",       // the dashboard project id
  release: process.env.GIT_SHA,           // optional
});
```

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

## How the linking works

Your generated client SDK sends a `traceparent: 00-<traceId>-<spanId>-01` header
with every request. This package reads it on the server, and when a handler
throws it reports the error stamped with the **same `traceId`** (tagged
`octri.origin=server`). The dashboard groups both events by `traceId` and shows
them as one trace — the client call that failed and the server frame that threw.

Source context is read from the running process, so it shows your original code
when the source is deployed alongside the server (it always is for a Node app).
