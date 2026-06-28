import { captureError, traceFromHeader } from "./index";

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
    name: "onError",
    fn: (request: RequestLike, reply: ReplyLike, error: unknown, done: () => void) => void,
  ): void;
}

/**
 * Fastify plugin: registers an `onError` hook that reports to Octri. Register it
 * once, after `init()`:
 *
 *   import { init } from "@octri/node";
 *   import { octriFastify } from "@octri/node/fastify";
 *   init({ url, token, environment });
 *   await app.register(octriFastify);
 */
export function octriFastify(fastify: FastifyLike, _opts: unknown, done: () => void): void {
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
