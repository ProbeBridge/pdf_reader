import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

const root = resolve("sumatrapdf/src/notes");
const actions = [],
  errors = [];
const lines = [
  "Portable speech practice.",
  ...Array.from({ length: 40 }, (_, i) => `Unannotated paragraph ${i}.`),
];
const sourceText = lines.join("\n");
const html = lines.map((text) => `<p>${text}</p>`).join("");
const note = { id: "portable", page: 1, start: 0, end: 8, ipa: "/ˈpɔːrtəbəl/" };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(root + sep)) throw new Error("Invalid path");
    const bytes = await readFile(path);
    res.writeHead(200, {
      "content-type":
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          extname(path)
        ] || "application/octet-stream",
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
    locale: "zh-CN",
  });
  await context.exposeBinding("reflowTest", async (_, data) => {
    const request = JSON.parse(data);
    actions.push(request);
    if (request.action === "ready")
      return {
        page: 1,
        pageCount: 1,
        zoom: 100,
        notes: { click: false, highlights: [note] },
      };
    if (request.action === "page") return { html, sourceText };
    return true;
  });
  await context.addInitScript(() => {
    window.__sumatra__ = { call: (_, data) => window.reflowTest(data) };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/reflow.html`);
  await page.locator(".note-ink").waitFor();
  const word = async () =>
    page
      .locator(".page-content p")
      .first()
      .evaluate((p) => {
        const range = document.createRange();
        range.setStart(p.firstChild, 0);
        range.setEnd(p.firstChild, 8);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
  const popup = page.locator("#note-actions"),
    play = page.locator("#speak-note");
  const hover = async () => {
    const at = await word();
    await page.mouse.move(at.x + 1, at.y + 1);
    await page.mouse.move(at.x, at.y);
    await popup.waitFor({ state: "visible" });
    return at;
  };
  const at = await hover();
  assert.equal(await page.locator("#note-ipa").textContent(), note.ipa);
  assert.equal(await play.locator("svg").count(), 1);
  assert.equal(
    actions.filter((a) => a.action === "focus").length,
    0,
    "hover must not move sidebar focus",
  );
  assert.equal(
    actions.filter((a) => a.action === "speak").length,
    0,
    "hover must not play",
  );
  const initial = await popup.boundingBox();
  await page.mouse.move(at.x + 2, at.y + 1);
  assert.deepEqual(
    await popup.boundingBox(),
    initial,
    "same-note hover must keep toolbar still",
  );
  const button = await play.boundingBox();
  await page.mouse.move(
    button.x + button.width / 2,
    button.y + button.height / 2,
    { steps: 8 },
  );
  await popup.waitFor({ state: "visible" });
  await play.click();
  await page.waitForFunction(() => true);
  assert.deepEqual(
    actions.filter((a) => a.action === "speak"),
    [{ action: "speak", id: "portable" }],
  );
  await play.click();
  assert.equal(
    actions.filter((a) => a.action === "speak").length,
    2,
    "manual replay must be repeatable",
  );
  await page.locator("#focus-note").click();
  assert.deepEqual(
    actions.filter((a) => a.action === "focus"),
    [{ action: "focus", id: "portable" }],
  );
  await page.mouse.move(950, 650);
  await popup.waitFor({ state: "hidden" });
  await hover();
  await page.keyboard.press("Escape");
  await popup.waitFor({ state: "hidden" });
  await page.mouse.move(950, 650);
  await hover();
  await page.mouse.wheel(0, 350);
  await popup.waitFor({ state: "hidden" });
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForFunction(() => scrollY === 0);
  await hover();
  await page.locator("#delete-note").click();
  await popup.waitFor({ state: "hidden" });
  assert.deepEqual(
    actions.filter((a) => a.action === "delete"),
    [{ action: "delete", id: "portable" }],
  );
  await page.mouse.move(950, 650);
  await hover();
  await page.evaluate(() =>
    dispatchEvent(
      new CustomEvent("reflowstate", {
        detail: { click: false, highlights: [] },
      }),
    ),
  );
  await popup.waitFor({ state: "hidden" });
  assert.equal(actions.filter((a) => a.action === "speak").length, 2);
  assert.deepEqual(errors, []);
  console.log(
    "PASS reflow hover toolbar, stable pointer travel, replay, focus, delete and dismissal",
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
