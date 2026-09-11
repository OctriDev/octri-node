import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sdk from "../dist/index.js";

// ─── Reported paths ───────────────────────────────────────────────────────────

test("requestPath drops the query string and fragment", () => {
  assert.equal(sdk.requestPath("/reset?token=secret"), "/reset");
  assert.equal(sdk.requestPath("/orders#note"), "/orders");
  assert.equal(sdk.requestPath("/orders/42"), "/orders/42");
  assert.equal(sdk.requestPath(undefined), "");
});

// ─── Source context ───────────────────────────────────────────────────────────

test("a crafted stack cannot pull source context from outside the app", async () => {
  const outside = mkdtempSync(join(tmpdir(), "octri-node-outside-"));
  const secretFile = join(outside, "secret.env");
  writeFileSync(secretFile, "LINE1\nDATABASE_PASSWORD=hunter2\nLINE3\n");

  let resolveRequest;
  const received = new Promise((resolve) => { resolveRequest = resolve; });
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(202).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    sdk.init({ url: `http://127.0.0.1:${port}`, environment: "test" });

    const error = new Error("boom");
    error.stack = `Error: boom\n    at handler (${secretFile}:2:1)`;
    sdk.captureError(error);

    const payload = await received;
    const serialized = JSON.stringify(payload);

    assert.equal(payload.error.frames.length, 1);
    assert.equal(payload.error.frames[0].contextLine, undefined);
    assert.equal(
      serialized.includes("hunter2"),
      false,
      "file contents outside the app root must never be reported",
    );
  } finally {
    server.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("source context still resolves for a frame inside the app", async () => {
  const inside = join(process.cwd(), "octri-context-fixture.mjs");
  writeFileSync(inside, "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  let resolveRequest;
  const received = new Promise((resolve) => { resolveRequest = resolve; });
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(202).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    sdk.init({ url: `http://127.0.0.1:${port}`, environment: "test" });

    const error = new Error("boom");
    error.stack = `Error: boom\n    at handler (${inside}:2:1)`;
    sdk.captureError(error);

    const payload = await received;
    assert.equal(payload.error.frames[0].contextLine, "const b = 2;");
  } finally {
    server.close();
    rmSync(inside, { force: true });
  }
});
