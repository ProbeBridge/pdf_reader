import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "playwright";
import { dayKey } from "../sumatrapdf/src/notes/history-model.js";

const assets = resolve("sumatrapdf/src/notes");
const locale = process.env.SUMATRA_TEST_WEB_LOCALE || "zh-CN";
const artifacts = resolve(`.test-artifacts/theme-${locale}`);
await mkdir(artifacts, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const path = resolve(
      assets,
      "." + new URL(request.url, "http://localhost").pathname,
    );
    if (!path.startsWith(assets + sep)) throw new Error("Invalid asset");
    const content = await readFile(path);
    response.writeHead(200, {
      "content-type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[extname(path)] || "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true });
const errors = [];
let dark = false;
let failTheme = false;
const doc = {
  key: "theme-document",
  title: "Theme sample.pdf",
  path: "C:\\docs\\theme.pdf",
};
const store = {
  "page:theme-document": {
    annotations: [
      {
        id: "theme-note",
        quote: "context",
        note: "上下文",
        detail: "在完整原文中理解单词。",
        status: "done",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        thread: [],
        ranges: [{ page: 1, start: 0, end: 7 }],
      },
    ],
  },
};
try {
  const context = await browser.newContext({
    locale,
    colorScheme: "dark",
    viewport: { width: 1000, height: 760 },
  });
  async function broadcast() {
    await Promise.all(
      context
        .pages()
        .filter((page) => page.url().startsWith("http://127.0.0.1:"))
        .map((page) =>
          page.evaluate(
            (dark) =>
              dispatchEvent(
                new CustomEvent("themechange", { detail: { dark } }),
              ),
            dark,
          ),
        ),
    );
  }
  await context.exposeBinding(
    "themeBridge",
    async (_source, channel, params) => {
      const request = JSON.parse(params);
      if (request.action === "theme" || request.action === "toggleTheme") {
        if (failTheme) throw new Error("Theme update failed");
        if (request.action === "toggleTheme") {
          dark = !dark;
          await broadcast();
        }
        return { dark };
      }
      if (request.action === "read") return store;
      if (request.action === "ready")
        return channel === "notes"
          ? { document: doc, selections: [] }
          : { page: 1, pageCount: 1, zoom: 100 };
      if (request.action === "history")
        return [{ ...doc, name: doc.title, opened: Date.now() }];
      if (request.action === "readingStats")
        return {
          "stats:reading:fixture": {
            kind: "reading",
            day: dayKey(Date.now()),
            document: "fixture",
            pages: [1, 2, 2, 3],
            seconds: 125,
            pageCount: 10,
          },
          "stats:words:fixture": {
            kind: "vocabulary",
            day: dayKey(Date.now()),
            ids: ["one", "two", "two"],
          },
        };
      if (request.action === "page")
        return {
          html: "<h2>Theme sample</h2><p>Readable reflow text.</p><table><tr><th>Name</th><th>Value</th></tr><tr><td>Theme</td><td>Dark</td></tr></table>",
          sourceText:
            "Theme sample\nReadable reflow text.\nName\nValue\nTheme\nDark",
        };
      return true;
    },
  );
  await context.addInitScript(() => {
    window.__sumatra__ = {
      call: (channel, params) => window.themeBridge(channel, params),
    };
  });
  const pages = [];
  for (const file of ["index.html", "history.html", "reflow.html"]) {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${file}`);
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
    await page.waitForFunction(
      () => document.documentElement.lang === navigator.language,
    );
    if (file === "reflow.html")
      assert.equal(
        await page.locator("#original").textContent(),
        locale.startsWith("zh") ? "原版" : "Original view",
      );
    assert.equal(
      await page
        .locator(":root")
        .evaluate((root) => getComputedStyle(root).colorScheme),
      "light",
      "app theme overrides a dark OS",
    );
    pages.push(page);
  }
  const [notes, history, reflow] = pages;
  await notes.locator(".card").waitFor();
  await history.locator(".row").waitFor();
  await reflow.locator(".page-content table").waitFor();
  await history.locator("#search").fill("Theme");
  await notes.locator("[data-theme-toggle]").click();
  for (const page of pages) {
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    assert.equal(
      await page.locator("[data-theme-toggle]").getAttribute("aria-pressed"),
      "true",
    );
  }
  await notes.locator("#settings").click();
  await notes.locator("dialog").waitFor({ state: "visible" });
  async function contrast(page, selector) {
    return page
      .locator(selector)
      .first()
      .evaluate((element) => {
        const rgb = (value) =>
          (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const luminance = (color) =>
          rgb(color)
            .map((v) => {
              v /= 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const text = luminance(getComputedStyle(element).color);
        let background;
        for (let node = element; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
            background = luminance(color);
            break;
          }
        }
        return {
          ratio:
            (Math.max(text, background) + 0.05) /
            (Math.min(text, background) + 0.05),
          background,
        };
      });
  }
  for (const [page, selector] of [
    [notes, ".meaning"],
    [notes, "dialog input"],
    [history, ".path"],
    [history, ".file button"],
    [reflow, ".page-content p"],
    [reflow, "td"],
  ]) {
    const result = await contrast(page, selector);
    assert.ok(result.background < 0.1, `${selector} has a dark background`);
    assert.ok(
      result.ratio >= 4.5,
      `${selector} has readable text: ${result.ratio}`,
    );
  }
  for (const [index, page] of pages.entries())
    await page.screenshot({ path: resolve(artifacts, `dark-${index}.png`) });
  await history.reload();
  await history.locator("#statistics").click();
  await history.waitForFunction(
    () => document.querySelector('[data-stat="pages"]').textContent === "3",
  );
  assert.equal(await history.locator('[data-stat="words"]').textContent(), "2");
  assert.equal(
    await history.locator('[data-stat="time"]').textContent(),
    locale.startsWith("zh") ? "2 分钟" : "2m",
  );
  assert.equal(await history.locator(".stats-table tbody tr").count(), 14);
  assert.deepEqual(
    await history
      .locator("#stats-range option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["day", "week", "month", "year"],
  );
  for (const [period, count] of [
    ["day", 14],
    ["week", 12],
    ["month", 12],
    ["year", 5],
  ]) {
    await history.locator("#stats-range").selectOption(period);
    assert.equal(await history.locator(".stats-table tbody tr").count(), count);
    assert.equal(await history.locator(".stats-chart").count(), 1);
    assert.equal(await history.locator(".stats-point").count(), count);
    assert.equal(await history.locator(".stats-legend-item").count(), 3);
    for (const metric of ["pages", "annotations", "seconds"]) {
      const bars = history.locator(
        `.stats-chart .stats-bar[data-metric="${metric}"]`,
      );
      assert.equal(await bars.count(), count);
      assert.equal(
        await bars.evaluateAll((bars) =>
          bars.some((bar) => parseFloat(bar.style.height) > 0),
        ),
        true,
      );
    }
  }
  await history.locator(".stats-point").last().focus();
  assert.match(
    await history.locator(".stats-point-detail").textContent(),
    locale.startsWith("zh")
      ? /阅读页数.*注释数.*阅读时间/
      : /Pages read.*Annotations.*Reading time/,
  );
  assert.ok((await contrast(history, ".stat-card strong")).ratio >= 4.5);
  await history.screenshot({ path: resolve(artifacts, "statistics-dark.png") });
  await history.setViewportSize({ width: 390, height: 844 });
  await history.locator("#stats-range").selectOption("week");
  assert.equal(
    await history.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "statistics fit a narrow window",
  );
  await history.locator("#statistics").click();
  assert.equal(await history.locator("#history-panel").isVisible(), true);
  await history.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await notes.locator("#cancel-settings").click();
  dark = false;
  await broadcast();
  for (const page of pages)
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
  assert.equal(
    await notes.locator(".card").count(),
    1,
    "theme changes retain notes",
  );
  await reflow.locator("[data-theme-toggle]").focus();
  await reflow.keyboard.press("Enter");
  await notes.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  failTheme = true;
  await history.locator("[data-theme-toggle]").click();
  await history.waitForFunction(
    () => !document.querySelector("[data-theme-toggle]").disabled,
  );
  assert.equal(
    await history.locator(":root").getAttribute("data-theme"),
    "dark",
    "failed requests preserve the current theme",
  );
  assert.equal(
    await history.locator("[data-theme-toggle]").getAttribute("title"),
    "Theme update failed",
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${locale} UI; synchronized themes; readable controls; calendar day/week/month/year charts with all three metrics; narrow layout; failure recovery.`,
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
