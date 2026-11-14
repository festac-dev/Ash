import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export async function signIn(page, server) {
  const response = await fetch(`${server.session.url}/api/frontend/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.session.token}` },
  });
  assert.equal(response.status, 200);
  await page.getByLabel("Access code", { exact: true }).fill((await response.json()).code);
  await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
}

export async function checkGuide(browser, server, check, screenshot) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    const guide = page.getByRole("dialog", { name: "Welcome to Ash", exact: true });
    await page.goto(server.session.url);
    await expect(guide).toHaveCount(0);
    await page.getByRole("link", { name: "Open workspace", exact: true }).first().click();
    await expect(page.getByLabel("Access code", { exact: true })).toBeVisible();
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Help", exact: true })).toHaveCount(0);
    await page.getByLabel("Access code", { exact: true }).fill("0000000000000000");
    await page.getByRole("button", { name: "Connect workspace", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(guide).toHaveCount(0);
    // A pending validation must not reveal either the guide or private navigation.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/api/auth/login",
      async (route) => {
        await held;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await signIn(page, server);
      await expect(page.getByRole("button", { name: "Connecting…" })).toBeVisible();
      await expect(guide).toHaveCount(0);
      await expect(page.locator(".workspace-sidebar")).toHaveCount(0);
    } finally {
      release();
    }
    await expect(guide).toBeVisible();
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(audit.violations, []);
    await screenshot(page, "workspace-guide.png", false);
    await guide.getByRole("button", { name: "Next", exact: true }).click();
    await expect(guide.getByRole("heading", { name: "A live network" })).toBeVisible();
    await guide.getByRole("button", { name: "Back", exact: true }).click();
    await expect(guide.getByRole("heading", { name: "Tasks & budgets" })).toBeVisible();
    await guide.getByRole("button", { name: "Next", exact: true }).click();
    await guide.getByRole("button", { name: "Next", exact: true }).click();
    await guide.getByRole("button", { name: "Get started", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await expect(guide).toHaveCount(0);
    check(
      "guide waits for successful validation; invalid and pending codes reveal neither guide nor workspace; completion persists",
    );
    await page.getByRole("button", { name: "Help", exact: true }).click();
    await expect(guide).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Help", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByLabel("Access code", { exact: true })).toBeVisible();
    await page.goto(`${server.session.url}/workspace#guide`);
    await expect(page.getByLabel("Access code", { exact: true })).toBeVisible();
    await expect(guide).toHaveCount(0);
    await signIn(page, server);
    await expect(guide).toBeVisible();
    await guide.getByRole("button", { name: "Skip guide", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await signIn(page, server);
    await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await expect(guide).toHaveCount(0);
    assert.equal(await page.evaluate(() => localStorage.getItem("ash.quick-start.v1")), "seen");
    check(
      "dismissed guide stays dismissed on subsequent login; explicit Help and tour links work only after authentication",
    );
  } finally {
    await context.close();
  }
  for (const blocked of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    try {
      await context.addInitScript((blocked) => {
        if (blocked)
          Storage.prototype.getItem = Storage.prototype.setItem = () => {
            throw new DOMException("Storage unavailable", "SecurityError");
          };
        else localStorage.setItem("ash-theme", "light");
      }, blocked);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${server.session.url}/workspace`);
      await expect(page.getByLabel("Access code", { exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await signIn(page, server);
      await expect(page.getByRole("dialog", { name: "Welcome to Ash", exact: true })).toBeVisible();
      if (!blocked) {
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        assert.deepEqual(
          (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations,
          [],
        );
        await screenshot(page, "workspace-guide-light.png", false);
      }
      await page.getByRole("button", { name: "Skip guide", exact: true }).click();
      await page.getByRole("button", { name: "Help", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      assert.deepEqual(errors, []);
      check(
        blocked
          ? "blocked storage never prevents sign-in, dismissal or authenticated Help"
          : "authenticated guide respects the saved light theme and passes accessibility checks",
      );
    } finally {
      await context.close();
    }
  }
}
