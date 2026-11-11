import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
const root = resolve("sumatrapdf/src/notes");
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
      ".mjs": "text/javascript",
      ".json": "application/json",
      ".wasm": "application/wasm",
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
try {
  const context = await browser.newContext();
  const external = [];
  await context.route("**/*", (route) => {
    if (route.request().url().startsWith(base)) route.continue();
    else {
      external.push(route.request().url());
      route.abort();
    }
  });
  const page = await context.newPage();
  await page.goto(base + "/history.html");
  const result = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker("/shared/tts-worker.js", { type: "module" });
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("Offline TTS timed out"));
        }, 90000);
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message));
        };
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          worker.terminate();
          if (data.error) reject(new Error(data.error));
          else
            resolve({
              samples: data.audio.length,
              rate: data.rate,
              amplitude: Math.max(
                ...data.audio.subarray(0, 20000).map(Math.abs),
              ),
            });
        };
        worker.postMessage({
          id: 1,
          text: "context",
          voice: "af_bella",
          speed: 0.8,
        });
      }),
  );
  assert.ok(result.samples > 1000 && result.rate > 0 && result.amplitude > 0);
  assert.deepEqual(external, []);
  console.log(
    `PASS: offline Kokoro Bella synthesis (${result.samples} samples at ${result.rate} Hz); no external requests.`,
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
