import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const root = resolve("sumatrapdf/src/notes"),
  artifacts = resolve(".test-artifacts/reflow");
const urlText =
  "https://example.test/" + "verylongtablecellwithoutspaces".repeat(15);
const paragraph =
  "An 😀 example of cooperation demonstrates semantic reflow. " +
  "This paragraph changes its line wrapping when the font size or available width changes. ".repeat(
    5,
  );
const sourceText = `Heading\n${paragraph}\nName\nValue\nAlpha\n${urlText}\nRepeated word here.\nRepeated word there.\n`;
const word = "cooperation",
  start = Array.from(sourceText.slice(0, sourceText.indexOf(word))).length;
const bitTable = `<h3>Register grid</h3><table><tr>${Array.from({ length: 32 }, (_, i) => `<th>${31 - i}</th>`).join("")}</tr><tr>${Array.from({ length: 32 }, (_, i) => `<td>${i % 2}</td>`).join("")}</tr></table>`;
const html = `<div id="page1"><h2>Heading</h2><p>${paragraph.replace("cooperation", "co<b>oper</b>ation")}</p><table style="width:99999px"><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td colspan="2">${urlText}</td></tr></table><p><img width="500" height="250" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCuoAAAAASUVORK5CYII=" /></p><p>Repeated word here.</p><p>Repeated word there.</p>${bitTable}<script>window.pdfScriptExecuted=true</script><img src="https://forbidden.test/image.png" onerror="window.pdfScriptExecuted=true"><a href="https://forbidden.test/">Unsafe link</a><iframe src="https://forbidden.test/"></iframe></div>`;
const annotations = [],
  actions = [],
  requests = [],
  errors = [];
