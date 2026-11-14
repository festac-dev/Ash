import { setTheme } from "./browser-appearance.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
    await expect(tracks.getByRole("button", { name: "Run track", exact: true })).toHaveCount(7);
    await expect(cards).toHaveCount(7);
    await expect(tracks.locator(".track-state")).toHaveText(Array(7).fill("NOT RUN"));
    check("track sign-in opens the workspace with seven unrun workstreams");

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
    await expect(tracks.locator(".track-state-not-run")).toHaveCount(6);
    await expect(security.getByRole("button", { name: "Run again", exact: true })).toBeEnabled();
    check("single-track verification shows its result and leaves the other six unrun");

    const verifyAll = tracks.getByRole("button", { name: "Verify all 7", exact: true });
    const journey = await verify(verifyAll, {});
    assert.equal(journey.all_passed, true);
    assert.equal(journey.passed, 7);
    await expect(tracks.locator(".track-verdict")).toContainText("PASS · 7/7 workstreams");
    await expect(tracks.locator(".track-state")).toHaveText(Array(7).fill("PASS"));
    await expect(tracks.getByRole("button", { name: "Run again", exact: true })).toHaveCount(7);
    check("all-workstream verification displays passing local evidence and the shared journey verdict");

    await verify(security.getByRole("button", { name: "Run again", exact: true }), { track_id: "security" });
    await expect(tracks.locator(".track-verdict")).toHaveCount(0);
    await expect(tracks.locator(".track-state")).toHaveText(Array(7).fill("PASS"));
    await expect(verifyAll).toBeEnabled();
    check("rerunning one track preserves all seven results and clears the old aggregate verdict");

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
    await expect(tracks.locator(".track-verdict")).toContainText("PASS · 7/7 workstreams");
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
    await page.getByRole("link", { name: "NEAR mainnet", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check payments on NEAR.", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify transfer", exact: true })).toBeVisible();
    let previewRequested = false;
    await page.route("**/api/mainnet/preview", (route) => {
      const body = route.request().postDataJSON();
      assert.deepEqual(Object.keys(body), ["transfer"]);
      previewRequested = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          verification: { expected: body.transfer, status: "VERIFIED_TRANSFER" },
          recorded: false,
        }),
      });
    });
    for (const [field, value] of Object.entries({
      hash: "EFWy1YAmbQQMBPCheirp6oVSwEV6EVNfX7isCeE8nsoL",
      signer: "buyer.near",
      sender: "buyer.near",
      recipient: "seller.near",
      token: "usdc.near",
      atomic: "1000000",
    }))
      await page.locator(`#near-proof-${field}`).fill(value);
    await page.getByRole("button", { name: "Verify transfer", exact: true }).click();
    await expect(page.getByText(/Nothing was saved or assigned to a payment/)).toBeVisible();
    assert.equal(previewRequested, true);
    assert.equal(await page.locator("#near-purpose, #near-proof-reference").count(), 0);
    check(
      "browser transfer verification previews proof without submitting payment purpose/reference or recording settlement",
    );
    await page.route(
      "**/api/mainnet/check*",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Mainnet provider unavailable" } }),
        }),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Check mainnet", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Mainnet provider unavailable");
    await page.route(
      "**/api/mainnet/check*",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: { latest_block_height: 224413189 },
            supported_assets: 2,
            assets: [
              { assetId: "nep141:wrap.near", decimals: 24, symbol: "wNEAR", blockchain: "near" },
              { assetId: "nep141:usdc.near", decimals: 6, symbol: "USDC", blockchain: "near" },
            ],
            near_assets: [{ assetId: "nep141:usdc.near", decimals: 6, symbol: "USDC", blockchain: "near" }],
            account: null,
          }),
        }),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Check mainnet", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Check track evidence for payment verification.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Get dry quote", exact: true })).toBeVisible();
    check(
      "mainnet read-only panel handles provider failure and retry with fixture responses and retains unverified payment status",
    );
    await page.getByRole("button", { name: "Check track evidence", exact: true }).click();
    const evidence = page.getByRole("table", { name: "Live track evidence" });
    await expect(evidence.locator("tbody tr")).toHaveCount(6);
    await expect(evidence.locator(".mainnet-verdict")).toHaveText(Array(6).fill("Unverified"));
    await expect(evidence.getByText("Invoice token settlement", { exact: true })).toBeVisible();
    await expect(page.getByText("0 of 6 track checks have verified evidence.", { exact: true })).toBeVisible();
    check("live evidence renders all six backend verdicts and their scopes without claiming paid success");
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ["dark", "light"]) {
      await setTheme(page, theme);
      await expect(evidence.locator("tbody tr")).toHaveCount(6);
      await expect(evidence.getByText("Invoice token settlement", { exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      assert.deepEqual(audit.violations, [], `${theme} mobile mainnet evidence accessibility`);
    }
    check("live evidence stays readable on mobile in both themes with zero automated WCAG AA violations");
    assert.equal(server.services.engine.isRunning(), false);
    check("live workspace omits simulation-only controls; the API still refuses fixture execution");
  } finally {
    await context.close();
    await server?.close();
    await cleanup(dir);
    setLogger(previousLogger);
  }
}
