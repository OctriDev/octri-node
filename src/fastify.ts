import { captureError, captureSpan, newSpanId, traceFromHeader, type TraceContext } from "./index";

// Minimal structural types so the package needn't depend on Fastify.
interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
}
interface ReplyLike {
  statusCode?: number;
}
interface FastifyLike {
  addHook(
    name: "onRequest" | "onResponse",
    fn: (request: RequestLike, reply: ReplyLike, done: () => void) => void,
  ): void;
  addHook(
    name: "onError",
    fn: (request: RequestLike, reply: ReplyLike, error: unknown, done: () => void) => void,
  ): void;
}

// Per-request span state, keyed off the request object (no mutation of its type).
const pending = new WeakMap<RequestLike, { start: string; spanId: string; trace: TraceContext }>();

/**
 * Fastify plugin: reports backend errors to Octri AND times each request as a
 * server span (a child of the client SDK span via the incoming `traceparent`),
 * so the dashboard can draw the request waterfall. Register once, after `init()`:
 *
 *   import { init } from "@octri/node";
 *   import { octriFastify } from "@octri/node/fastify";
 *   init({ url, token, environment });
 *   await app.register(octriFastify);
 */
export function octriFastify(fastify: FastifyLike, _opts: unknown, done: () => void): void {
  fastify.addHook("onRequest", (request, _reply, hookDone) => {
    try {
      pending.set(request, {
        start: new Date().toISOString(),
        spanId: newSpanId(),
        trace: traceFromHeader(request.headers?.traceparent),
      });
    } catch {
      // Never let monitoring break the request.
    }
    hookDone();
  });

  fastify.addHook("onResponse", (request, reply, hookDone) => {
    try {
      const span = pending.get(request);
      if (span !== undefined) {
        pending.delete(request);
        captureSpan({
          traceId: span.trace.traceId,
          spanId: span.spanId,
          parentSpanId: span.trace.parentSpanId,
          name: `${request.method ?? ""} ${request.url ?? ""}`.trim(),
          service: "server",
          startTime: span.start,
          endTime: new Date().toISOString(),
          status: typeof reply.statusCode === "number" && reply.statusCode >= 500 ? "error" : "ok",
        });
      }
    } catch {
      // Never let monitoring break the request.
    }
    hookDone();
  });

  fastify.addHook("onError", (request, reply, error, hookDone) => {
    try {
      captureError(error, {
        trace: traceFromHeader(request.headers?.traceparent),
        method: request.method,
        path: request.url,
        statusCode: typeof reply.statusCode === "number" ? reply.statusCode : 500,
      });
    } catch {
      // Never let monitoring break the request.
    }
    hookDone();
  });

  done();
}
