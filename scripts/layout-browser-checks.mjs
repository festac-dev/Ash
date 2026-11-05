import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { signIn } from "./guide-browser-checks.mjs";

const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1440, height: 2400 },
  { width: 2560, height: 1440 },
];

async function headerFits(page) {
  // Canvas ResizeObserver updates arrive after the viewport change. Measure the settled layout.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const bounds = await page.evaluate(() => {
    const header = document.querySelector(".site-header");
    const items = [
      ...header.querySelectorAll(
        ".brand > img, .brand > span, :scope > .demo-label, :scope > nav, .header-actions > *",
      ),
    ]
      .map((item) => {
        const rect = item.getBoundingClientRect();
        return {
          name: item.getAttribute("aria-label") || item.textContent || item.tagName,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((item) => item.width > 0 && item.height > 0)
      .sort((a, b) => a.left - b.left);
    return { items, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(bounds.overflow, false, `Page overflows at ${bounds.width}px`);
  for (let index = 0; index < bounds.items.length; index++) {
    const item = bounds.items[index];
    assert.ok(item.left >= 0 && item.right <= bounds.width + 1, `${item.name} is clipped at ${bounds.width}px`);
    if (index)
      assert.ok(
        item.left >= bounds.items[index - 1].right + 3,
        `Header items overlap or crowd at ${bounds.width}px: ${JSON.stringify(bounds.items)}`,
      );
  }
}

async function featureCardsFit(page) {
  const cards = await page.locator(".feature-card").evaluateAll((elements) =>
    elements.map((card) => {
      const bounds = card.getBoundingClientRect();
      const content = [...card.querySelectorAll(":scope > div > svg, :scope > div > span, h3, p")].map((item) => {
        const rect = item.getBoundingClientRect();
        return { text: item.textContent || item.tagName, left: rect.left, right: rect.right };
      });
      return { left: bounds.left, right: bounds.right, width: innerWidth, content };
    }),
  );
  assert.equal(cards.length, 3);
  for (const card of cards) {
    assert.ok(card.left >= 0 && card.right <= card.width, "Feature card must remain inside the viewport");
    for (const item of card.content) {
      assert.ok(
        item.left >= card.left + 16 && item.right <= card.right - 16,
        `Feature content touches or crosses the card edge: ${JSON.stringify({ card, item })}`,
      );
    }
  }
}

export async function checkLayout(browser, server, check) {
  const context = await browser.newContext({ reducedMotion: "reduce", deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    await page.goto(server.session.url);
    await page.locator(".demo-label").waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.getByRole("button", { name: "Switch to light theme" }).click();
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await headerFits(page);
        await featureCardsFit(page);
        const layout = await page.evaluate(() => {
          const footer = document.querySelector(".site-footer").getBoundingClientRect();
          const main = document.querySelector("main").getBoundingClientRect();
          return {
            bottom: footer.bottom + scrollY,
            top: footer.top + scrollY,
            mainBottom: main.bottom + scrollY,
            height: innerHeight,
            pageHeight: document.documentElement.scrollHeight,
          };
        });
        assert.ok(layout.bottom >= layout.height - 1, `Footer floats above the viewport: ${JSON.stringify(layout)}`);
        assert.ok(Math.abs(layout.bottom - layout.pageHeight) <= 1, `Gap below the footer: ${JSON.stringify(layout)}`);
        assert.ok(layout.top >= layout.mainBottom - 1, "Footer must not overlap content");
      }
    }
    check(
      "landing footer stays at the page bottom across phone, tablet, desktop, landscape and tall viewports in both themes",
    );
    check(
      "all three feature cards keep their icons, numbers and copy inset within their panels across viewport sizes and themes",
    );
    await page.goto(`${server.session.url}/workspace`);
    await signIn(page, server);
    await page.getByRole("button", { name: "Skip guide", exact: true }).click();
    const nav = page.getByRole("navigation", { name: "Workspace navigation" });
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await headerFits(page);
      if (viewport.width > 720) {
        await expect(nav).toBeVisible();
        continue;
      }
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await expect(nav).toBeVisible();
      const layout = await nav.evaluate((element) => {
        const nav = element.getBoundingClientRect();
        const header = document.querySelector(".site-header").getBoundingClientRect();
        const backdrop = document.querySelector(".sidebar-backdrop").getBoundingClientRect();
        return {
          top: nav.top,
          bottom: nav.bottom,
          headerBottom: header.bottom,
          backdropBottom: backdrop.bottom,
          height: innerHeight,
        };
      });
      assert.ok(Math.abs(layout.top - layout.headerBottom) <= 1, "Drawer must meet the header");
      assert.ok(Math.abs(layout.bottom - layout.height) <= 1, `Drawer must meet the bottom: ${JSON.stringify(layout)}`);
      assert.ok(Math.abs(layout.backdropBottom - layout.height) <= 1, "Drawer backdrop must fill the viewport");
      await nav.getByRole("link", { name: "Settings", exact: true }).scrollIntoViewIfNeeded();
      await expect(nav.getByRole("link", { name: "Settings", exact: true })).toBeInViewport();
      await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    }
    check(
      "workspace header stays unclipped and mobile navigation fills the available screen, including short landscape screens and high DPI",
    );
  } finally {
    await context.close();
  }
}
