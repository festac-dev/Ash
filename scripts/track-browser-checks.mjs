import assert from "node:assert/strict";
import { expect } from "@playwright/test";

/** Exercise real local verification without requiring a WebGL-capable device. */
export async function checkTracks(browser, server, check) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.session.url}/workspace`);
    const tracks = page.locator("#tracks");
    const cards = tracks.locator(".track-card");
    const security = cards.filter({ has: page.getByRole("heading", { name: "AI Security & Defense", exact: true }) });
    await expect(page.getByRole("heading", { name: "Connect your workspace", exact: true })).toBeVisible();
    await expect(cards).toHaveCount(0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    check("private track workspace requires sign-in on mobile");
    const issued = await fetch(`${server.session.url}/api/frontend/code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.session.token}` },
    });
    assert.equal(issued.status, 200);
    const { code } = await issued.json();
    await page.getByLabel("Access code", { exact: true }).fill(code);
    await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
    await page.getByRole("button", { name: "Skip guide", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Connect your workspace", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("link", { name: "Track verification", exact: true }).click();
    await expect(tracks.getByRole("button", { name: "Run track", exact: true })).toHaveCount(6);
    await expect(cards).toHaveCount(6);
    await expect(tracks.locator(".track-state")).toHaveText(Array(6).fill("NOT RUN"));
    check("track sign-in opens the workspace with six unrun tracks");

    const verify = async (button, body) => {
      const responsePromise = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/tracks/verify" && response.request().method() === "POST",
      );
      await button.click();
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      assert.deepEqual(response.request().postDataJSON(), body);
      return response.json();
    };
    const single = await verify(security.getByRole("button", { name: "Run track", exact: true }), {
      track_id: "security",
    });
    assert.equal(single.track.track_id, "security");
    assert.ok(single.track.checks.length > 0 && single.track.checks.every((item) => item.passed));
    await expect(security.locator(".track-state")).toHaveText("PASS");
    await expect(tracks.locator(".track-state-not-run")).toHaveCount(5);
    await expect(security.getByRole("button", { name: "Run again", exact: true })).toBeEnabled();
    check("single-track verification shows its result and leaves the other five unrun");

    const verifyAll = tracks.getByRole("button", { name: "Verify all six", exact: true });
    const journey = await verify(verifyAll, {});
    assert.equal(journey.all_passed, true);
    assert.equal(journey.passed, 6);
    await expect(tracks.locator(".track-verdict")).toContainText("PASS · 6/6 workstreams");
    await expect(tracks.locator(".track-state")).toHaveText(Array(6).fill("PASS"));
    await expect(tracks.getByRole("button", { name: "Run again", exact: true })).toHaveCount(6);
    check("all-six verification displays passing local evidence and the shared journey verdict");

    // After verification the action is "Run again", not the initial "Run track".
    await verify(security.getByRole("button", { name: "Run again", exact: true }), { track_id: "security" });
    await expect(tracks.locator(".track-verdict")).toHaveCount(0);
    await expect(tracks.locator(".track-state")).toHaveText(Array(6).fill("PASS"));
    await expect(verifyAll).toBeEnabled();
    check("rerunning one track preserves all six results and clears the old aggregate verdict");

    await page.route(
      "**/api/tracks/verify",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Verification temporarily unavailable" } }),
        }),
      { times: 1 },
    );
    await verifyAll.click();
    await expect(tracks.getByRole("alert")).toHaveText("Verification temporarily unavailable");
    await expect(tracks.locator(".track-verdict")).toHaveCount(0);
    await expect(verifyAll).toBeEnabled();
    await verify(verifyAll, {});
    await expect(tracks.getByRole("alert")).toHaveCount(0);
    await expect(tracks.locator(".track-verdict")).toContainText("PASS · 6/6 workstreams");
    check("verification failures show an error and allow a successful retry");

    await page.setViewportSize({ width: 1440, height: 1080 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await expect(tracks.getByText("Local simulation only.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(tracks).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Connect your workspace", exact: true })).toBeVisible();
    assert.equal(server.services.engine.isRunning(), false);
    assert.deepEqual(errors, [], "unexpected browser errors during track verification");
    check("desktop layout, simulation labels and disconnect remain correct without starting the execution engine");
  } finally {
    await context.close();
  }
}

/** Live mode must never offer simulation-only actions. No inference or hiring occurs. */
export async function checkLiveWorkspace(browser, check) {
  const { startAshServer } = await import("../src/server/server.ts");
  const { tempDir, testConfig, cleanup } = await import("../tests/helpers.ts");
  const { logger, setLogger } = await import("../src/logger.ts");
  const previousLogger = logger;
  const dir = await tempDir("ash-live-workspace-");
  const config = testConfig(dir, {
    ASH_DEMO: "0",
    ASH_SIMULATE: "false",
    ASH_MODEL_PROVIDER: "ollama",
    ASH_MODEL_NAME: "browser-review-no-inference",
    ASH_MODEL_BASE_URL: "http://127.0.0.1:9",
    ASH_SERVER_PORT: "0",
  });
  let server;
  const context = await browser.newContext();
  try {
    server = await startAshServer({ config });
    const page = await context.newPage();
    await page.goto(`${server.session.url}/workspace`);
    const response = await fetch(`${server.session.url}/api/frontend/code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.session.token}` },
    });
    assert.equal(response.status, 200);
    await page.getByLabel("Access code", { exact: true }).fill((await response.json()).code);
    await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
    await page.getByRole("button", { name: "Skip guide", exact: true }).click();
    await expect(page.getByText("Workspace connected", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New task", exact: true })).toBeVisible();
    await expect(page.locator("#tracks")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Track verification", exact: true })).toHaveCount(0);
    await expect(page.locator(".demo-label")).toHaveCount(0);
    const blocked = await fetch(`${server.session.url}/api/tracks/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.session.token}` },
      body: "{}",
    });
    assert.equal(blocked.status, 403);
    assert.equal(server.services.engine.isRunning(), false);
    check("live workspace omits simulation-only controls; the API still refuses fixture execution");
  } finally {
    await context.close();
    await server?.close();
    await cleanup(dir);
    setLogger(previousLogger);
  }
}
