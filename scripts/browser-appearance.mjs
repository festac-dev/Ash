import { expect } from "@playwright/test";

export async function setTheme(page, theme) {
  if ((await page.locator("html").getAttribute("data-theme")) !== theme)
    await page.getByRole("button", { name: `Switch to ${theme} theme`, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}
