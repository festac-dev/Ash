#!/usr/bin/env node
import assert from "node:assert/strict";
import { checkConsole } from "./console-browser-checks.mjs";
import { checkGuide } from "./guide-browser-checks.mjs";
import { checkLayout } from "./layout-browser-checks.mjs";
import { checkLiveWorkspace, checkTracks } from "./track-browser-checks.mjs";
import { promises as fs } from "node:fs";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { startAshServer } from "../src/server/server.ts";
import { createDemoTask } from "../src/demo.ts";
import { cleanup, tempDir, testConfig } from "../tests/helpers.ts";

const dir = await tempDir("ash-frontend-browser-");
const config = testConfig(dir, { ASH_SERVER_PORT: "0" });
const server = await startAshServer({ config, token: "frontend-browser-test-token-0123456789" });
const report = { browser: `Chromium / ${process.platform} ${process.arch}`, checks: [], screenshots: [], metrics: {} };
let browser;
const check = (name) => {
  report.checks.push(name);
  console.log(`PASS: ${name}`);
};
const screenshots = new URL("../docs/screenshots/", import.meta.url);
await fs.mkdir(screenshots, { recursive: true });
const screenshot = async (page, name, fullPage = true) => {
  await page.screenshot({ path: new URL(name, screenshots).pathname, fullPage });
  report.screenshots.push(`docs/screenshots/${name}`);
};
const visibleText = (page, text) =>
  page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: 20000 });
