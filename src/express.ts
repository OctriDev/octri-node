import { captureError, captureSpan, newSpanId, runWithSpanContext, traceFromHeader } from "./index";

// Minimal structural types so the package needn't depend on Express.
interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
}
interface ResLike {
  statusCode?: number;
  on?: (event: string, listener: () => void) => void;
}

/**
 * Express error-handling middleware. Mount it AFTER your routes:
 *
 *   import { init } from "@octri/node";
 *   import { octriErrorHandler } from "@octri/node/express";
 *   init({ url, token, environment });
 *   app.use(octriErrorHandler());
 *
 * It reports the error (linked to the client by the incoming `traceparent`) and
 * re-throws via `next(err)` so your own error handling still runs.
 */
/**
 * Express request-timing middleware. Mount it FIRST, before your routes:
 *
 *   import { octriMiddleware } from "@octri/node/express";
 *   app.use(octriMiddleware());
 *
 * It times each request and reports a server span (a child of the client SDK's
 * span via the incoming `traceparent`), so the dashboard can draw the request
 * waterfall. Pair it with `octriErrorHandler()` mounted after your routes.
 */
export function octriMiddleware() {
  return (req: ReqLike, res: ResLike, next: (e?: unknown) => void): void => {
    let context: { traceId: string; spanId: string } | null = null;
    try {
      const trace = traceFromHeader(req.headers.traceparent);
      const spanId = newSpanId();
      const startTime = new Date().toISOString();
      context = { traceId: trace.traceId, spanId };
      res.on?.("finish", () => {
        captureSpan({
          traceId: trace.traceId,
          spanId,
          parentSpanId: trace.parentSpanId,
          name: `${req.method ?? "GET"} ${req.originalUrl ?? req.url ?? ""}`.trim(),
          service: "server",
          startTime,
          endTime: new Date().toISOString(),
          status: typeof res.statusCode === "number" && res.statusCode >= 500 ? "error" : "ok",
        });
      });
    } catch {
      // Never let monitoring break the request.
    }
    // Run downstream within the span context so handlers can open sub-spans
    // (startSpan / withSpan) that nest under this request's server span.
    if (context !== null) runWithSpanContext(context, () => next());
    else next();
  };
}

export function octriErrorHandler() {
  return (err: unknown, req: ReqLike, res: ResLike, next: (e?: unknown) => void): void => {
    try {
      captureError(err, {
        trace: traceFromHeader(req.headers.traceparent),
        method: req.method,
        path: req.originalUrl ?? req.url,
        statusCode: typeof res.statusCode === "number" && res.statusCode >= 400 ? res.statusCode : 500,
      });
    } catch {
      // Never let monitoring break the request.
    }
    next(err);
  };
}
