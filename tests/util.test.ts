import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { canonicalJson, hashJson } from "../src/util/json.js";
import { withFileLock, resolveArtifactPath, readTailLines } from "../src/util/fs.js";
import { initLogger, setLogger, createSilentLogger } from "../src/logger.js";
import { cleanup, tempDir } from "./helpers.js";

test("canonical JSON preserves prototype-named data and detects edits to every key", () => {
  const first = JSON.parse('{"__proto__":{"value":1},"constructor":"data","nested":{"__proto__":"one"}}');
  const second = JSON.parse('{"__proto__":{"value":2},"constructor":"data","nested":{"__proto__":"one"}}');
  assert.deepEqual(JSON.parse(canonicalJson(first)), first);
  assert.notEqual(hashJson(first), hashJson(second));
  assert.equal(canonicalJson({ z: 1, a: { b: 2, a: 3 } }), '{"a":{"a":3,"b":2},"z":1}');
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test("an old live lock cannot be stolen, and release permits the next writer", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "writer.lock");
  try {
    await withFileLock(file, async () => {
      await fs.utimes(file, new Date(0), new Date(0));
      await assert.rejects(
        () => withFileLock(file, async () => assert.fail("overlapping writers"), { staleMs: 1, timeoutMs: 5 }),
        /Another Ash process/,
      );
      assert.equal(JSON.parse(await fs.readFile(file, "utf8")).pid, process.pid);
    });
    await withFileLock(file, async () => assert.ok(true));
    await assert.rejects(() => fs.stat(file), /ENOENT/);
  } finally {
    await cleanup(dir);
  }
});

test("concurrent reclaimers recover a dead lock without overlapping or losing writes", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "writer.lock");
  const counter = path.join(dir, "counter");
  try {
    await fs.writeFile(file, JSON.stringify({ pid: 1073741823, host: hostname() }));
    await fs.utimes(file, new Date(0), new Date(0));
    await fs.writeFile(counter, "0");
    let inside = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(
          file,
          async () => {
            assert.equal(inside++, 0, "writers overlap");
            const value = Number(await fs.readFile(counter, "utf8"));
            await new Promise((resolve) => setTimeout(resolve, 5));
            await fs.writeFile(counter, String(value + 1));
            inside--;
          },
          { staleMs: 1, timeoutMs: 5000 },
        ),
      ),
    );
    assert.equal(await fs.readFile(counter, "utf8"), "8");
  } finally {
    await cleanup(dir);
  }
});

test("a lock owner does not delete a manually replaced lock", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "writer.lock");
  try {
    await withFileLock(file, async () => fs.writeFile(file, JSON.stringify({ token: "replacement" })));
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, "replacement");
  } finally {
    await cleanup(dir);
  }
});

test("artifact resolution rejects Windows streams and symbolic-link escapes", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => resolveArtifactPath(dir, "report.txt:secret"), /Unsafe/);
    await fs.mkdir(path.join(dir, "workspace"));
    await fs.mkdir(path.join(dir, "outside"));
    await fs.symlink(path.join(dir, "outside"), path.join(dir, "workspace", "linked"), "junction");
    await assert.rejects(() => resolveArtifactPath(path.join(dir, "workspace"), "linked/report.txt"), /symbolic links/);
    assert.equal(
      await resolveArtifactPath(path.join(dir, "workspace"), "nested/report.txt"),
      path.join(dir, "workspace", "nested", "report.txt"),
    );
  } finally {
    await cleanup(dir);
  }
});

test("audit logging recovers after a failed append instead of poisoning future entries", async () => {
  const dir = await tempDir();
  try {
    const log = await initLogger({ dataDir: dir, level: "debug" });
    await fs.mkdir(log.auditFile);
    await log.audit("first-fails");
    await fs.rmdir(log.auditFile);
    await log.audit("second-succeeds");
    assert.equal(JSON.parse((await fs.readFile(log.auditFile, "utf8")).trim()).event, "second-succeeds");
  } finally {
    setLogger(createSilentLogger());
    await cleanup(dir);
  }
});

test("invalid retry and rate-limit counts fail instead of hanging", async () => {
  const { RateLimiter, withRetries } = await import("../src/util/async.js");
  for (const value of [NaN, Infinity, 0, -1]) assert.throws(() => new RateLimiter(value), /Rate limit/);
  const limiter = new RateLimiter(2);
  for (const value of [3, 0, -1, NaN, Infinity]) await assert.rejects(() => limiter.take(value), /Token count/);
  await assert.rejects(() => withRetries(async () => true, { attempts: NaN }), /Retry attempts/);
});

test("log tails bound reads and discard partial records at the byte boundary", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "events.log");
  try {
    await fs.writeFile(file, "x".repeat(100_000) + "\nfirst\nsecond\nthird\n");
    assert.deepEqual(await readTailLines(file, 2), ["second", "third"]);
    assert.deepEqual(await readTailLines(file, 50, 20), ["first", "second", "third"]);
    await fs.writeFile(file, "x".repeat(100_000));
    assert.deepEqual(await readTailLines(file, 5, 1024), []);
    await fs.writeFile(file, "");
    assert.deepEqual(await readTailLines(file, 5), []);
  } finally {
    await cleanup(dir);
  }
});