let activePages = 0,
  maxActivePages = 0,
  annotationReceived;
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(root)) throw new Error("Invalid path");
    const data = await readFile(path);
    res.writeHead(200, {
      "content-type":
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          extname(path)
        ] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`,
  browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
    locale: "zh-CN",
  });
  context.on("request", (r) => requests.push(r.url()));
  await context.exposeBinding("testReflow", async (_source, data) => {
    const message = JSON.parse(data);
    actions.push(message);
    if (message.action === "ready")
      return {
        page: 1,
        pageCount: 1982,
        zoom: 100,
        notes: {
          click: true,
          highlights: [
            {
              id: "existing",
              page: 1,
              start,
              end: start + word.length,
              ipa: "/kəʊˌɒpəˈreɪʃən/",
            },
          ],
        },
      };
    if (message.action === "page") {
      activePages++;
      maxActivePages = Math.max(activePages, maxActivePages);
      try {
        await new Promise((resolve) =>
          setTimeout(resolve, message.page >= 10 ? 100 : 5),
        );
        return message.page === 1
          ? { html, sourceText }
          : {
              html: `<p>Source page ${message.page} has text.</p>`,
              sourceText: `Source page ${message.page} has text.`,
            };
      } finally {
        activePages--;
      }
    }
    if (message.action === "annotate") {
      annotations.push(message);
      annotationReceived?.(message);
    }
    return true;
  });
  await context.addInitScript(() => {
    window.__sumatra__ = {
      call: (name, data) => {
        if (name !== "reflow") throw new Error("Unexpected native bridge");
        return window.testReflow(data);
      },
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/reflow.html");
  await page.locator('.source-page[data-page="1"] table').first().waitFor();
  assert.equal(await page.locator("table").first().locator("tr").count(), 2);
  assert.equal(
    await page.locator("table").first().locator("[colspan='2']").count(),
    1,
  );
  assert.equal(
    await page
      .locator(
        ".page-content script,.page-content iframe,.page-content a,.page-content [onerror]",
      )
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.pdfScriptExecuted), undefined);
  assert.equal(
    requests.filter((url) => url.startsWith("https://forbidden.test")).length,
    0,
  );
  assert.ok(
    actions.filter((a) => a.action === "page").length <= 5,
    "startup must only request a bounded page window",
  );
  const before = await page
    .locator('.source-page[data-page="1"] p')
    .first()
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      font: parseFloat(getComputedStyle(element).fontSize),
      image: element
        .closest(".page-content")
        .querySelector("img")
        .getBoundingClientRect().width,
    }));
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({
    path: resolve(artifacts, "reflow-first-page.png"),
    fullPage: true,
  });
  await page.evaluate(() =>
    dispatchEvent(new CustomEvent("reflowzoom", { detail: { zoom: 400 } })),
  );
  for (const width of [1000, 420]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const layout = await page.evaluate(() => {
      const content = document.querySelector(
          '.source-page[data-page="1"] .page-content',
        ),
        p = content.querySelector("p"),
        image = content.querySelector("img"),
        table = content.querySelector("table");
      return {
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        content: content.getBoundingClientRect().width,
        table: table.getBoundingClientRect().width,
        image: image.getBoundingClientRect().width,
        paragraph: p.getBoundingClientRect().height,
        font: parseFloat(getComputedStyle(p).fontSize),
        marks: [...content.querySelectorAll(".note-ink")].map((mark) => ({
          height: mark.getBoundingClientRect().height,
          max: parseFloat(
            getComputedStyle(mark.parentElement.parentElement).fontSize,
          ),
        })),
        bitGrid: {
          font: getComputedStyle(content.querySelectorAll("table")[1]).fontSize,
          width: content.querySelectorAll("table")[1].getBoundingClientRect()
            .width,
          cells: [
            ...content.querySelectorAll("table")[1].querySelectorAll("th,td"),
          ].map((cell) => ({
            scroll: cell.scrollWidth,
            client: cell.clientWidth,
          })),
        },
      };
    });
    assert.ok(layout.document <= layout.viewport + 1, JSON.stringify(layout));
    assert.ok(
      layout.bitGrid.width <= layout.content + 1,
      "32-column grid must fit the content width",
    );
    assert.ok(
      layout.bitGrid.cells.every((cell) => cell.scroll <= cell.client + 1),
      `32-column cell glyphs must fit without clipping or overlapping adjacent cells: ${JSON.stringify(layout.bitGrid)}`,
    );
    assert.ok(
      layout.image <= layout.content + 1,
      "zoomed image must fit available content width",
    );
    if (width === 1000)
      assert.ok(
        layout.image > before.image,
        "images must enlarge with the content zoom before reaching the width cap",
      );
    assert.ok(
      layout.table <= layout.content + 1,
      "table must wrap within available content width",
    );
    assert.ok(
      layout.paragraph > before.height * 2,
      "font zoom must rewrap actual text",
    );
    assert.equal(layout.font, before.font * 4);
    assert.ok(
      layout.marks.length >= 1,
      "source notes must be highlighted in reflow",
    );
    assert.ok(
      layout.marks.every((mark) => mark.height <= layout.font),
      "highlight backgrounds must not exceed character height",
    );
    if (width === 420)
      await page.screenshot({
        path: resolve(artifacts, "reflow-400-narrow.png"),
        fullPage: true,
      });
  }
  await page.evaluate(() =>
    dispatchEvent(new CustomEvent("reflowzoom", { detail: { zoom: 100 } })),
  );
  await page.setViewportSize({ width: 1000, height: 800 });
  // Select across inline formatting after a non-BMP character: DOM UTF-16
  // offsets must become the original PDF's codepoint indices.
  await page.evaluate(() => {
    const p = document.querySelector(
        '.source-page[data-page="1"] .page-content p',
      ),
      range = document.createRange();
    range.setStart(p.firstChild, p.firstChild.data.indexOf("co"));
    const last = p.querySelector("b").nextSibling;
    range.setEnd(last, "ation".length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator("#annotate").click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "",
  );
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].quote, word);
  assert.deepEqual(JSON.parse(annotations[0].ranges), [
    { page: 1, start, end: start + word.length },
  ]);
  await page.evaluate(() => {
    const p = [
      ...document.querySelectorAll(
        '.source-page[data-page="1"] .page-content p',
      ),
    ].find((p) => p.textContent === "Repeated word there.");
    const range = document.createRange();
    range.setStart(p.firstChild, 9);
    range.setEnd(p.firstChild, 13);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator("#annotate").click();
  assert.equal(annotations.length, 2);
  const repeated = Array.from(
    sourceText.slice(0, sourceText.lastIndexOf("word")),
  ).length;
  assert.deepEqual(JSON.parse(annotations[1].ranges), [
    { page: 1, start: repeated, end: repeated + 4 },
  ]);
  await page.evaluate(() => {
    const section = document.querySelector('.source-page[data-page="1"]'),
      range = document.createRange();
    range.setStart(section.querySelector(".page-number").firstChild, 0);
    range.setEnd(section.querySelector(".page-content p").firstChild, 2);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator("#annotate").click();
  assert.equal(
    annotations[2].quote,
    "Heading\nAn",
    "generated page labels must never enter a note quote",
  );
  assert.ok(!annotations[2].quote.includes("原文"));
  const ambiguous = await page.evaluate(async () => {
    const { SourcePage, safeReflowContent } = await import("/reflow-model.js"),
      root = document.createElement("div");
    root.append(
      safeReflowContent(
        "<table><tr><td>Name</td><td>Value</td></tr><tr><td>Alpha</td><td>1</td></tr><tr><td>Alpha</td><td>2</td></tr></table>",
      ),
    );
    const model = new SourcePage(root, 1, "Name\nAlpha\nAlpha\nValue\n1\n2\n"),
      range = document.createRange();
    range.selectNodeContents(root.querySelectorAll("tr")[2].firstChild);
    try {
      return model.selection(range);
    } catch (e) {
      return { error: e.message };
    }
  });
  assert.match(
    ambiguous.error,
    /原版|original/,
    "ambiguous reordered table cells must not silently anchor another occurrence",
  );
  const blankMapping = await page.evaluate(async () => {
    const { SourcePage, safeReflowContent } = await import("/reflow-model.js");
    const source = "0x0040\uFFFDE902\uFFFDTimestamp Test\nMissing: \uFFFD\n";
    const display = "0x0040 E902 Timestamp Test\nMissing: \uFFFD\n";
    const root = document.createElement("div");
    root.append(
      safeReflowContent(
        "<p>0x0040 E902 Timestamp Test</p><p>Missing: &#xfffd;</p>",
      ),
    );
    const model = new SourcePage(root, 337, source, display);
    const node = root.querySelector("p").firstChild,
      range = document.createRange(),
      start = node.data.indexOf("Timestamp");
    range.setStart(node, start);
    range.setEnd(node, start + "Timestamp".length);
    return {
      ranges: model.selection(range),
      raw: model.sourceText,
      display: model.displayText,
    };
  });
  assert.deepEqual(
    blankMapping.ranges,
    [{ page: 337, start: 12, end: 21 }],
    "geometry-confirmed blank substitutions must preserve original source glyph indices",
  );
  assert.match(blankMapping.raw, /\uFFFD/);
  assert.equal(
    blankMapping.display,
    "0x0040 E902 Timestamp Test\nMissing: \uFFFD\n",
    "a real missing glyph must remain visible as replacement text",
  );
  await page.evaluate(() => getSelection().removeAllRanges());
  const mark = await page.locator(".note-ink").first().boundingBox();
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await page.locator("#note-actions").waitFor();
  await page.locator("#delete-note").click();
  assert.ok(actions.some((a) => a.action === "focus" && a.id === "existing"));
  assert.ok(actions.some((a) => a.action === "delete" && a.id === "existing"));
  await page.locator("#next").click();
  await page.locator('.source-page[data-page="2"]').waitFor();
  assert.ok(
    actions.some((a) => a.action === "position" && a.page === 2),
    "reflow page navigation must update the original controller page",
  );
  await page.evaluate(() =>
    dispatchEvent(new CustomEvent("reflownavigate", { detail: { page: 3 } })),
  );
  await page.locator('.source-page[data-page="4"]').waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator('.source-page[data-page="1"]').waitFor();
  const order = await page
    .locator(".source-page")
    .evaluateAll((elements) =>
      elements.map((element) => Number(element.dataset.page)),
    );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "previous pages must insert in source order rather than Map request order",
  );
  await page.evaluate(() => {
    for (let page = 10; page <= 39; page++)
      dispatchEvent(new CustomEvent("reflownavigate", { detail: { page } }));
  });
  await page.locator('.source-page[data-page="39"]').waitFor();
  await page.locator('.source-page[data-page="40"]').waitFor();
  assert.ok(
    maxActivePages <= 3,
    "superseded epochs must preserve native worker backpressure",
  );
  assert.ok((await page.locator(".source-page").count()) <= 5);
  assert.equal(await page.locator('.source-page[data-page="10"]').count(), 0);
  assert.equal(await page.locator("#status").textContent(), "");
  await page.locator('.source-page[data-page="39"] p').scrollIntoViewIfNeeded();
  const autoClick = await page
    .locator('.source-page[data-page="39"] p')
    .evaluate((element) => {
      const range = document.createRange(),
        offset = element.firstChild.data.indexOf("has");
      range.setStart(element.firstChild, offset);
      range.setEnd(element.firstChild, offset + 3);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
  let deadline;
  try {
    const annotated = new Promise((resolve) => {
      annotationReceived = resolve;
    });
    await page.mouse.click(autoClick.x, autoClick.y);
    const result = await Promise.race([
      annotated,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                `single-word annotation did not fire: ${JSON.stringify({ errors, actions: actions.slice(-8) })}`,
              ),
            ),
          2500,
        );
      }),
    ]);
    assert.equal(result.quote, "has");
    assert.deepEqual(JSON.parse(result.ranges), [
      { page: 39, start: 15, end: 18 },
    ]);
  } finally {
    clearTimeout(deadline);
    annotationReceived = undefined;
  }
  await page.evaluate(() => {
    getSelection().removeAllRanges();
    dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: -100,
        cancelable: true,
      }),
    );
  });
  assert.ok(
    actions.some((a) => a.action === "zoom" && a.zoom > 100),
    "Ctrl+wheel must change content zoom",
  );
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({
    path: resolve(artifacts, "reflow.png"),
    fullPage: true,
  });
  await page.locator("#original").click();
  assert.ok(actions.some((a) => a.action === "close"));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: semantic tables/images, true text reflow at 100–400%, no horizontal overflow, glyph anchors/UTF-16/repeated text, character-height highlights, bounded lazy pages, CSP/sanitization, zoom/original bridge.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
