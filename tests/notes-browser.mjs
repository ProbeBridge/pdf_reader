import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import {
  historyGroups,
  dayKey,
} from "../sumatrapdf/src/notes/history-model.js";
import { mergePage } from "../sumatrapdf/src/notes/note-store.js";

const assets = resolve("sumatrapdf/src/notes");
const artifacts = resolve(".test-artifacts");
await mkdir(artifacts, { recursive: true });
const requests = [],
  actions = [];
let base,
  fail = false,
  version = 0;
let injectConflict = false,
  conflicts = 0;
const answer =
  "IPA: /ˈkɒntekst/\n\n语境\n\n【详解】\n这里指**上下文**，需要结合原文理解。";
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      requests.push(data);
      if (fail) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const isFollowup = data.messages?.at(-1)?.content?.includes("为什么");
      const output = isFollowup
        ? "这是结合原文的追问回答。<img src=x onerror=alert(1)>"
        : answer;
      for (let i = 0; i < output.length; i += 7) {
        res.write(
          `data: ${JSON.stringify({ model: "local-test-model", choices: [{ delta: { content: output.slice(i, i + 7) } }] })}\n\n`,
        );
        await new Promise((r) => setTimeout(r, 12));
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    const path = resolve(assets, "." + decodeURIComponent(url.pathname));
    if (!path.startsWith(assets)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const bytes = await readFile(path);
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".css": "text/css",
    };
    res.writeHead(200, {
      "content-type": types[extname(path)] || "application/octet-stream",
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;
const today = Date.now(),
  yesterday = today - 86400000;
let history = [
  { path: "C:\\docs\\context.pdf", name: "context.pdf", opened: today },
  { path: "D:\\datasheets\\power.pdf", name: "power.pdf", opened: yesterday },
  { path: "D:\\archives\\legacy.pdf", name: "legacy.pdf", opened: 0 },
];
const removedHistory = new Map();
assert.equal(historyGroups(history).length, 3);
assert.equal(
  historyGroups(history, "DATASHEETS power")[0].files[0].name,
  "power.pdf",
);
assert.equal(dayKey(today), historyGroups(history)[0].day);
const d = {
  key: "test-document",
  path: "C:\\docs\\context.pdf",
  title: "context.pdf",
};
const selection = {
  ...d,
  quote: "context",
  context: "The context of a word determines its meaning.",
  ranges: [{ page: 2, start: 4, end: 11 }],
};
let readyDocument = d,
  readySelections = [];
const remoteNote = {
  id: "remote-new-note",
  quote: "remote",
  note: "另一窗口的注释",
  detail: "",
  ipa: "",
  status: "done",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  thread: [],
};
async function waitUntil(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail("Timed out waiting for stored annotation state");
}
{
  const local = {
    annotations: [
      {
        id: "a",
        updatedAt: 10,
        note: "local",
        thread: [{ id: "live", updatedAt: 5, a: "pending" }],
      },
    ],
  };
  const live = local.annotations[0].thread[0];
  mergePage(
    local,
    {
      annotations: [
        {
          id: "a",
          updatedAt: 20,
          note: "remote",
          thread: [{ id: "other", updatedAt: 20, a: "answer" }],
        },
        remoteNote,
      ],
    },
    (_id, turnId) => turnId === "live",
  );
  assert.equal(local.annotations.length, 2);
  assert.equal(local.annotations[0].note, "remote");
  assert.equal(
    local.annotations[0].thread.find((t) => t.id === "live"),
    live,
    "keep in-flight target identity",
  );
  mergePage(local, { annotations: [], _deletedNotes: { a: 30 } });
  assert.equal(
    local.annotations.some((a) => a.id === "a"),
    false,
    "newer deletion beats stale data",
  );
}
const store = {
  settings: {
    provider: "openai",
    apiKey: "local-test-key",
    baseUrl: `${base}/v1`,
    model: "local-test",
    clickToAnnotate: true,
    panelZoom: 100,
    ipa: "us",
  },
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 440, height: 950 },
});
await context.exposeBinding("testNative", async (_source, message) => {
  actions.push(message);
  switch (message.action) {
    case "read":
      return structuredClone(store);
    case "write":
      if (
        message.expected !== undefined &&
        injectConflict &&
        message.key.startsWith("page:")
      ) {
        injectConflict = false;
        const latest = structuredClone(store[message.key]);
        latest.annotations.push(structuredClone(remoteNote));
        store[message.key] = latest;
      }
      if (
        message.expected !== undefined &&
        message.expected !== JSON.stringify(store[message.key] ?? null)
      ) {
        conflicts++;
        return { conflict: true };
      }
      store[message.key] = JSON.parse(message.value);
      version++;
      return true;
    case "remove":
      delete store[message.key];
      version++;
      return true;
    case "ready":
      return { document: readyDocument, selections: readySelections };
    case "history":
      return history;
    case "hideHistory":
      removedHistory.set(
        message.path,
        history.find((e) => e.path === message.path),
      );
      history = history.filter((e) => e.path !== message.path);
      return true;
    case "restoreHistory":
      history.push(removedHistory.get(message.path));
      removedHistory.delete(message.path);
      return true;
    default:
      return true;
  }
});
await context.addInitScript(() => {
  globalThis.chrome ||= {};
  globalThis.chrome.webview = { bridgeMarker: "preserve-native-webview" };
  window.__sumatra__ = {
    call: (_method, data) => window.testNative(JSON.parse(data)),
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(`${base}/index.html`);
  assert.equal(
    await page.evaluate(() => chrome.webview.bridgeMarker),
    "preserve-native-webview",
  );
  await page.getByText("让生词留在上下文里").waitFor();
  await page.evaluate(
    (s) => window.dispatchEvent(new CustomEvent("annotate", { detail: s })),
    selection,
  );
  await page.locator(".meaning").filter({ hasText: "语境" }).waitFor();
  await page.locator(".pending").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".ipa").textContent(), "/ˈkɒntekst/");
  assert.equal(
    await page.locator(".card-head > .quote + .inline-speak + .ipa").count(),
    1,
  );
  assert.equal(
    await page.locator(".card > .tools [data-icon='speak']").count(),
    0,
  );
  assert.equal(await page.locator("details").getAttribute("open"), null);
  await page.locator(".card").hover();
  await page.locator(".detail-toggle").click();
  await page.getByRole("button", { name: "追问", exact: true }).click();
  await page.locator(".ask-box textarea").fill("为什么这里这样理解？");
  await page.locator(".ask-box textarea").press("Enter");
  await page.locator(".turn .pending").waitFor({ state: "hidden" });
  assert.match(await page.locator(".answer").textContent(), /结合原文/);
  assert.equal(
    await page.locator(".answer img").count(),
    0,
    "model HTML must be escaped",
  );
  const body = requests[0];
  assert.match(body.messages[1].content, /The context of a word/);
  assert.match(body.messages[1].content, /<selection>\ncontext/);
  assert.match(requests[1].messages[2].content, /上下文/);
  await page.locator(".ask-box textarea").fill("尚未发送的草稿");
  await page.getByRole("button", { name: /^重新生成/ }).click();
  await page.locator(".card > .pending").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator(".ask-box textarea").inputValue(),
    "尚未发送的草稿",
  );
  assert.equal(await page.locator("details").getAttribute("open"), "");
  await page.locator(".quote").click();
  assert.ok(actions.some((a) => a.action === "goto"));
  assert.ok(
    actions.some(
      (a) => a.action === "highlights" && JSON.parse(a.items).length === 1,
    ),
  );
  await page.screenshot({
    path: resolve(artifacts, "notes.png"),
    fullPage: true,
  });
  const followId = await page.locator(".card").getAttribute("data-id");
  async function resumeFollowing() {
    await page.evaluate((id) => {
      document.activeElement?.blur();
      window.dispatchEvent(new CustomEvent("focusnote", { detail: { id } }));
      window.dispatchEvent(
        new CustomEvent("notepositions", { detail: [{ id, y: 300 }] }),
      );
    }, followId);
    await page.waitForFunction(
      (id) =>
        Math.abs(
          document.getElementById(`ann-${id}`).getBoundingClientRect().top -
            300,
        ) < 2,
      followId,
    );
  }
  async function movePageAndSource() {
    return page.evaluate((id) => {
      scrollTo({ top: 150, behavior: "instant" });
      const before = scrollY;
      window.dispatchEvent(
        new CustomEvent("notepositions", { detail: [{ id, y: 320 }] }),
      );
      return { before, after: scrollY };
    }, followId);
  }
  await resumeFollowing();
  await page.keyboard.press("PageDown");
  const keyboardScroll = await movePageAndSource();
  assert.ok(keyboardScroll.before > 0);
  assert.equal(
    keyboardScroll.after,
    keyboardScroll.before,
    "keyboard scrolling must stop following the source",
  );
  await resumeFollowing();
  await page.evaluate(() =>
    window.dispatchEvent(
      new MouseEvent("mousedown", {
        clientX: document.documentElement.clientWidth,
        bubbles: true,
      }),
    ),
  );
  const scrollbarScroll = await movePageAndSource();
  assert.equal(
    scrollbarScroll.after,
    scrollbarScroll.before,
    "dragging the scrollbar must stop following the source",
  );
  await resumeFollowing();
  await page.locator(".ask-box textarea").focus();
  await page.locator(".ask-box textarea").press("PageDown");
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new CustomEvent("notepositions", { detail: [{ id, y: 340 }] }),
      ),
    followId,
  );
  await page.waitForFunction(
    (id) =>
      Math.abs(
        document.getElementById(`ann-${id}`).getBoundingClientRect().top - 340,
      ) < 2,
    followId,
  );
  await page.reload();
  await page.locator(".card").waitFor();
  assert.equal(
    await page.locator(".turn").count(),
    1,
    "thread restores after reopening",
  );
  await page.locator(".card").hover();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByText("确认删除", { exact: true }).click();
  await page.locator(".card").waitFor({ state: "hidden" });
  await page.getByText("撤销", { exact: true }).click();
  await page.locator(".card").waitFor();
  fail = true;
  await page.locator(".card").hover();
  await page.getByRole("button", { name: /^重新生成/ }).click();
  await page.locator(".error").filter({ hasText: /401/ }).waitFor();
  fail = false;
  await page.locator(".card").hover();
  await page.getByRole("button", { name: /^重新生成/ }).click();
  await page.locator(".error").waitFor({ state: "hidden" });
  await page.locator(".card > .pending").waitFor({ state: "hidden" });
  await page.locator("#settings").click();
  await page.locator("#test").click();
  await page
    .locator("#test-result")
    .filter({ hasText: "local-test-model" })
    .waitFor();
  await page.locator("#cancel-settings").click();
  const saved = structuredClone(store);
  assert.ok(saved["page:test-document"].annotations[0].thread.length === 1);
  await page.locator(".card").hover();
  await page.locator(".detail-toggle").click();
  await page.evaluate(() => {
    const body = document.querySelector(".detail-body");
    const range = document.createRange();
    range.selectNodeContents(body);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "解释这段", exact: true }).click();
  assert.match(
    await page.locator(".ask-box textarea").inputValue(),
    /请再解释一下.*上下文/,
  );

  const peer = await context.newPage();
  await peer.goto(`${base}/index.html`);
  await peer.locator(".card").waitFor();
  injectConflict = true;
  await page.locator(".card").hover();
  await page.getByRole("button", { name: /^重新生成/ }).click();
  await waitUntil(
    () =>
      conflicts > 0 &&
      store["page:test-document"].annotations.every((a) => a.status === "done"),
  );
  assert.ok(
    store["page:test-document"].annotations.some((a) => a.id === remoteNote.id),
    "CAS retry preserves another window’s new note",
  );
  const select = (target, quote, start) =>
    target.evaluate(
      (s) => window.dispatchEvent(new CustomEvent("annotate", { detail: s })),
      { ...selection, quote, ranges: [{ page: 3, start, end: start + 4 }] },
    );
  await Promise.all([
    select(page, "first-window", 30),
    select(peer, "second-window", 40),
  ]);
  await waitUntil(() =>
    ["first-window", "second-window"].every((q) =>
      store["page:test-document"].annotations.some(
        (a) => a.quote === q && a.status === "done",
      ),
    ),
  );
  assert.ok(
    store["page:test-document"].annotations.find((a) => a.quote === "context")
      .thread.length === 1,
  );

  const other = {
    key: "other-document",
    path: "C:\\docs\\other.pdf",
    title: "other.pdf",
  };
  readyDocument = other;
  readySelections = [
    {
      ...selection,
      quote: "queued-old-word",
      ranges: [{ page: 7, start: 1, end: 4 }],
    },
  ];
  await page.reload();
  await page.locator("#doc-title").filter({ hasText: "other.pdf" }).waitFor();
  await waitUntil(() =>
    store["page:test-document"].annotations.some(
      (a) => a.quote === "queued-old-word" && a.status === "done",
    ),
  );
  assert.equal(
    await page.locator("#doc-title").textContent(),
    "other.pdf",
    "queued old selection must not steal the current document",
  );
  assert.equal(await page.locator(".card").count(), 0);
  readyDocument = d;
  readySelections = [];
  await page.evaluate(
    (d) =>
      window.dispatchEvent(new CustomEvent("documentchange", { detail: d })),
    d,
  );
  await page.locator(".card").first().waitFor();
  await page.locator("#settings").click();
  const beforeInvalid = version;
  await page.locator("#import-file").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        pages: {
          "page:test-document": {
            annotations: [{ id: "bad", quote: "bad", thread: [null] }],
          },
        },
      }),
    ),
  });
  await page.getByText("注释文件格式不正确", { exact: true }).waitFor();
  assert.equal(
    version,
    beforeInvalid,
    "invalid imports must not partly write data",
  );
  const imported = {
    id: "imported-note",
    quote: "imported",
    note: "导入释义",
    detail: "",
    ipa: "",
    thread: [],
    status: "done",
    createdAt: Date.now(),
  };
  await page.locator("#import-file").setInputFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        pages: {
          "page:test-document": { annotations: [imported, imported] },
        },
      }),
    ),
  });
  await page.getByText("注释已导入", { exact: true }).waitFor();
  assert.equal(
    store["page:test-document"].annotations.filter(
      (a) => a.id === "imported-note",
    ).length,
    1,
    "deduplicate IDs inside imported files",
  );
  await page.locator("#cancel-settings").click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("deletenote", {
        detail: { key: "test-document", id: "imported-note" },
      }),
    ),
  );
  await page.locator('[data-id="imported-note"]').waitFor({ state: "hidden" });
  await page.evaluate(
    (d) =>
      window.dispatchEvent(new CustomEvent("documentchange", { detail: d })),
    other,
  );
  await page.locator("#doc-title").filter({ hasText: "other.pdf" }).waitFor();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(
    await page.locator(".card").count(),
    0,
    "undo must restore the original document, not the document now visible",
  );
  assert.equal(
    store["page:test-document"].annotations.filter(
      (a) => a.id === "imported-note",
    ).length,
    1,
  );
  await peer.close();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/history.html`);
  await page.locator(".row").first().waitFor();
  assert.equal(await page.locator(".group").count(), 3);
  await page.locator("#search").fill("DATASHEETS power");
  assert.equal(await page.locator(".row").count(), 1);
  assert.match(await page.locator(".file button").textContent(), /power/);
  await page.locator("#search").fill("not-present");
  await page.getByText("没有匹配的阅读记录").waitFor();
  await page.locator("#search").fill("");
  await page.screenshot({
    path: resolve(artifacts, "history.png"),
    fullPage: true,
  });
  await page.locator(".remove").first().click();
  assert.equal(await page.locator(".row").count(), 2);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".row").length === 3,
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS: generation, context, IPA, details, follow-up, safe Markdown, drafts, retry/restore, explain selection, CAS merge, concurrent windows, queued document selection, import validation/deduplication, highlight delete/undo, connection test, history grouping/search/removal (${version} saves; ${conflicts} CAS conflicts).`,
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
