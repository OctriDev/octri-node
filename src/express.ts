import { captureError, traceFromHeader } from "./index";

// Minimal structural types so the package needn't depend on Express.
interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  originalUrl?: string;
  url?: string;
}
interface ResLike {
  statusCode?: number;
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
