#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { startAshServer } from "../src/server/server.ts";
import { ensureFrontendBuild } from "../src/server/frontend-build.ts";
import { cleanup, tempDir, testConfig } from "../tests/helpers.ts";
import { checkTracks } from "./track-browser-checks.mjs";

await ensureFrontendBuild();
const dir = await tempDir("ash-tracks-browser-");
let server, browser;
try {
  server = await startAshServer({
    config: testConfig(dir, { ASH_SERVER_PORT: "0" }),
    token: "tracks-browser-test-token-0123456789",
  });
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  await checkTracks(browser, server, (name) => console.log(`PASS: ${name}`));
} finally {
  await browser?.close();
  await server?.close();
  await cleanup(dir);
}
