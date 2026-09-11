// @octri/node: server-side error monitoring for Node backends.
//
// Add it to your live API backend; it reports backend errors to your Octri
// monitoring project (with original-source context per frame) and links each one
// to the client SDK error for the same request via the W3C `traceparent` header,
// so the dashboard shows the full client-to-server stack under one trace.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface OctriConfig {
  /** Monitoring base URL, e.g. https://monitoring.example.com. */
  url: string;
  /** Project ingest token. Omit only for an open self-hosted endpoint. */
  token?: string;
  /** Project environment / id (the dashboard project id). */
  environment: string;
  /** Optional release identifier reported with each error. */
  release?: string;
}

let config: OctriConfig | null = null;

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/** Configures the reporter. Call once at startup before mounting the middleware. */
export function init(cfg: OctriConfig): void {
  config = { ...cfg, url: cfg.url.replace(/\/$/, "") };
}

function postJson(
  cfg: OctriConfig,
  path: "/ingest" | "/traces",
  payload: Record<string, unknown>,
  idempotencyKey: string,
): void {
  try {
    if (!isSafeIdempotencyKey(idempotencyKey)) return;
    if (cfg.token !== undefined && cfg.token !== "" && !isSafeHeaderValue(cfg.token)) return;
    const scrubbed = scrubPayload(payload);
    if (scrubbed === null) return;
    const body = JSON.stringify(scrubbed);
    void fetch(`${cfg.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        ...(cfg.token !== undefined && cfg.token !== ""
          ? { authorization: `Bearer ${cfg.token}` }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
      // Monitoring must never affect the application.
    });
  } catch {
    // Context that will not serialize (a BigInt, say) is dropped, never re-thrown.
  }
}

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

function isSafeHeaderValue(value: string): boolean {
  return value !== "" && !value.includes("\r") && !value.includes("\n");
}

function isSafeIdempotencyKey(value: string): boolean {
  return isSafeHeaderValue(value) && Buffer.byteLength(value, "utf8") <= MAX_IDEMPOTENCY_KEY_LENGTH;
}

function resolveEventId(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return isSafeIdempotencyKey(candidate) ? candidate : randomHex(16);
}

function allZeros(value: string): boolean {
  return /^0+$/.test(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The path part of a request URL, without query or fragment. Span names and
 * error paths land in the dashboard, and query strings carry reset tokens, API
 * keys and session ids.
 */
export function requestPath(url: string | undefined): string {
  if (url === undefined || url === "") return "";
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** A fresh 64-bit span id (16 hex chars), for a span this service produces. */
export function newSpanId(): string {
  return randomHex(8);
}

// ── Scrubbing ────────────────────────────────────────────────────────────────

/**
 * Keys whose value never leaves the process. Compared against the key with case
 * and separators removed, so `api_key`, `apiKey` and `API-KEY` all match
 * `apikey`, and the test is a substring one, so `stripeSecretKey` matches too.
 */
const SCRUB_KEYS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "authorization",
  "credential",
  "cookie",
  "session",
  "privatekey",
  "accesskey",
  "cardnumber",
  "creditcard",
  "cvv",
  "ssn",
];

const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const CIRCULAR = "[circular]";
/** Deep enough for real context objects, shallow enough to stay cheap. */
const MAX_SCRUB_DEPTH = 8;

const BEARER_RE = /\bbearer\s+[\w.~+/-]+=*/gi;
const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const DIGIT_RUN_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const EMAIL_RE = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;

const extraScrubKeys: string[] = [];

export type BeforeSend = (
  payload: Record<string, unknown>,
) => Record<string, unknown> | null;

let beforeSend: BeforeSend | null = null;

/**
 * Redacts more key names, on top of the built-in list. Matching ignores case and
 * separators and is a substring test, so `account` also covers `accountNumber`.
 *
 *   addScrubFields("accountNumber", "otp");
 */
export function addScrubFields(...fields: string[]): void {
  for (const field of fields) {
    const key = normalizeKey(field);
    if (key !== "" && !extraScrubKeys.includes(key)) extraScrubKeys.push(key);
  }
}

/**
 * Runs on every payload just before it is sent. Return it (editing in place is
 * fine) to send it, or `null` to drop the event:
 *
 *   setBeforeSend((payload) => (payload.path === "/health" ? null : payload));
 *
 * Redaction still runs afterwards, so a hook can't leak a credential by
 * accident. Pass `null` to remove the hook.
 */
export function setBeforeSend(hook: BeforeSend | null): void {
  beforeSend = hook;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === "") return false;
  return (
    SCRUB_KEYS.some((candidate) => normalized.includes(candidate)) ||
    extraScrubKeys.some((candidate) => normalized.includes(candidate))
  );
}

/** Tells a card number from the order ids and timestamps that look like one. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Removes credentials and personal data that leaked into free text. */
function scrubText(value: string): string {
  if (value === "") return value;
  return value
    .replace(BEARER_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(DIGIT_RUN_RE, (match) => {
      const digits = match.replace(/\D/g, "");
      return passesLuhn(digits) ? REDACTED : match;
    })
    .replace(EMAIL_RE, REDACTED);
}

/**
 * Redacts credential-shaped keys anywhere in the payload, and strips secrets out
 * of the free text around them. `user` is the field you deliberately fill with
 * an identity, so its strings are left alone; its keys are still checked.
 */
function scrubValue(
  value: unknown,
  depth: number,
  text: boolean,
  seen: Set<object>,
): unknown {
  if (typeof value === "string") return text ? scrubText(value) : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_SCRUB_DEPTH) return TRUNCATED;
  // Walking a copy means a cycle would recurse forever, and a context object
  // holding a reference back to itself is common enough to be worth surviving.
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => scrubValue(item, depth + 1, text, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key)
        ? REDACTED
        : scrubValue(nested, depth + 1, text && key !== "user", seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Last thing every payload passes through. Both the hook and the redaction live
 * here rather than in the capture functions, so nothing can be reported around
 * them.
 */
function scrubPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const hooked = beforeSend === null ? payload : beforeSend(payload);
  if (hooked === null || typeof hooked !== "object") return null;
  return scrubValue(hooked, 0, true, new Set()) as Record<string, unknown>;
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
  const match = value != null ? TRACEPARENT_RE.exec(value.trim()) : null;
  if (match && !allZeros(match[1]) && !allZeros(match[2])) {
    return { traceId: match[1].toLowerCase(), parentSpanId: match[2].toLowerCase() };
  }
  return { traceId: randomHex(16) };
}

// ── Frame source context (Node) ─────────────────────────────────────────────────

const FRAME_RE = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const CONTEXT_LINES = 5;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_CACHED_SOURCES = 256;
const sourceCache = new Map<string, string[] | null>();
const appRoot = resolvePath(process.cwd());

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

/**
 * True when `file` resolves inside the application root. Frames come from
 * `error.stack`, which is only a string, so a stack built from request data can
 * name any path on the host. Context lines are sent to monitoring, so reads stay
 * inside the project.
 */
function withinAppRoot(path: string): boolean {
  const full = resolvePath(path);
  return full === appRoot || full.startsWith(`${appRoot}${sep}`);
}

function readSource(file: string): string[] | null {
  if (sourceCache.has(file)) return sourceCache.get(file) ?? null;
  let lines: string[] | null = null;
  try {
    const path = toPath(file);
    // Big files are skipped, not truncated, so line numbers keep lining up.
    if (withinAppRoot(path) && statSync(path).size <= MAX_SOURCE_BYTES) {
      lines = readFileSync(path, "utf8").split("\n");
    }
  } catch {
    lines = null;
  }
  // A crafted stack can vary filenames without limit, so evict the oldest.
  if (sourceCache.size >= MAX_CACHED_SOURCES) {
    const oldest = sourceCache.keys().next();
    if (oldest.done !== true) sourceCache.delete(oldest.value);
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
    // Dependency and Node-internal frames get no context. It is noise in the
    // dashboard, and it keeps a crafted stack from reaching as far.
    const lines = frame.inApp ? readSource(filename) : null;
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

export type EventLevel = "debug" | "info" | "warning" | "error" | "fatal";

export interface Breadcrumb {
  timestamp?: string;
  type?: string;
  category?: string;
  level?: EventLevel;
  message?: string;
  data?: Record<string, unknown>;
}

/** Optional enrichment for a standalone monitoring event. */
export interface EventOptions {
  /** Defaults to the current time. */
  timestamp?: string | Date;
  /** Defaults to `info`. */
  level?: EventLevel;
  operationId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  latencyMs?: number;
  attempt?: number;
  requestId?: string;
  user?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  context?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
  fingerprint?: string;
  trace?: TraceContext;
  spanId?: string;
  /** Supply an id to make retried delivery idempotent. A random id is used otherwise. */
  eventId?: string;
}

/**
 * Logs an application event without a generated Octri client SDK.
 *
 * Delivery is fire-and-forget and best-effort: monitoring is never allowed to
 * affect the host application. Configure the client once with `init()` first.
 */
export function captureEvent(message: string, options: EventOptions = {}): void {
  if (config === null) return;
  const cfg = config;
  try {
    const timestamp = options.timestamp instanceof Date
      ? (Number.isNaN(options.timestamp.getTime())
          ? new Date().toISOString()
          : options.timestamp.toISOString())
      : (options.timestamp ?? new Date().toISOString());
    const eventId = resolveEventId(options.eventId);
    const payload: Record<string, unknown> = {
      eventId,
      timestamp,
      level: options.level ?? "info",
      message,
      operationId: options.operationId,
      method: options.method,
      path: options.path,
      statusCode: options.statusCode,
      latencyMs: options.latencyMs,
      attempt: options.attempt,
      requestId: options.requestId,
      environment: cfg.environment,
      release: cfg.release,
      user: options.user,
      tags: { "octri.origin": "standalone", ...(options.tags ?? {}) },
      context: options.context,
      breadcrumbs: options.breadcrumbs,
      fingerprint: options.fingerprint,
      traceId: options.trace?.traceId,
      spanId: options.spanId,
    };

    postJson(cfg, "/ingest", payload, eventId);
  } catch {
    // Invalid caller data must not affect the host application.
  }
}

/**
 * Reports an error to the monitoring project (fire-and-forget). Tagged
 * `octri.origin=server` and stamped with the request's `traceId`, so it links to
 * the client SDK error for the same request.
 */
export function captureError(error: unknown, options: CaptureOptions = {}): void {
  if (config === null) return;
  const cfg = config;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const trace = options.trace ?? { traceId: randomHex(16) };
    const eventId = randomHex(16);

    const payload: Record<string, unknown> = {
      eventId,
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

    postJson(cfg, "/ingest", payload, eventId);
  } catch {
    // Invalid error-like values must not affect the host application.
  }
}

// ── Spans (request waterfall) ────────────────────────────────────────────────

export interface SpanInput {
  traceId: string;
  /** This span's id. */
  spanId: string;
  /** The caller's span id, i.e. the client request that triggered this one. */
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
 * a `traceId` form the request waterfall: the client SDK span (root) and this
 * server span (its child) line up under one trace in the dashboard.
 */
export function captureSpan(span: SpanInput): void {
  if (config === null) return;
  const cfg = config;
  try {
    if (
      !isNonBlank(span.traceId) ||
      !isNonBlank(span.spanId) ||
      !isNonBlank(span.name) ||
      !isNonBlank(span.startTime) ||
      Number.isNaN(Date.parse(span.startTime)) ||
      (span.endTime !== undefined &&
        (!isNonBlank(span.endTime) || Number.isNaN(Date.parse(span.endTime)))) ||
      (span.traceId.length === 32 && allZeros(span.traceId)) ||
      (span.spanId.length === 16 && allZeros(span.spanId))
    ) return;
    const body: Record<string, unknown> = { service: "server", environment: cfg.environment, ...span };
    postJson(cfg, "/traces", body, `${span.traceId}:${span.spanId}`);
  } catch {
    // Invalid caller data must not affect the host application.
  }
}

// ── Sub-spans (where time goes inside a request) ─────────────────────────────
// The active span for the running request, propagated through async work so a
// `startSpan`/`withSpan` call nests under it (and under any enclosing sub-span).

interface SpanContext {
  traceId: string;
  spanId: string;
}

const requestContext = new AsyncLocalStorage<SpanContext>();

/** Runs `fn` with `ctx` as the active span. Used by the request middleware. */
export function runWithSpanContext<T>(ctx: SpanContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

/** The active span for the running request, or undefined outside one. */
export function currentSpanContext(): SpanContext | undefined {
  return requestContext.getStore();
}

export interface SpanOptions {
  /** A category for color-coding the waterfall, e.g. "db", "cache", "http". */
  op?: string;
}

export interface SpanHandle {
  /** Closes the span and reports it. */
  finish(status?: "ok" | "error"): void;
}

/**
 * Opens a sub-span under the active request span; call `.finish()` when the work
 * finishes. No-op (a stub handle) outside a request or before `init()`.
 *
 *   const span = startSpan("users.findById", { op: "db" });
 *   const user = await db.user.find(id);
 *   span.finish();
 */
export function startSpan(name: string, options: SpanOptions = {}): SpanHandle {
  const ctx = requestContext.getStore();
  if (config === null || ctx === undefined) {
    return {
      finish() {
        /* no active request span, nothing to report */
      },
    };
  }
  const spanId = newSpanId();
  const startTime = new Date().toISOString();
  let ended = false;
  return {
    finish(status: "ok" | "error" = "ok") {
      if (ended) return;
      ended = true;
      captureSpan({
        traceId: ctx.traceId,
        spanId,
        parentSpanId: ctx.spanId,
        name,
        service: options.op ?? "server",
        startTime,
        endTime: new Date().toISOString(),
        status,
      });
    },
  };
}

/**
 * Times `fn` as a sub-span under the active request span. Nested `withSpan`
 * calls nest correctly. Reports "error" status if `fn` throws (and re-throws).
 *
 *   const rows = await withSpan("orders.list", () => db.query(sql), { op: "db" });
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T> | T,
  options: SpanOptions = {},
): Promise<T> {
  return await runSpan(name, options.op, fn);
}

// Core span wrapper used by withSpan + the auto-instrumentation. Runs `invoke`
// within a child span context (so nested spans parent correctly) and reports the
// span when it settles: synchronously for sync calls, on the promise for async
// ones (so it never forces a sync function to become async).
function runSpan<T>(name: string, op: string | undefined, invoke: () => T): T {
  const ctx = requestContext.getStore();
  if (config === null || ctx === undefined) return invoke();
  const spanId = newSpanId();
  const startTime = new Date().toISOString();
  const child: SpanContext = { traceId: ctx.traceId, spanId };
  const report = (status: "ok" | "error"): void =>
    captureSpan({
      traceId: ctx.traceId,
      spanId,
      parentSpanId: ctx.spanId,
      name,
      service: op ?? "server",
      startTime,
      endTime: new Date().toISOString(),
      status,
    });

  let result: T;
  try {
    result = requestContext.run(child, invoke);
  } catch (error) {
    report("error");
    throw error;
  }
  const maybeThenable = result as unknown as { then?: unknown } | null;
  if (maybeThenable !== null && typeof maybeThenable?.then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        report("ok");
        return value;
      },
      (error: unknown) => {
        report("error");
        throw error;
      },
    ) as unknown as T;
  }
  report("ok");
  return result;
}

// ── Automatic instrumentation ────────────────────────────────────────────────

export interface InstrumentOptions {
  /** Span category for the waterfall, e.g. "db", "cache", "http". */
  op?: string;
  /** Build a span name from the method + call args (default: the method name). */
  name?: (method: string, args: unknown[]) => string;
}

/**
 * Wraps the named methods of an object (or prototype) so every call becomes a
 * sub-span automatically. Point it at a DB client, cache, or util module once
 * and all calls are traced without per-call code. Mutates and returns `target`.
 *
 *   octri.instrument(pool, ["query"], { op: "db" });
 *   octri.instrument(cache, ["get", "set"], { op: "cache" });
 */
export function instrument<T extends object>(
  target: T,
  methods: string[],
  options: InstrumentOptions = {},
): T {
  const record = target as Record<string, unknown>;
  const nameFor = options.name ?? ((method: string): string => method);
  for (const method of methods) {
    const original = record[method];
    if (typeof original !== "function") continue;
    const fn = original as (...args: unknown[]) => unknown;
    record[method] = function instrumented(this: unknown, ...args: unknown[]): unknown {
      return runSpan(nameFor(method, args), options.op, () => fn.apply(this, args));
    };
  }
  return target;
}

/** Wraps a standalone function so each call becomes a sub-span. */
export function instrumentFunction<A extends unknown[], R>(
  fn: (...args: A) => R,
  options: { name?: string; op?: string } = {},
): (...args: A) => R {
  const label = options.name ?? (fn.name !== "" ? fn.name : "fn");
  return (...args: A): R => runSpan(label, options.op, () => fn(...args));
}

export interface AutoInstrumentOptions {
  /** Instrument the global `fetch` (outbound HTTP). Default true. */
  fetch?: boolean;
  /** Best-effort instrument popular DB/cache drivers if installed. Default true. */
  db?: boolean;
}

/**
 * Turns on zero-config tracing for common I/O: wraps the global `fetch` so every
 * outbound HTTP call is a span, and best-effort instruments popular DB/cache
 * drivers (pg, mysql2, ioredis) when they're installed. Call once after init().
 * For your own DB client or util modules, use {@link instrument}.
 */
export function autoInstrument(options: AutoInstrumentOptions = {}): void {
  if (options.fetch !== false) patchFetch();
  if (options.db !== false) {
    patchPg();
    patchMysql2();
    patchIoredis();
  }
}

let fetchPatched = false;

function patchFetch(): void {
  const g = globalThis as unknown as { fetch?: (...args: unknown[]) => Promise<unknown> };
  const original = g.fetch;
  if (fetchPatched || typeof original !== "function") return;
  fetchPatched = true;
  g.fetch = function patchedFetch(this: unknown, ...args: unknown[]): Promise<unknown> {
    // Never trace calls to the monitoring backend itself, or reporting recurses
    // forever. Compared by origin, since a prefix match also skips lookalikes.
    if (config !== null && isMonitoringUrl(fetchUrl(args), config.url)) {
      return original.apply(this, args);
    }
    return runSpan(fetchSpanName(args), "http", () => original.apply(this, args));
  } as typeof g.fetch;
}

function isMonitoringUrl(url: string, monitoringUrl: string): boolean {
  try {
    const target = new URL(url);
    const monitoring = new URL(monitoringUrl);
    return (
      target.origin === monitoring.origin &&
      target.pathname.startsWith(monitoring.pathname)
    );
  } catch {
    return false;
  }
}

function fetchUrl(args: unknown[]): string {
  const input = args[0];
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input !== null && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return "";
}

function fetchSpanName(args: unknown[]): string {
  const url = fetchUrl(args);
  const init = args[1] as { method?: string } | undefined;
  const method = (init?.method ?? "GET").toUpperCase();
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.host}${parsed.pathname}`;
  } catch {
    return `${method} ${url}`.trim();
  }
}

// `require` is available in this package's CommonJS output; resolve optional
// peer drivers without making them dependencies.
declare const require: (id: string) => unknown;

function tryRequire(id: string): Record<string, unknown> | null {
  try {
    return require(id) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/).slice(0, count).join(" ");
}

function sqlName(args: unknown[]): string {
  const query = args[0];
  const text =
    typeof query === "string"
      ? query
      : query !== null && typeof query === "object" && "text" in query
        ? String((query as { text: unknown }).text)
        : "query";
  return firstWords(text, 6);
}

function patchProto(mod: Record<string, unknown> | null, classNames: string[], methods: string[], op: string, name?: (m: string, a: unknown[]) => string): void {
  if (mod === null) return;
  for (const className of classNames) {
    const cls = mod[className] as { prototype?: object } | undefined;
    if (cls?.prototype !== undefined) {
      instrument(cls.prototype, methods, name !== undefined ? { op, name } : { op });
    }
  }
}

function patchPg(): void {
  patchProto(tryRequire("pg"), ["Client", "Pool"], ["query"], "db", (_m, args) => sqlName(args));
}

function patchMysql2(): void {
  patchProto(tryRequire("mysql2"), ["Connection", "Pool"], ["query", "execute"], "db", (_m, args) => sqlName(args));
}

function patchIoredis(): void {
  const mod = tryRequire("ioredis");
  const cls = (mod?.default ?? mod?.Redis ?? mod) as { prototype?: object } | undefined;
  if (cls?.prototype !== undefined) {
    instrument(cls.prototype, ["sendCommand"], {
      op: "cache",
      name: (_m, args) => {
        const cmd = args[0] as { name?: unknown } | undefined;
        return `redis ${typeof cmd?.name === "string" ? cmd.name : "command"}`;
      },
    });
  }
}