const ready = async (page) => {
  await page.waitForFunction(
    () =>
      ["WebGL", "Canvas2D"].includes(document.querySelector('[data-testid="globe"]')?.dataset.renderer) &&
      document.querySelector("canvas"),
    null,
    { timeout: 45000 },
  );
  assert.equal(await page.getByText("Static view · 3D unavailable").count(), 0);
};
try {
  const extraArgs = JSON.parse(process.env.ASH_BROWSER_ARGS || "[]");
  assert.ok(
    Array.isArray(extraArgs) && extraArgs.every((arg) => typeof arg === "string"),
    "ASH_BROWSER_ARGS must be a JSON array of browser flags",
  );
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      ...extraArgs,
    ],
  });
  await checkLayout(browser, server, check);
  await checkGuide(browser, server, check, screenshot);
  await checkTracks(browser, server, check);
  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const preview = await noScript.newPage();
  await preview.goto(server.session.url);
  await preview.getByRole("heading", { name: "Intelligence that executes." }).waitFor();
  assert.deepEqual(await preview.locator(".metric-card strong").allTextContents(), []);
  await noScript.close();
  check("public content paints without waiting for JavaScript; private statistics remain empty");
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(server.session.url);
  await ready(page);
  await visibleText(page, "Ambient visualization");
  assert.deepEqual(await page.locator(".metric-card strong").allTextContents(), []);
  check("unauthenticated globe renders without inventing live statistics");
  await page.waitForTimeout(4000);
  report.metrics = await page.locator("canvas").evaluate((el) => ({
    fps: Number(el.dataset.fps),
    drawCalls: Number(el.dataset.drawCalls),
    pixelRatio: Number(el.dataset.pixelRatio),
    renderer: document.querySelector('[data-testid="globe"]').dataset.renderer,
    particles: Number(document.querySelector('[data-testid="globe"]').dataset.particles),
  }));
  assert.equal(await page.locator(".globe-controls button").count(), 0);
  const automatic = await page.locator("canvas").getAttribute("data-rotation");
  await page.waitForFunction((value) => document.querySelector("canvas")?.dataset.rotation !== value, automatic);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator('[data-testid="globe-canvas"]').focus();
  const before = await page.locator("canvas").getAttribute("data-rotation");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((value) => document.querySelector("canvas")?.dataset.rotation !== value, before);
  const after = await page.locator("canvas").getAttribute("data-rotation");
  const bounds = await page.locator("canvas").boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.45, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction((value) => document.querySelector("canvas")?.dataset.rotation !== value, after, {
    timeout: 10000,
  });
  assert.notEqual(await page.locator("canvas").getAttribute("data-rotation"), after);
  check("globe starts automatically without transport buttons; keyboard and mouse drag work");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("canvas").evaluate((element) => element.blur());
  await screenshot(page, "frontend-dark.png");
  await screenshot(page, "frontend-hero.png", false);
  const darkAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  report.metrics.darkAccessibilityViolations = darkAxe.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
  }));
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await screenshot(page, "frontend-light.png");
  const lightAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  report.metrics.lightAccessibilityViolations = lightAxe.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
  }));
  await page.reload();
  await ready(page);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  check("light/dark theme persists and both themes receive WCAG AA automated audits");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  const feature = page.locator(".feature-card").first();
  await feature.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".feature-card")).transform !== "none");
  await page.mouse.move(1, 1);
  await page.locator("#top").scrollIntoViewIfNeeded();
  check("feature hover loads optional motion without disrupting navigation");
  await page.getByRole("link", { name: "Open workspace", exact: true }).first().click();
  await page.getByRole("heading", { name: "Connect your workspace", exact: true }).waitFor();
  assert.equal(await page.locator(".hero").count(), 0);
  const codeResponse = await fetch(`${server.session.url}/api/frontend/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.session.token}` },
  });
  assert.equal(codeResponse.status, 200);
  const accessCode = (await codeResponse.json()).code;
  await page.locator("#token").fill(accessCode);
  await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
  await page.getByRole("button", { name: "Skip guide", exact: true }).click();
  await visibleText(page, "Workspace connected");
  assert.equal(page.url().includes(accessCode), false);
  assert.doesNotMatch(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    new RegExp(accessCode),
  );
  await page.reload();
  await visibleText(page, "Workspace connected");
  const replay = await fetch(`${server.session.url}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ code: accessCode }),
  });
  assert.equal(replay.status, 401);
  check(
    "one-time code connects through the actual browser form, survives reload as a cookie session and rejects replay",
  );
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.locator("#description").fill("Create a verifiable frontend launch checklist");
  await page.locator("#budget").fill("25");
  await page.getByRole("button", { name: "Create task draft" }).click();
  await visibleText(page, "Create a verifiable frontend launch checklist");
  const draft = await server.services.store.resolveRef("active");
  assert.equal(draft.status, "draft");
  assert.equal(draft.require_hiring_approval, true);
  assert.equal(server.services.engine.isRunning(), false);
  check("authenticated task creation preserves plan approval and does not execute or spend");
  await page.getByRole("button", { name: "Talk to ASH", exact: true }).first().click();
  await page.locator("#chat-input").fill("What is my task budget?");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator(".chat-turn.assistant").waitFor({ timeout: 15000 });
  assert.equal((await server.services.store.load(draft.id)).status, "draft");
  await page.getByRole("button", { name: "Close dialog" }).click();
  check("persistent chat uses the existing backend without changing execution");
  await server.service.cancel(draft.id, `CANCEL ${draft.id}`);
  const taskId = await createDemoTask(config);
  await server.services.store.update(taskId, (task) => {
    for (const s of task.subtasks) s.next_check_at = "2099-01-01T00:00:00Z";
  });
  server.bus.publish({ type: "refresh", reason: "Browser test simulation fixture installed" });
  await page.locator(".node-list button").first().waitFor({ timeout: 15000 });
  await page.locator(".node-list button").first().click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await server.services.store.update(taskId, (task) => {
    task.status = "executing";
    task.subtasks[0].phase = "running_diy";
    task.subtasks[0].updated_at = new Date().toISOString();
  });
  server.bus.publish({ type: "refresh", reason: "Controlled simulation transition for frontend test" });
  await visibleText(page, "Simulated execution activity");
  await screenshot(page, "frontend-connected.png");
  assert.equal(server.services.engine.isRunning(), false, "visualization started the engine");
  await server.services.store.update(taskId, (task) => {
    task.status = "paused";
  });
  server.bus.publish({ type: "refresh", reason: "End of controlled simulation transition" });
  check("real SSE refresh maps persisted transitions to explicitly simulated pulses; nodes have accessible details");
  const workspaceAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.equal(workspaceAxe.violations.length, 0, JSON.stringify(workspaceAxe.violations));
  report.metrics.workspaceDarkAccessibilityViolations = workspaceAxe.violations;
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  const workspaceLightAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.equal(workspaceLightAxe.violations.length, 0, JSON.stringify(workspaceLightAxe.violations));
  report.metrics.workspaceLightAccessibilityViolations = workspaceLightAxe.violations;
  await screenshot(page, "workspace-light.png");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await screenshot(page, "workspace-overview.png");
  const landingRequests = [];
  const landingPage = await context.newPage();
  landingPage.on("request", (request) => {
    if (/\/api\/(state|events|tasks|transactions)/.test(request.url())) landingRequests.push(request.url());
  });
  await landingPage.goto(server.session.url);
  await ready(landingPage);
  await landingPage.getByText("DEMO", { exact: true }).waitFor();
  assert.equal(await landingPage.locator(".workspace-main").count(), 0);
  assert.equal(await landingPage.getByText(draft.description, { exact: true }).count(), 0);
  assert.deepEqual(landingRequests, [], "Landing must never load private data, even with an authenticated cookie");
  await landingPage.close();
  check("workspace has its own authenticated layout; landing stays public with no private requests");
  await page.bringToFront();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("heading", { name: "Connect your workspace", exact: true }).waitFor();
  assert.equal(await page.locator(".workspace-main").count(), 0);
  await page.goto(server.session.url);
  await ready(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.querySelector('[data-testid="globe"]').dataset.motion === "reduced");
  const resting = await page.locator("canvas").getAttribute("data-rotation");
  await page.waitForTimeout(500);
  assert.equal(await page.locator("canvas").getAttribute("data-rotation"), resting);
  // The shorter public landing needs a shorter viewport to move the entire globe offscreen.
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForFunction(() => document.querySelector('[data-testid="globe"]').dataset.visible === "false");
  check("reduced motion disables auto rotation and offscreen rendering pauses without losing the scene");
  assert.deepEqual(errors, [], "unexpected browser errors");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  await phone.goto(server.session.url);
  await ready(phone);
  assert.equal(await phone.locator(".globe-controls button").count(), 0);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await screenshot(phone, "frontend-mobile.png");
  await phone.getByRole("link", { name: "Open workspace", exact: true }).first().tap();
  await phone.getByLabel("Access code", { exact: true }).waitFor();
  assert.equal(await phone.getByRole("dialog").count(), 0);
  await phone.goto(server.session.url);
  await ready(phone);
  await phone.emulateMedia({ reducedMotion: "reduce" });
  const canvas = phone.locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  const mobileBounds = await canvas.boundingBox();
  const session = await mobile.newCDPSession(phone);
  const x = Math.round(mobileBounds.x + mobileBounds.width * 0.5),
    y = Math.round(Math.max(90, mobileBounds.y + mobileBounds.height * 0.45));
  const rotationBefore = await canvas.getAttribute("data-rotation");
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 5; i++)
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 14 * i, y }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await phone.waitForFunction((value) => document.querySelector("canvas")?.dataset.rotation !== value, rotationBefore, {
    timeout: 10000,
  });
  assert.notEqual(await canvas.getAttribute("data-rotation"), rotationBefore);
  assert.equal(await canvas.evaluate((el) => getComputedStyle(el).touchAction), "pan-y");
  check("mobile starts automatically; 3D accepts touch drag and preserves vertical page scrolling");
  const fallback = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await fallback.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /webgl/.test(type) ? null : get.call(this, type, ...args);
    };
  });
  const staticPage = await fallback.newPage();
  await staticPage.goto(server.session.url);
  await staticPage.waitForFunction(
    () => document.querySelector('[data-testid="globe"]')?.dataset.renderer === "Canvas2D",
  );
  await staticPage.getByRole("link", { name: "Open workspace", exact: true }).first().click();
  await staticPage.getByLabel("Access code", { exact: true }).waitFor();
  assert.equal(await staticPage.getByRole("dialog").count(), 0);
  check("WebGL failure activates the live canvas fallback and keeps navigation and sign-in usable");
  assert.equal(
    report.metrics.darkAccessibilityViolations.length,
    0,
    JSON.stringify(report.metrics.darkAccessibilityViolations),
  );
  assert.equal(
    report.metrics.lightAccessibilityViolations.length,
    0,
    JSON.stringify(report.metrics.lightAccessibilityViolations),
  );
  check("zero automated WCAG A/AA violations in dark and light themes");
  await Promise.all([context.close(), mobile.close(), fallback.close()]);

  await checkConsole(browser, server, taskId, check, screenshot);
  await checkLiveWorkspace(browser, check);
} finally {
  await fs.writeFile(
    new URL("../docs/frontend-browser-results.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await server.close();
  await cleanup(dir);
}
