import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { signIn } from "./guide-browser-checks.mjs";
import AxeBuilder from "@axe-core/playwright";

export async function checkConsole(browser, server, taskId, check, screenshot) {
  const legacyContext = await browser.newContext({ timezoneId: "Africa/Lagos" });
  const legacy = await legacyContext.newPage();
  const legacyErrors = [];
  legacy.on("pageerror", (error) => legacyErrors.push(error.message));
  await legacy.goto(`${server.session.url}/workspace/controls#tasks`);
  await legacy.getByLabel("Access code", { exact: true }).waitFor();
  await legacy.evaluate(() => document.fonts.ready);
  const appearance = await legacy.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    heading: getComputedStyle(document.querySelector("h1")).fontFamily,
    background: getComputedStyle(document.body).backgroundColor,
    fonts: [...document.fonts]
      .filter((font) => font.status === "loaded")
      .map((font) => font.family.replaceAll('"', "")),
  }));
  assert.match(appearance.body, /Manrope/);
  assert.match(appearance.heading, /Space Grotesk/);
  assert.equal(appearance.background, "rgb(10, 11, 13)");
  assert.ok(appearance.fonts.includes("Manrope") && appearance.fonts.includes("Space Grotesk"));
  assert.doesNotMatch(
    await legacy.locator("body").innerText(),
    /HttpOnly|ASH_SERVER_ALLOW_REMOTE|loopback|host terminal/,
  );
  await screenshot(legacy, "controls-sign-in.png", false);
  await signIn(legacy, server);
  await legacy.getByRole("button", { name: "Skip guide", exact: true }).click();
  await legacy.getByLabel("Task description", { exact: true }).waitFor();
  assert.equal(new URL(legacy.url()).hash, "#tasks");
  await legacy.reload();
  await legacy.getByLabel("Task description", { exact: true }).waitFor();
  check("task-control deep links survive sign-in and reload");
  for (const theme of ["dark", "light"]) {
    await legacy.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const result = await new AxeBuilder({ page: legacy }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    assert.deepEqual(result.violations, [], `Controls accessibility (${theme}): ${JSON.stringify(result.violations)}`);
    await screenshot(legacy, `controls-${theme}.png`);
  }
  const nav = legacy.getByRole("navigation", { name: "Workspace navigation" });
  await legacy.evaluate(() => {
    window.reviewHeader = document.querySelector(".site-header");
    window.reviewSidebar = document.querySelector(".workspace-sidebar");
  });
  for (const [view, label] of Object.entries({
    overview: "Overview",
    agents: "Agents",
    receipts: "Receipts",
    activity: "Activity",
    security: "Approvals & security",
    settings: "Settings",
    tasks: "Tasks & execution",
  })) {
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    assert.equal(new URL(legacy.url()).hash, `#${view}`);
    assert.equal(
      await legacy.evaluate(
        () =>
          window.reviewHeader === document.querySelector(".site-header") &&
          window.reviewSidebar === document.querySelector(".workspace-sidebar"),
      ),
      true,
    );
  }
  await legacy.goBack();
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  await legacy.goForward();
  await expect(nav.getByRole("link", { name: "Tasks & execution", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await legacy.getByRole("link", { name: "Skip to content", exact: true }).focus();
  await legacy.keyboard.press("Enter");
  await expect(legacy.locator(".workspace-main")).toBeFocused();
  assert.equal(new URL(legacy.url()).hash, "#tasks", "Skip link must preserve the selected section");
  await legacy.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await legacy.reload();
  await expect(legacy.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Tasks & execution", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await legacy.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  check("sidebar and header persist across all sections; active URL, Back/Forward and saved desktop icon rail work");
  await legacy.getByLabel("Task description", { exact: true }).waitFor();
  await legacy.setViewportSize({ width: 390, height: 844 });
  await expect(nav).not.toBeVisible();
  await legacy.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "Tasks & execution", exact: true })).toBeFocused();
  await legacy.keyboard.press("Home");
  await expect(nav.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
  await legacy.keyboard.press("Shift+Tab");
  await expect(legacy.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
  await legacy.keyboard.press("Shift+Tab");
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toBeFocused();
  await legacy.keyboard.press("Tab");
  await expect(legacy.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
  await legacy.keyboard.press("Escape");
  await expect(nav).not.toBeVisible();
  await expect(legacy.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
  await legacy.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect.poll(() => nav.evaluate((element) => element.getBoundingClientRect().left)).toBe(0);
  await screenshot(legacy, "workspace-drawer.png", false);
  await nav.getByRole("link", { name: "Tasks & execution", exact: true }).click();
  await expect(nav).not.toBeVisible();
  await expect(legacy.locator(".workspace-main")).toBeFocused();
  await legacy.getByRole("button", { name: "Open navigation", exact: true }).click();
  await legacy.getByRole("button", { name: "Help", exact: true }).click();
  await expect(nav).not.toBeVisible();
  await expect(legacy.getByRole("dialog", { name: "Welcome to Ash", exact: true })).toBeVisible();
  await legacy.getByRole("button", { name: "Skip guide", exact: true }).click();
  assert.equal(await legacy.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const plan = legacy.getByRole("region", { name: "Task plan", exact: true });
  await plan.focus();
  await legacy.keyboard.press("ArrowRight");
  await expect.poll(() => plan.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await plan.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await legacy.evaluate(() => window.scrollTo(0, 0));
  await screenshot(legacy, "controls-mobile.png");
  await legacy.setViewportSize({ width: 1280, height: 900 });
  check("mobile drawer starts closed, supports keyboard focus/Escape and retains responsive task controls");
  const description = legacy.getByLabel("Task description", { exact: true });
  await description.fill("Preserve this unsent task brief");
  await legacy.locator("#view-root h1, #view-root h2").first().click();
  const refresh = legacy.waitForResponse((response) => response.url().endsWith("/api/state") && response.ok());
  server.bus.publish({ type: "refresh", reason: "Test unsent browser draft preservation" });
  await refresh;
  await legacy.waitForTimeout(300);
  assert.equal(await description.inputValue(), "Preserve this unsent task brief");
  check("legacy task drafts survive background refresh after input loses focus");

  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  const deadline = legacy.getByLabel("Deadline", { exact: true });
  await deadline.fill("2099-01-01T12:30");
  const saved = legacy.waitForResponse(
    async (response) =>
      response.url().endsWith("/settings") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().key === "deadline",
  );
  await legacy.getByRole("button", { name: "Save preferences" }).click();
  assert.equal((await saved).status(), 200);
  assert.equal((await server.services.store.load(taskId)).deadline, "2099-01-01T11:30:00.000Z");
  await legacy.getByText("Save preferences complete", { exact: true }).waitFor();
  check("legacy settings convert the local deadline to UTC before persistence");

  let release, captured;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const intercepted = new Promise((resolve) => {
    captured = resolve;
  });
  await legacy.route("**/api/state", async (route) => {
    const response = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response });
  });
  try {
    server.bus.publish({ type: "refresh", reason: "Test late snapshot after logout" });
    await Promise.race([
      intercepted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("snapshot interception timed out")), 15000)),
    ]);
    await legacy.getByRole("button", { name: "Disconnect", exact: true }).click();
    await legacy.getByLabel("Access code", { exact: true }).waitFor({ state: "visible" });
    release();
    await legacy.waitForTimeout(500);
    assert.equal(await legacy.locator("#view-root").count(), 0);
    assert.equal(await legacy.locator(".workspace-main").count(), 0);
    assert.deepEqual(legacyErrors, []);
  } finally {
    release();
  }
  check("a delayed legacy snapshot cannot restore private views after logout");
  await legacy.goto(`${server.session.url}/console`);
  await legacy.getByLabel("Access code", { exact: true }).waitFor({ state: "visible" });
  check("the console compatibility route remains available");
  await legacyContext.close();
}
