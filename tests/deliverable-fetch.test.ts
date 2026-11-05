import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import https from "node:https";
import { promises as dns } from "node:dns";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { safeFetchDeliverable } from "../src/security/guard.js";
import { AshError } from "../src/errors.js";

// Keep DNS validation and the real request/stream lifecycle; route only the transport
// to a temporary loopback HTTP server so the tests never contact external hosts.
async function fixture(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
  const port = (server.address() as AddressInfo).port;
  t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  const requests: http.ClientRequest[] = [];
  t.mock.method(
    https,
    "request",
    (url: URL, options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
      const request = http.request(
        { ...options, lookup: undefined, host: "127.0.0.1", port, path: url.pathname },
        callback,
      );
      requests.push(request);
      return request;
    },
  );
  return requests;
}
const timedOut = (error: unknown) =>
  error instanceof AshError && error.code === "VERIFICATION_FAILED" && /timed out/i.test(error.message);

test("deliverable deadline aborts a response that continuously sends data", async (t) => {
  let chunksSent = 0;
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const requests = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("start");
    const chunks = setInterval(() => {
      chunksSent++;
      res.write(".");
    }, 25);
    const rescue = setTimeout(() => res.end("end"), 2500);
    res.on("close", () => {
      closed();
      clearInterval(chunks);
      clearTimeout(rescue);
    });
  });
  await assert.rejects(safeFetchDeliverable("https://delivery.example/report", 1024, 1000), timedOut);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.destroyed, true);
  assert.ok(chunksSent >= 2, "the response must be active when the hard deadline fires");
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      responseClosed,
      new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("Timed-out response socket did not close")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(guard);
  }
});

test("the same deliverable deadline covers stalled DNS without opening a socket", async (t) => {
  t.mock.method(
    dns,
    "lookup",
    () => new Promise((resolve) => setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 150)),
  );
  let requested = false;
  t.mock.method(https, "request", () => {
    requested = true;
    throw new Error("DNS escaped its deadline");
  });
  await assert.rejects(safeFetchDeliverable("https://delivery.example/report", 1024, 30), timedOut);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(requested, false, "late DNS answers must not start an abandoned download");
});

test("redirect bodies close immediately and redirect requests share the total deadline", async (t) => {
  const requests = await fixture(t, (req, res) => {
    const delay = setTimeout(() => {
      if (req.url === "/first") {
        res.writeHead(302, { Location: "/second" });
        res.write("redirect body never ends");
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("late delivery");
      }
    }, 600);
    res.on("close", () => clearTimeout(delay));
  });
  await assert.rejects(safeFetchDeliverable("https://delivery.example/first", 1024, 1000), timedOut);
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every((request) => request.destroyed),
    "redirect and final sockets must both close",
  );
});

test("an on-time redirected deliverable retains content, limits and type validation", async (t) => {
  await fixture(t, (req, res) => {
    if (req.url === "/first") res.writeHead(302, { Location: "/report" }).end();
    else if (req.url === "/binary") res.writeHead(200, { "Content-Type": "application/octet-stream" }).end("data");
    else res.writeHead(200, { "Content-Type": "text/plain" }).end("Verified result");
  });
  const result = await safeFetchDeliverable("https://delivery.example/first", 1024, 3000);
  assert.equal(result.text, "Verified result");
  assert.equal(result.url, "https://delivery.example/report");
  assert.equal(result.truncated, false);
  const limited = await safeFetchDeliverable("https://delivery.example/report", 4, 3000);
  assert.equal(limited.truncated, true);
  assert.ok(limited.bytes <= 4);
  await assert.rejects(safeFetchDeliverable("https://delivery.example/binary", 1024, 3000), /content type/);
});
