import { setTheme } from "./browser-appearance.mjs";
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
  { width: 980, height: 2120 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1440, height: 2400 },
  { width: 2560, height: 1440 },
];

async function headerFits(page) {
  // Canvas ResizeObserver updates arrive after the viewport change. Measure the settled layout.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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

export async function checkGlobeFraming(page, check) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".globe-fallback").evaluate((image) => image.decode());
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.locator(".globe-canvas").scrollIntoViewIfNeeded();
    await headerFits(page);
    const framing = await page.evaluate(() => {
      const canvas = document.querySelector(".globe-renderer canvas");
      const image = document.querySelector(".globe-fallback");
      const rect = canvas.getBoundingClientRect();
      function silhouette(source, poster) {
        const sample = document.createElement("canvas");
        sample.width = Math.round(rect.width);
        sample.height = Math.round(rect.height);
        const context = sample.getContext("2d");
        if (poster) {
          const side = Math.min(sample.width, sample.height);
          context.drawImage(source, (sample.width - side) / 2, (sample.height - side) / 2, side, side);
        } else context.drawImage(source, 0, 0, sample.width, sample.height);
        const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
        let left = sample.width,
          top = sample.height,
          right = -1,
          bottom = -1;
        // Ignore the translucent halo and orbit lines; measure the painted sphere.
        for (let y = 0; y < sample.height; y++) {
          for (let x = 0; x < sample.width; x++) {
            if (pixels[(y * sample.width + x) * 4 + 3] <= 102) continue;
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
        return { width: right - left + 1, height: bottom - top + 1, x: (left + right) / 2, y: (top + bottom) / 2 };
      }
      const labels = [...document.querySelectorAll(".orbit-label")].map((element) => {
        const bounds = element.getBoundingClientRect();
        return { text: element.textContent, left: bounds.left, right: bounds.right };
      });
      return {
        poster: silhouette(image, true),
        painted: silhouette(canvas, false),
        labels,
        width: innerWidth,
        ready: document.querySelector(".globe-canvas").dataset.ready,
      };
    });
    assert.equal(framing.ready, "true");
    assert.ok(framing.painted.width > 100, "The renderer must paint a visible sphere");
    for (const dimension of ["width", "height", "x", "y"])
      assert.ok(
        Math.abs(framing.poster[dimension] - framing.painted[dimension]) <= 4,
        `Globe jumps during loading: ${JSON.stringify(framing)}`,
      );
    assert.equal(framing.labels.length, 2);
    assert.match(framing.labels[0].text, /EXECUTION NETWORK/);
    assert.match(framing.labels[1].text, /AGENTS\s*·\s*EXECUTION\s*·\s*VERIFICATION/);
    for (const label of framing.labels)
      assert.ok(label.left >= 0 && label.right <= framing.width, `Globe caption is clipped: ${JSON.stringify(label)}`);
  }
  check(
    "loading poster and painted canvas sphere retain their size and center; both globe captions fit at desktop, mobile and 320px",
  );
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
      if (theme === "light") await setTheme(page, "light");
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await headerFits(page);
        await featureCardsFit(page);
        if (viewport.height > viewport.width || viewport.width <= 760) {
          const hero = await page.evaluate(() => {
            const topline = document.querySelector(".hero-topline").getBoundingClientRect();
            const copy = document.querySelector(".hero-copy").getBoundingClientRect();
            const globe = document.querySelector(".globe-composition").getBoundingClientRect();
            const cards = document.querySelector(".feature-card").getBoundingClientRect();
            return {
              above: copy.top - topline.bottom,
              below: globe.top - copy.bottom,
              globeHeight: globe.height,
              cardsGap: cards.top - globe.bottom,
            };
          });
          assert.ok(hero.above <= 32, `Hero headline has an excessive top gap: ${JSON.stringify(hero)}`);
          assert.ok(
            hero.below >= 0 && hero.below <= 32,
            `Hero headline has an excessive bottom gap: ${JSON.stringify(hero)}`,
          );
          assert.ok(hero.globeHeight <= 480, `Portrait globe is oversized: ${JSON.stringify(hero)}`);
          assert.ok(
            hero.cardsGap >= 0 && hero.cardsGap <= 180,
            `Cards are pushed below the globe: ${JSON.stringify(hero)}`,
          );
        }
        const layout = await page.evaluate(() => {
          const footer = document.querySelector(".site-footer").getBoundingClientRect();
          const main = document.querySelector("main").getBoundingClientRect();
          const lastSection = document.querySelector(".bottom-cta").getBoundingClientRect();
          return {
            bottom: footer.bottom + scrollY,
            top: footer.top + scrollY,
            mainBottom: main.bottom + scrollY,
            contentBottom: lastSection.bottom + scrollY,
            height: innerHeight,
            pageHeight: document.documentElement.scrollHeight,
          };
        });
        assert.ok(Math.abs(layout.top - layout.contentBottom) <= 1, `Gap above the footer: ${JSON.stringify(layout)}`);
        assert.ok(layout.bottom >= layout.height - 1, `Gap below the footer: ${JSON.stringify(layout)}`);
        assert.ok(
          Math.abs(layout.pageHeight - Math.max(layout.bottom, layout.height)) <= 1,
          `Blank scroll area below the footer: ${JSON.stringify(layout)}`,
        );
        assert.ok(layout.top >= layout.mainBottom - 1, "Footer must not overlap content");
      }
    }
    check(
      "landing footer meets the final section and viewport bottom without an added spacer or extra scroll space across viewport sizes and themes",
    );
    check(
      "portrait layouts, including mobile desktop-site dimensions, retain a compact headline and globe with cards directly below",
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
