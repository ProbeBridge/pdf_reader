import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const root = resolve("sumatrapdf/src/notes"),
  server = createServer(async (req, res) => {
    try {
      const path = resolve(
        root,
        "." + new URL(req.url, "http://localhost").pathname,
      );
      if (!path.startsWith(root)) throw Error();
      res.writeHead(200, {
        "content-type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(path)] || "application/octet-stream",
      });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`,
  browser = await chromium.launch({ headless: true });
const paragraph = Array.from(
  { length: 500 },
  (_, i) => `Word${i} describes reliable paragraph reflow.`,
).join(" ");
const previous = `<table>${Array.from({ length: 100 }, (_, i) => `<tr><td>Previous row ${i}</td><td>Long table cell ${i} has wrapping text that changes its height when zooming.</td></tr>`).join("")}</table>`;
try {
  const context = await browser.newContext({
    viewport: { width: 900, height: 700 },
  });
  await context.exposeBinding("nativeAnchor", async (_source, data) => {
    const request = JSON.parse(data);
    if (request.action === "ready")
      return {
        page: 2,
        pageCount: 3,
        zoom: 100,
        notes: { click: false, highlights: [] },
      };
    if (request.action === "page")
      return request.page === 1
        ? { html: previous, sourceText: "Previous table." }
        : request.page === 2
          ? {
              html: `${_source.page.url().includes("image-leading") ? '<p><img width="440" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCuoAAAAASUVORK5CYII=" /></p>' : ""}<p>STARTTOKEN follows the previous long table.</p><p>${paragraph}</p>`,
              sourceText: `STARTTOKEN follows the previous long table.\n${paragraph}`,
            }
          : { html: "<p>End page.</p>", sourceText: "End page." };
    return true;
  });
  await context.addInitScript(() => {
    window.__sumatra__ = { call: (_name, data) => window.nativeAnchor(data) };
  });
  const results = [];
  for (const mode of ["previous-table-tail", "paragraph-middle"]) {
    const page = await context.newPage();
    await page.goto(base + "/reflow.html");
    await page.locator('.source-page[data-page="1"] table').waitFor();
    await page.locator('.source-page[data-page="3"]').waitFor();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const before = await page.evaluate((mode) => {
      const section = document.querySelector('.source-page[data-page="2"]'),
        node =
          section.querySelectorAll("p")[mode === "previous-table-tail" ? 0 : 1]
            .firstChild;
      const offset =
        mode === "previous-table-tail" ? 0 : node.data.indexOf("Word250");
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + (mode === "previous-table-tail" ? 10 : 7));
      window.readingRange = range;
      const wanted = mode === "previous-table-tail" ? 180 : 120;
      scrollBy(0, range.getBoundingClientRect().top - wanted);
      return range.getBoundingClientRect().top;
    }, mode);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent("reflowzoom", { detail: { zoom: 110 } })),
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const after = await page.evaluate(() => ({
      top: window.readingRange.getBoundingClientRect().top,
      label: document.querySelector("#page-label").textContent,
      text: window.readingRange.toString(),
      lineHeight: parseFloat(
        getComputedStyle(window.readingRange.startContainer.parentElement)
          .lineHeight,
      ),
    }));
    results.push({ mode, before, ...after });
    assert.ok(
      // A nearby word may wrap onto an adjacent line while the visible anchor stays fixed.
      Math.abs(after.top - before) <= Math.max(24, after.lineHeight * 1.5),
      `zoom must retain the visible source text, including after a long previous table: ${JSON.stringify(results.at(-1))}`,
    );
    await page.close();
  }
  const imagePage = await context.newPage();
  await imagePage.goto(base + "/reflow.html?image-leading");
  await imagePage.locator('.source-page[data-page="1"] table').waitFor();
  await imagePage.locator('.source-page[data-page="3"]').waitFor();
  await imagePage.waitForFunction(
    () => document.querySelector('.source-page[data-page="2"] img')?.complete,
  );
  await imagePage.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const imageBefore = await imagePage.evaluate(() => {
    const section = document.querySelector('.source-page[data-page="2"]'),
      image = section.querySelector("img");
    scrollBy(0, section.getBoundingClientRect().top - 70);
    const before = image.getBoundingClientRect().top;
    dispatchEvent(new CustomEvent("reflowzoom", { detail: { zoom: 200 } }));
    return before;
  });
  await imagePage.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const imageAfter = await imagePage
    .locator('.source-page[data-page="2"] img')
    .evaluate((image) => image.getBoundingClientRect().top);
  assert.ok(
    Math.abs(imageAfter - imageBefore) <= 16,
    `image-led current page must take priority over a previous-page footer glyph: ${imageBefore} -> ${imageAfter}`,
  );
  results.push({
    mode: "image-leading-200",
    before: imageBefore,
    top: imageAfter,
  });
  await imagePage.close();
  console.log(
    `PASS: visible glyph anchoring during zoom: ${JSON.stringify(results)}`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
