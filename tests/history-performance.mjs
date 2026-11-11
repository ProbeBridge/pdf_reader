import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const root = resolve("sumatrapdf/src/notes"),
  output =
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
    ".test-artifacts/history-profile.json";
const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(root)) throw new Error("Invalid path");
    const content = await readFile(path);
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".css": "text/css",
    };
    res.writeHead(200, {
      "content-type": mime[extname(path)] || "application/octet-stream",
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let entries = [],
  historyCalls = 0,
  reads = 0;
const traffic = [],
  workers = [],
  result = {};
try {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
  });
  context.on("request", (r) => traffic.push(r.url()));
  context.on("page", (p) => p.on("worker", (w) => workers.push(w.url())));
  await context.exposeBinding("testNative", async (_source, message) => {
    if (message.action === "history") {
      historyCalls++;
      return entries;
    }
    if (message.action === "read") {
      reads++;
      return {};
    }
    if (message.action === "ready") return { document: {} };
    return true;
  });
  await context.addInitScript(() => {
    window.profile = [];
    window.profileStart = 0;
    window.pendingNative = new Set();
    window.__sumatra__ = {
      call: (_name, data) => {
        const message = JSON.parse(data);
        if (message.action === "history")
          window.profileStart = performance.now();
        const pending = window.testNative(message);
        window.pendingNative.add(pending);
        pending.finally(() => window.pendingNative.delete(pending));
        return pending;
      },
    };
    addEventListener("DOMContentLoaded", () => {
      const groups = document.querySelector("#groups");
      if (!groups) return;
      new MutationObserver(() => {
        groups.getBoundingClientRect();
        if (window.profileStart)
          window.profile.push({
            ms: performance.now() - window.profileStart,
            rows: groups.querySelectorAll(".row").length,
          });
      }).observe(groups, { childList: true, subtree: true });
    });
  });
  const page = await context.newPage();
  for (const scenario of ["dated", "undated"]) {
    entries = Array.from({ length: 1000 }, (_, i) => ({
      name: `doc-${String(i).padStart(4, "0")}.pdf`,
      path: `C:\\books\\doc-${String(i).padStart(4, "0")}.pdf`,
      opened: scenario === "dated" ? Date.now() - i * 300000 : 0,
    }));
    await page.goto(base + "/history.html");
    await page.waitForFunction(() => window.profile.length > 0);
    const startup = await page.evaluate(() => window.profile.at(-1));
    const searches = [];
    for (const query of ["doc-", "doc-0999", ""]) {
      const n = await page.evaluate(() => window.profile.length);
      await page.evaluate((query) => {
        window.profileStart = performance.now();
        const input = document.querySelector("#search");
        input.value = query;
        input.dispatchEvent(new Event("input"));
      }, query);
      await page.waitForFunction((n) => window.profile.length > n, n);
      searches.push(await page.evaluate(() => window.profile.at(-1)));
    }
    const before = historyCalls;
    const hidden = await page.evaluate(async () => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      const start = performance.now(),
        before = window.profile.length;
      for (let i = 0; i < 5; i++) dispatchEvent(new Event("historychange"));
      while (window.pendingNative.size) await Promise.all(window.pendingNative);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        elapsedMs: performance.now() - start,
        renders: window.profile.length - before,
      };
    });
    const hiddenCalls = historyCalls - before;
    entries = entries.map((entry, i) =>
      i === 0 ? { ...entry, name: `fresh-${scenario}.pdf` } : entry,
    );
    const visibleStart = Date.now();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.evaluate(async () => {
      while (window.pendingNative.size) await Promise.all(window.pendingNative);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    assert.equal(
      await page
        .getByRole("button", { name: `fresh-${scenario}.pdf`, exact: true })
        .count(),
      1,
    );
    const restoredCalls = historyCalls - before - hiddenCalls;
    const visibleMs = Date.now() - visibleStart;
    const beforeBurst = historyCalls;
    const visibleBurst = await page.evaluate(async () => {
      const before = window.profile.length;
      for (let i = 0; i < 5; i++) dispatchEvent(new Event("historychange"));
      await Promise.resolve();
      while (window.pendingNative.size) await Promise.all(window.pendingNative);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { renders: window.profile.length - before };
    });
    result[scenario] = {
      startup,
      searches,
      hidden: { ...hidden, nativeHistoryCalls: hiddenCalls },
      visible: {
        elapsedMs: visibleMs,
        nativeHistoryCalls: restoredCalls,
      },
      visibleBurst: {
        ...visibleBurst,
        nativeHistoryCalls: historyCalls - beforeBurst,
      },
    };
  }
  const hiddenPage = await context.newPage();
  await hiddenPage.addInitScript(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
  });
  const beforeHiddenStartup = historyCalls;
  await hiddenPage.goto(base + "/history.html");
  result.hiddenStartup = {
    nativeHistoryCalls: historyCalls - beforeHiddenStartup,
    rows: await hiddenPage.locator(".row").count(),
  };
  assert.equal(result.hiddenStartup.nativeHistoryCalls, 0);
  assert.equal(result.hiddenStartup.rows, 0);
  await hiddenPage.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await hiddenPage.waitForFunction(
    () => document.querySelectorAll(".row").length === 1000,
  );
  assert.equal(historyCalls - beforeHiddenStartup, 1);
  await hiddenPage.close();
  const beforeReads = reads;
  await page.goto(base + "/index.html");
  await page.locator("#status").filter({ hasText: "0 条注释" }).waitFor();
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    await page.evaluate(
      (i) =>
        dispatchEvent(
          new CustomEvent("documentchange", {
            detail: {
              key: `doc-${i}`,
              path: `C:\\books\\doc-${i}.pdf`,
              title: `doc-${i}.pdf`,
            },
          }),
        ),
      i,
    );
    await page
      .locator("#doc-title")
      .filter({ hasText: `doc-${i}.pdf` })
      .waitFor();
  }
  result.notes = {
    documentChanges: 20,
    wallMs: Date.now() - start,
    storeReads: reads - beforeReads,
    workers: workers.length,
    modelRequests: traffic.filter((url) =>
      /vendor\/kokoro|\.onnx|tts-worker\.js|\.wasm/.test(url),
    ).length,
  };
  assert.equal(result.notes.workers, 0);
  assert.equal(result.notes.modelRequests, 0);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (process.argv.includes("--check")) {
    for (const scenario of ["dated", "undated"]) {
      assert.equal(
        result[scenario].hidden.nativeHistoryCalls,
        0,
        "hidden history must defer native reads",
      );
      assert.equal(
        result[scenario].hidden.renders,
        0,
        "hidden history must defer DOM rendering",
      );
      assert.equal(
        result[scenario].visible.nativeHistoryCalls,
        1,
        "showing history must refresh once",
      );
      assert.equal(
        result[scenario].visibleBurst.nativeHistoryCalls,
        1,
        "history event bursts must share one native read",
      );
      assert.equal(
        result[scenario].visibleBurst.renders,
        1,
        "history event bursts must render once",
      );
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
