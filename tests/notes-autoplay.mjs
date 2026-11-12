import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const assets = resolve("sumatrapdf/src/notes");
const requests = [];
const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ body: JSON.parse(body), response: res });
      return;
    }
    const path = resolve(
      assets,
      "." + new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(assets + "/")) throw new Error("Invalid asset path");
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".css": "text/css",
    };
    const bytes = await readFile(path);
    res.writeHead(200, {
      "content-type": types[extname(path)] || "application/octet-stream",
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const document = {
  key: "speech-document",
  path: "/test/context.pdf",
  title: "context.pdf",
};
const store = {
  settings: {
    provider: "openai",
    apiKey: "mock",
    baseUrl: `${base}/v1`,
    model: "mock",
    ipa: "off",
  },
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "zh-CN" });
await context.route("**/*", (route) =>
  route.request().url().startsWith(base) ? route.continue() : route.abort(),
);
await context.exposeBinding("testNative", (_source, message) => {
  if (message.action === "read") return structuredClone(store);
  if (message.action === "write") {
    if (
      message.expected !== undefined &&
      message.expected !== JSON.stringify(store[message.key] ?? null)
    )
      return { conflict: true };
    store[message.key] = JSON.parse(message.value);
  }
  if (message.action === "remove") delete store[message.key];
  if (message.action === "ready") return { document };
  return true;
});
await context.addInitScript(() => {
  window.__sumatra__ = {
    call: (_name, json) => window.testNative(JSON.parse(json)),
  };
  const state = (window.speechTest = {
    requests: [],
    plays: [],
    pending: new Map(),
    autoEnd: true,
    sources: [],
    stops: 0,
  });
  window.Worker = class {
    postMessage(message) {
      state.requests.push(message);
      state.pending.set(message.id, { worker: this, message });
    }
    terminate() {}
  };
  window.releaseSpeech = (text) => {
    const entry = [...state.pending.values()].find(
      ({ message }) => message.text === text,
    );
    if (!entry) throw new Error(`No pending speech for ${text}`);
    state.pending.delete(entry.message.id);
    entry.worker.onmessage({
      data: {
        id: entry.message.id,
        audio: new Float32Array([0, 0.3, -0.3, 0.2, 0]),
        rate: 24000,
      },
    });
  };
  window.AudioContext = class {
    state = "running";
    destination = {};
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    createBuffer() {
      return { copyToChannel() {} };
    }
    createBufferSource() {
      const source = {
        ended: false,
        connect() {},
        complete() {
          if (this.ended) return;
          this.ended = true;
          this.onended?.();
        },
        start() {
          state.plays.push(performance.now());
          if (state.autoEnd) setTimeout(() => this.complete(), 0);
        },
        stop() {
          if (!this.ended) state.stops++;
          this.complete();
        },
      };
      state.sources.push(source);
      return source;
    }
  };
  window.finishSpeech = () =>
    state.sources.forEach((source) => source.complete());
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const waitUntil = async (check) => {
  const end = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < end, "Timed out waiting for LLM request or storage");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const annotation = (quote, start) => ({
  ...document,
  quote,
  context: `The original paragraph contains ${quote}.`,
  ranges: [{ page: 1, start, end: start + quote.length }],
});
const emit = (name, detail) =>
  page.evaluate(
    ({ name, detail }) => dispatchEvent(new CustomEvent(name, { detail })),
    { name, detail },
  );
const speechCounts = () =>
  page.evaluate(() => ({
    requests: speechTest.requests.length,
    plays: speechTest.plays.length,
  }));
const releaseSpeech = (quote) =>
  page.evaluate((quote) => releaseSpeech(quote + "."), quote);
const settleFrames = () =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const answer = (index) => {
  const res = requests[index].response;
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "语境\n\n【详解】\n测试解释。" } }] })}\n\ndata: [DONE]\n\n`,
  );
};
try {
  await page.goto(`${base}/index.html`);
  await page.locator("#empty").waitFor({ state: "visible" });
  const selection = annotation("context", 1);
  await page.evaluate(() => {
    speechTest.autoEnd = false;
  });
  await emit("annotate", selection);
  await waitUntil(() => requests.length === 1);
  await page.waitForFunction(() => speechTest.requests.length === 1);
  assert.equal(await page.locator(".pending").count(), 1);
  const initialId = await page.locator(".card").getAttribute("data-id");
  await page.locator(".inline-speak").click();
  await page.locator(".inline-speak").click();
  await emit("speaknote", { key: document.key, id: initialId });
  assert.deepEqual(
    await speechCounts(),
    { requests: 1, plays: 0 },
    "pending autoplay and manual clicks share synthesis",
  );
  await releaseSpeech("context");
  await page.waitForFunction(() => speechTest.plays.length === 1);
  await page.locator(".inline-speak").click();
  await page.locator(".inline-speak").click();
  await emit("speaknote", { key: document.key, id: initialId });
  assert.deepEqual(
    await speechCounts(),
    { requests: 1, plays: 1 },
    "repeated clicks do not restart ongoing autoplay",
  );
  assert.equal(await page.evaluate(() => speechTest.stops), 0);
  await page.evaluate(() => {
    finishSpeech();
    speechTest.autoEnd = true;
  });
  await page.waitForFunction(
    () => !document.querySelector(".inline-speak").classList.contains("on"),
  );
  assert.equal(
    requests[0].response.writableEnded,
    false,
    "speech plays before the LLM reply",
  );
  answer(0);
  await page.waitForFunction(
    () => document.querySelectorAll(".pending").length === 0,
  );
  assert.deepEqual(await speechCounts(), { requests: 1, plays: 1 });

  await emit("annotate", selection);
  await settleFrames();
  assert.equal(requests.length, 1);
  assert.deepEqual(
    await speechCounts(),
    { requests: 1, plays: 1 },
    "reselecting an existing note is silent",
  );

  await page.locator(".card").hover();
  await page.locator('button[title^="重新生成"]').click();
  await waitUntil(() => requests.length === 2);
  assert.deepEqual(
    await speechCounts(),
    { requests: 1, plays: 1 },
    "regeneration is silent",
  );
  answer(1);
  await page.waitForFunction(
    () => document.querySelectorAll(".pending").length === 0,
  );

  await page.locator(".card").hover();
  await page.locator('button[title="追问"]').click();
  await page.locator(".ask-box textarea").fill("为什么？");
  await page.locator(".ask-box textarea").press("Enter");
  await waitUntil(() => requests.length === 3);
  assert.deepEqual(
    await speechCounts(),
    { requests: 1, plays: 1 },
    "follow-ups are silent",
  );
  answer(2);
  await page.waitForFunction(
    () => document.querySelectorAll(".pending").length === 0,
  );

  await page.locator(".inline-speak").click();
  await page.waitForFunction(() => speechTest.plays.length === 2);
  await page.waitForFunction(
    () => !document.querySelector(".inline-speak").classList.contains("on"),
  );
  const id = await page.locator(".card").getAttribute("data-id");
  await emit("speaknote", { key: document.key, id });
  await page.waitForFunction(() => speechTest.plays.length === 3);
  await page.waitForFunction(
    () => !document.querySelector(".inline-speak").classList.contains("on"),
  );
  await emit("speaknote", { key: "stale-document", id });
  await emit("speaknote", { key: document.key, id: "missing-note" });
  await settleFrames();
  assert.deepEqual(
    await speechCounts(),
    { requests: 1, plays: 3 },
    "manual replay reuses the synthesized clip and validates its document",
  );

  await page.reload();
  await page.locator(".card .quote").filter({ hasText: "context" }).waitFor();
  await settleFrames();
  assert.deepEqual(
    await speechCounts(),
    { requests: 0, plays: 0 },
    "restored notes do not autoplay",
  );

  await emit("annotate", annotation("obsolete", 20));
  await waitUntil(() => requests.length === 4);
  await page.waitForFunction(() => speechTest.requests.length === 1);
  await emit("documentchange", {
    key: "other-document",
    path: "/test/other.pdf",
    title: "other.pdf",
  });
  await page.locator("#doc-title").filter({ hasText: "other.pdf" }).waitFor();
  await releaseSpeech("obsolete");
  await settleFrames();
  assert.deepEqual(
    await speechCounts(),
    { requests: 1, plays: 0 },
    "navigation cancels pending autoplay",
  );
  answer(3);
  await waitUntil(
    () =>
      store[`page:${document.key}`]?.annotations.find(
        (note) => note.quote === "obsolete",
      )?.status === "done",
  );

  await emit("documentchange", document);
  await page.locator("#doc-title").filter({ hasText: "context.pdf" }).waitFor();
  await emit("annotate", annotation("firstwaiting", 40));
  await waitUntil(() => requests.length === 5);
  await emit("annotate", annotation("secondwaiting", 60));
  await waitUntil(() => requests.length === 6);
  await releaseSpeech("firstwaiting");
  await settleFrames();
  assert.equal(
    (await speechCounts()).plays,
    0,
    "a newer annotation cancels stale pending playback",
  );
  await releaseSpeech("secondwaiting");
  await page.waitForFunction(() => speechTest.plays.length === 1);
  answer(4);
  answer(5);
  await page.waitForFunction(
    () => document.querySelectorAll(".pending").length === 0,
  );

  await emit("annotate", annotation("deletewaiting", 90));
  await waitUntil(() => requests.length === 7);
  const deleteId = await page
    .locator(".card")
    .filter({ has: page.locator(".quote", { hasText: "deletewaiting" }) })
    .getAttribute("data-id");
  await emit("deletenote", { key: document.key, id: deleteId });
  await page
    .locator(`.card[data-id="${deleteId}"]`)
    .waitFor({ state: "hidden" });
  await releaseSpeech("deletewaiting");
  await settleFrames();
  assert.equal(
    (await speechCounts()).plays,
    1,
    "deletion cancels pending autoplay",
  );
  const baseline = await speechCounts();
  await page.evaluate(async () => {
    const { speak } = await import("./shared/tts.js");
    speechTest.autoEnd = false;
    const first = document.createElement("button"),
      second = document.createElement("button");
    const controller = new AbortController();
    const running = speak("deduplicate", first, { signal: controller.signal });
    const duplicate = speak("  deduplicate  ", second);
    window.directSpeech = {
      first,
      second,
      controller,
      running,
      same: running === duplicate,
    };
  });
  assert.equal(
    await page.evaluate(() => directSpeech.same),
    true,
    "same pending text returns the shared job promise",
  );
  await releaseSpeech("deduplicate");
  await page.waitForFunction(
    (count) => speechTest.plays.length === count,
    baseline.plays + 1,
  );
  await page.evaluate(() => directSpeech.controller.abort());
  await page.evaluate(() => directSpeech.running);
  assert.equal(
    await page.evaluate(
      () =>
        directSpeech.first.classList.contains("on") ||
        directSpeech.second.classList.contains("on"),
    ),
    false,
    "aborting shared speech clears every bound button",
  );
  const stopped = await page.evaluate(() => speechTest.stops);
  await page.evaluate(async () => {
    const { speak } = await import("./shared/tts.js");
    window.interruptedSpeech = speak("interrupt-first");
  });
  await releaseSpeech("interrupt-first");
  await page.waitForFunction(
    (count) => speechTest.plays.length === count,
    baseline.plays + 2,
  );
  await page.evaluate(async () => {
    const { speak } = await import("./shared/tts.js");
    window.nextSpeech = speak("interrupt-second");
  });
  await page.evaluate(() => interruptedSpeech);
  assert.equal(
    await page.evaluate(() => speechTest.stops),
    stopped + 1,
    "a different text interrupts current playback",
  );
  await releaseSpeech("interrupt-second");
  await page.waitForFunction(
    (count) => speechTest.plays.length === count,
    baseline.plays + 3,
  );
  await page.evaluate(() => finishSpeech());
  await page.evaluate(() => nextSpeech);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: new-note speech and LLM run concurrently; one autoplay; no repeats on restore/reselect/regenerate/follow-up; cached manual/native replay; in-flight same-text deduplication; shared cancellation/buttons; different-text interruption; navigation/new-note/delete cancellation.",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
