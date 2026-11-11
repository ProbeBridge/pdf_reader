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
const requests = [],
  cancelled = new Set(),
  timers = new Set(),
  external = [],
  errors = [];
const later = (fn, ms = 0) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    Promise.resolve()
      .then(fn)
      .catch(() => {});
  }, ms);
  timers.add(timer);
};
try {
  const context = await browser.newContext({ locale: "en-US" });
  await context.route("**/*", (route) => {
    if (route.request().url().startsWith(base)) route.continue();
    else {
      external.push(route.request().url());
      route.abort();
    }
  });
  await context.exposeBinding("testNative", async ({ page }, message) => {
    const emit = (detail) =>
      page.evaluate(
        (detail) =>
          window.dispatchEvent(new CustomEvent("netevent", { detail })),
        detail,
      );
    if (message.action === "read")
      return {
        settings: {
          provider: "openai",
          apiKey: "test-key",
          model: "test",
          baseUrl: "https://provider.invalid/v1",
        },
      };
    if (message.action === "ready") return { document: {}, network: true };
    if (message.action === "cancelFetch") {
      cancelled.add(message.id);
      return true;
    }
    if (message.action !== "fetch") return true;
    requests.push(message);
    const { id } = message,
      path = new URL(message.url).pathname;
    const chunk = (bytes) =>
      emit({ id, chunk: Buffer.from(bytes).toString("base64") });
    if (path === "/slow-headers") return true;
    later(async () => {
      if (path === "/error-before") {
        await emit({ id, error: "Connection failed" });
        return;
      }
      if (path === "/no-content") {
        await emit({ id, status: 204 });
        await emit({ id, done: true });
        return;
      }
      const status = path.startsWith("/status/")
        ? Number(path.split("/").at(-1))
        : 200;
      await emit({
        id,
        status,
        headers: JSON.stringify({
          "content-type": "application/json",
          "retry-after": "2",
        }),
      });
      if (path === "/hold") return;
      if (path === "/error-mid") {
        await chunk(Buffer.from("prefix"));
        later(() => emit({ id, error: "Connection closed" }), 20);
        return;
      }
      let bytes;
      if (path === "/v1/chat/completions") {
        const answer = "IPA: /test/\n\n语境\n\n【详解】\n原生网络流。";
        bytes = Buffer.from(
          `data: ${JSON.stringify({ model: "native-mock", choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`,
        );
      } else if (status !== 200)
        bytes = Buffer.from(
          JSON.stringify({ error: { message: "配额或权限错误" } }),
        );
      else bytes = Buffer.from(JSON.stringify({ text: "语境🙂", ok: true }));
      for (let offset = 0; offset < bytes.length; offset += 2) {
        if (cancelled.has(id)) return;
        await chunk(bytes.subarray(offset, offset + 2));
      }
      await emit({ id, done: true });
    });
    return true;
  });
  await context.addInitScript(() => {
    window.__sumatra__ = {
      call: (_name, data) => window.testNative(JSON.parse(data)),
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/index.html");
  await page.locator("#status").filter({ hasText: "0 notes" }).waitFor();
  const result = await page.evaluate(async () => {
    const response = await fetch("https://provider.invalid/json", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: "语境" }),
    });
    const copy = response.clone();
    return {
      response: await response.json(),
      copy: await copy.json(),
      url: response.url,
      status: response.status,
      retry: response.headers.get("retry-after"),
    };
  });
  assert.deepEqual(result.response, { text: "语境🙂", ok: true });
  assert.deepEqual(result.copy, result.response);
  assert.equal(result.url, "https://provider.invalid/json");
  assert.equal(result.status, 200);
  assert.equal(result.retry, "2");
  assert.equal(
    JSON.parse(requests[0].headers).authorization,
    "Bearer test-key",
  );
  assert.equal(JSON.parse(requests[0].body).q, "语境");
  const statuses = await page.evaluate(async () => {
    const result = [];
    for (const status of [401, 429]) {
      const response = await fetch(`https://provider.invalid/status/${status}`);
      result.push({
        status: response.status,
        ok: response.ok,
        error: await response.json(),
      });
    }
    return result;
  });
  assert.deepEqual(
    statuses.map((r) => [r.status, r.ok]),
    [
      [401, false],
      [429, false],
    ],
  );
  assert.equal(statuses[1].error.error.message, "配额或权限错误");
  const failures = await page.evaluate(async () => {
    const result = [];
    try {
      await fetch("https://provider.invalid/error-before");
    } catch (err) {
      result.push(err.message);
    }
    try {
      const response = await fetch("https://provider.invalid/error-mid");
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      while (!(await reader.read()).done) {}
    } catch (err) {
      result.push(err.message);
    }
    return result;
  });
  assert.deepEqual(failures, ["Connection failed", "Connection closed"]);
  const aborts = await page.evaluate(async () => {
    const before = new AbortController();
    const waiting = fetch("https://provider.invalid/slow-headers", {
      signal: before.signal,
    });
    before.abort();
    let first, second;
    try {
      await waiting;
    } catch (err) {
      first = err.name;
    }
    const after = new AbortController(),
      response = await fetch("https://provider.invalid/hold", {
        signal: after.signal,
      });
    after.abort();
    try {
      await response.text();
    } catch (err) {
      second = err.name;
    }
    const readable = await fetch("https://provider.invalid/hold");
    await readable.body.getReader().cancel();
    return [first, second];
  });
  assert.deepEqual(aborts, ["AbortError", "AbortError"]);
  assert.ok(cancelled.size >= 2);
  const empty = await page.evaluate(async () => {
    const response = await fetch("https://provider.invalid/no-content");
    return {
      status: response.status,
      body: response.body,
      text: await response.text(),
    };
  });
  assert.deepEqual(empty, { status: 204, body: null, text: "" });
  const note = await page.evaluate(async () => {
    const { generateNote } = await import("./shared/llm.js");
    return generateNote({
      settings: {
        provider: "openai",
        apiKey: "test-key",
        model: "test",
        baseUrl: "https://provider.invalid/v1",
        ipa: "us",
      },
      page: { url: "test.pdf", title: "Test" },
      ann: { quote: "context", context: "full paragraph" },
      onText: () => {},
    });
  });
  assert.match(note.text, /原生网络流/);
  assert.equal(note.model, "native-mock");
  const count = requests.length;
  await page.evaluate(() =>
    fetch("./_locales/en/messages.json").then((r) => r.json()),
  );
  assert.equal(
    requests.length,
    count,
    "local resources must keep browser fetch",
  );
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: native fetch bridge; Request headers/body; status 401/429; UTF-8 across byte chunks; Response clone/JSON; stream errors; abort before/after headers; reader cancel; 204; shared LLM SSE; local-resource bypass.",
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  await browser.close();
  await new Promise((r) => server.close(r));
}
