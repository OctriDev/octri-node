// @octri/node — server-side error monitoring for Node backends.
//
// Add it to your live API backend; it reports backend errors to your Octri
// monitoring project (with original-source context per frame) and links each one
// to the client SDK error for the same request via the W3C `traceparent` header
// — so the dashboard shows the full client → server stack under one trace.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface OctriConfig {
  /** Monitoring base URL, e.g. https://monitoring.example.com. */
  url: string;
  /** Ingest token for your project (the same one your generated SDK uses). */
  token: string;
  /** Project environment / id (the dashboard project id). */
  environment: string;
  /** Optional release identifier reported with each error. */
  release?: string;
}

let config: OctriConfig | null = null;

/** Configures the reporter. Call once at startup before mounting the middleware. */
export function init(cfg: OctriConfig): void {
  config = { ...cfg, url: cfg.url.replace(/\/$/, "") };
}

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** A fresh 64-bit span id (16 hex chars), for a span this service produces. */
export function newSpanId(): string {
  return randomHex(8);
}

// ── Trace context (W3C) ────────────────────────────────────────────────────────

export interface TraceContext {
  traceId: string;
  /** The client's span id (this request's caller), when propagated. */
  parentSpanId?: string;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

/** Reads the trace from a `traceparent` header, or starts a fresh trace. */
export function traceFromHeader(traceparent: string | string[] | undefined): TraceContext {
  const value = Array.isArray(traceparent) ? traceparent[0] : traceparent;
  const match = value != null ? TRACEPARENT_RE.exec(value) : null;
  if (match) return { traceId: match[1], parentSpanId: match[2] };
  return { traceId: randomHex(16) };
}

// ── Frame source context (Node) ─────────────────────────────────────────────────

const FRAME_RE = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const CONTEXT_LINES = 5;
const sourceCache = new Map<string, string[] | null>();

function toPath(file: string): string {
  if (file.startsWith("file://")) {
    try {
      return fileURLToPath(file);
    } catch {
      return file;
    }
  }
  return file;
}

function readSource(file: string): string[] | null {
  if (sourceCache.has(file)) return sourceCache.get(file) ?? null;
  let lines: string[] | null = null;
  try {
    lines = readFileSync(toPath(file), "utf8").split("\n");
  } catch {
    lines = null;
  }
  sourceCache.set(file, lines);
  return lines;
}

function frameInApp(file: string): boolean {
  return !file.includes("/node_modules/") && !file.startsWith("node:") && !file.includes("/internal/");
}

interface Frame {
  function?: string;
  filename: string;
  lineno: number;
  colno: number;
  inApp: boolean;
  contextLine?: string;
  preContext?: string[];
  postContext?: string[];
}

// Parses a V8 stack into structured frames with original-source context.
function buildFrames(stack: string | undefined): Frame[] {
  if (stack === undefined) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const match = FRAME_RE.exec(line);
    if (match === null) continue;
    const filename = match[2];
    const lineno = Number(match[3]);
    const fnName = match[1];
    const frame: Frame = {
      function: fnName !== undefined && fnName !== "" ? fnName : undefined,
      filename,
      lineno,
      colno: Number(match[4]),
      inApp: frameInApp(filename),
    };
    const lines = readSource(filename);
    if (lines !== null && lineno >= 1 && lineno <= lines.length) {
      const idx = lineno - 1;
      frame.contextLine = lines[idx];
      const pre = lines.slice(Math.max(0, idx - CONTEXT_LINES), idx);
      const post = lines.slice(idx + 1, idx + 1 + CONTEXT_LINES);
      if (pre.length > 0) frame.preContext = pre;
      if (post.length > 0) frame.postContext = post;
    }
    frames.push(frame);
  }
  return frames;
}

// ── Reporting ──────────────────────────────────────────────────────────────────

export interface CaptureOptions {
  /** Trace context, typically from `traceFromHeader(req.headers.traceparent)`. */
  trace?: TraceContext;
  method?: string;
  path?: string;
  operationId?: string;
  statusCode?: number;
  level?: "error" | "fatal" | "warning";
}

/**
 * Reports an error to the monitoring project (fire-and-forget). Tagged
 * `octri.origin=server` and stamped with the request's `traceId`, so it links to
 * the client SDK error for the same request.
 */
export function captureError(error: unknown, options: CaptureOptions = {}): void {
  if (config === null) return;
  const cfg = config;
  const err = error instanceof Error ? error : new Error(String(error));
  const trace = options.trace ?? { traceId: randomHex(16) };

  const payload: Record<string, unknown> = {
    eventId: randomHex(16),
    timestamp: new Date().toISOString(),
    level: options.level ?? "error",
    method: options.method,
    path: options.path,
    operationId: options.operationId,
    statusCode: options.statusCode,
    environment: cfg.environment,
    release: cfg.release,
    traceId: trace.traceId,
    spanId: randomHex(8),
    tags: { "octri.origin": "server" },
    error: { name: err.name, message: err.message, stack: err.stack, frames: buildFrames(err.stack) },
  };

  void fetch(`${cfg.url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(payload),
  }).catch(() => {
    // A logging failure must never mask the originating error.
  });
}

// ── Spans (request waterfall) ────────────────────────────────────────────────

export interface SpanInput {
  traceId: string;
  /** This span's id. */
  spanId: string;
  /** The caller's span id — the client request that triggered this one. */
  parentSpanId?: string;
  name: string;
  service?: string;
  operationId?: string;
  /** ISO timestamps. */
  startTime: string;
  endTime?: string;
  status?: "ok" | "error";
}

/**
 * Reports one span to the monitoring trace store (fire-and-forget). Spans sharing
 * a `traceId` form the request waterfall — the client SDK span (root) and this
 * server span (its child) line up under one trace in the dashboard.
 */
export function captureSpan(span: SpanInput): void {
  if (config === null) return;
  const cfg = config;
  const body: Record<string, unknown> = { service: "server", ...span };
  void fetch(`${cfg.url}/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body),
  }).catch(() => {
    // Span reporting must never affect the request.
  });
}
