import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "playwright";
import {
  libraryKey,
  libraryEntries,
} from "../sumatrapdf/src/notes/library-model.js";

assert.equal(
  libraryKey("C:\\Books\\Book.pdf", true),
  libraryKey("c:/books/book.pdf", true),
);
assert.notEqual(
  libraryKey("/Books/Book.pdf", false),
  libraryKey("/Books/book.pdf", false),
);
assert.deepEqual(libraryEntries([null, { key: "settings", book: {} }]), []);
const assets = resolve("sumatrapdf/src/notes"),
  output = resolve(".test-artifacts/library");
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const path = resolve(
      assets,
      "." + new URL(request.url, "http://localhost").pathname,
    );
    if (!path.startsWith(assets + sep)) throw new Error("Invalid asset");
    response.writeHead(200, {
      "content-type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
        }[extname(path)] || "application/octet-stream",
    });
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true });
try {
  for (const locale of ["zh-CN", "en-US"]) {
    const context = await browser.newContext({
        locale,
        viewport: { width: 1100, height: 820 },
      }),
      store = {},
      calls = [],
      errors = [];
    let shared = [],
      picked = [],
      libraryCalls = 0;
    const documents = [
      { name: "History.pdf", path: "C:\\History.pdf", opened: Date.now() },
    ];
    await context.exposeBinding("libraryTest", async (_, message) => {
      calls.push(message);
      switch (message.action) {
        case "theme":
          return { dark: false };
        case "history":
          return documents;
        case "read":
          return store;
        case "libraryCover":
          return {
            image:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          };
        case "library":
          libraryCalls++;
          return [
            ...shared,
            ...Object.entries(store)
              .filter(([key]) => key.startsWith("library:"))
              .map(([key, book]) => ({
                key,
                book,
                missing: book.path.includes("missing"),
              })),
          ];
        case "libraryPicker":
          return picked;
        case "write":
          if (
            message.expected !== undefined &&
            message.expected !== JSON.stringify(store[message.key] ?? null)
          )
            return { conflict: true };
          store[message.key] = JSON.parse(message.value);
          return true;
        case "remove":
          delete store[message.key];
          return true;
        case "open":
          if (message.path.includes("missing"))
            throw new Error("File is unavailable");
          return true;
        default:
          return true;
      }
    });
    await context.addInitScript(() => {
      window.__sumatra__ = {
        call: (_, json) => window.libraryTest(JSON.parse(json)),
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/history.html`);
    await page.locator(".row").waitFor();
    assert.equal(libraryCalls, 0, "library does not slow down history startup");
    assert.equal(
      calls.filter((call) => call.action === "libraryCover").length,
      0,
      "history startup never renders library covers",
    );
    await page.locator("#library").click();
    await page.locator("#library-empty").waitFor({ state: "visible" });
    picked = [
      { name: "芯片 <book>.pdf", path: "C:\\Books\\芯片 <book>.pdf" },
      { name: "Novel.epub", path: "C:\\Books\\Novel.epub" },
    ];
    await page.locator("#add-books").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".book-card").length === 2,
    );
    assert.equal(
      await page.locator("#books book").count(),
      0,
      "names remain literal text",
    );
    await page.locator("#add-books").click();
    await page.waitForFunction(
      () => !document.querySelector("#add-books").disabled,
    );
    assert.equal(
      Object.keys(store).length,
      2,
      "adding the same books is idempotent",
    );
    await page.locator("#search").fill("Novel Books");
    assert.equal(await page.locator(".book-card").count(), 1);
    await page.locator(".book-title").click();
    assert.equal(calls.at(-1).path, picked[1].path);
    const writes = calls.filter((call) => call.action === "write").length;
    picked = [];
    await page.locator("#add-books").click();
    await page.waitForFunction(
      () => !document.querySelector("#add-books").disabled,
    );
    assert.equal(
      calls.filter((call) => call.action === "write").length,
      writes,
      "cancelling the picker does not write",
    );
    await page.locator(".book-remove").click();
    await page.locator("#toast button").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".book-card").length === 1,
    );
    await page.reload();
    await page.locator("#library").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".book-card").length === 2,
    );
    picked = [{ name: "Missing.pdf", path: "C:\\missing.pdf" }];
    await page.locator("#add-books").click();
    await page.locator(".book-status:not([hidden])").waitFor();
    await page
      .locator(".book-card")
      .filter({ has: page.locator(".book-status:not([hidden])") })
      .locator(".book-title")
      .click();
    await page
      .locator("#toast")
      .filter({ hasText: "File is unavailable" })
      .waitFor();
    shared = [
      {
        key: "library:/Users/Shared/Shared.pdf",
        book: {
          path: "/Users/Shared/Shared.pdf",
          name: "Shared.pdf",
          addedAt: Date.now(),
        },
        shared: true,
        missing: false,
      },
    ];
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("storechange", { detail: { "library:shared": {} } }),
      ),
    );
    await page.locator(".book-shared").waitFor();
    const sharedCard = page
      .locator(".book-card")
      .filter({ has: page.locator(".book-shared") });
    assert.equal(await sharedCard.locator(".book-remove").count(), 0);
    await sharedCard.locator(".book-title").click();
    assert.equal(calls.at(-1).path, shared[0].book.path);
    await sharedCard.locator(".book-cover img").waitFor();
    await page.locator("#library-view-list").click({ timeout: 1000 });
    await page.waitForFunction(
      () => document.querySelector("#books").dataset.view === "list",
    );
    assert.equal(
      await page.locator("#library-view-list").getAttribute("aria-pressed"),
      "true",
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".book-cover img")].some(
        (img) => img.complete && img.naturalWidth > 0,
      ),
    );
    await page.screenshot({
      path: resolve(output, `library-list-${locale}.png`),
    });
    await page.reload();
    await page.locator("#library").click();
    await page.waitForFunction(
      () => document.querySelector("#books").dataset.view === "list",
    );
    await page.locator("#library-view-grid").click();
    await page.waitForFunction(
      () => document.querySelector("#books").dataset.view === "grid",
    );
    await page.screenshot({ path: resolve(output, `library-${locale}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: resolve(output, `library-narrow-${locale}.png`),
    });
    await page.locator("#library-view-list").click();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: resolve(output, `library-list-dark-narrow-${locale}.png`),
    });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "PASS: library add/search/open/undo, shared entries, lazy covers, grid/list persistence and narrow layouts in Chinese and English.",
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
