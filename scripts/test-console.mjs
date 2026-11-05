#!/usr/bin/env node
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { chromium } from "@playwright/test";
import { startAshServer } from "../src/server/server.ts";
import { createDemoTask } from "../src/demo.ts";
import { cleanup, tempDir, testConfig } from "../tests/helpers.ts";
import { checkConsole } from "./console-browser-checks.mjs";

const dir = await tempDir("ash-console-browser-");
const config = testConfig(dir, { ASH_SERVER_PORT: "0" });
const server = await startAshServer({ config, token: "console-browser-test-token-0123456789" });
let browser;
try {
  const taskId = await createDemoTask(config);
  const extraArgs = JSON.parse(process.env.ASH_BROWSER_ARGS || "[]");
  assert.ok(
    Array.isArray(extraArgs) && extraArgs.every((arg) => typeof arg === "string"),
    "ASH_BROWSER_ARGS must be an array of strings",
  );
  const screenshots = new URL("../docs/screenshots/", import.meta.url);
  await fs.mkdir(screenshots, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", ...extraArgs],
  });
  await checkConsole(
    browser,
    server,
    taskId,
    (name) => console.log(`PASS: ${name}`),
    (page, name, fullPage = true) => page.screenshot({ path: new URL(name, screenshots).pathname, fullPage }),
  );
} finally {
  await browser?.close();
  await server.close();
  await cleanup(dir);
}
