import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `native-${Date.now()}`);
mkdirSync(output, { recursive: true });
const exe = join(root, "sumatrapdf", "out", "rel64", "SumatraPDF.exe");
process.env.SUMATRA_TEST_EXE = exe;
const { launchControlled, sendCommandSync, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { cmdId, makeTextPdf } = await import("../sumatrapdf/tests/util.ts");
const { captureWindowToPng, setProcessDpiAware } =
  await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const file = join(output, "context-native.pdf");
writeFileSync(
  file,
  makeTextPdf(
    "The context of a word determines its meaning. Read the full paragraph carefully.",
  ),
);
const data = join(output, "appdata");
mkdirSync(data);
const legacyFile = join(output, "legacy.pdf");
copyFileSync(file, legacyFile);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nShowStartPage = true\nRememberOpenedFiles = true\nUseTabs = true\nSelectionToolbar = true\n" +
    `FileStates [\n  [\n    FilePath = ${legacyFile}\n    OpenCount = 1\n    PageNo = 1\n  ]\n]\n`,
);
const calls: any[] = [];
let activeSlow = 0;
let redirectFollowed = false;
const model = createServer(async (req, res) => {
  if (req.url === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"models":[{"name":"native-model"}]}');
    return;
  }
  if (req.url === "/unauthorized") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"synthetic denied"}}');
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/redirect-target" });
    res.end("redirect");
    return;
  }
  if (req.url === "/redirect-target") {
    redirectFollowed = true;
    res.end("must not follow");
    return;
  }
  if (req.url === "/slow") {
    activeSlow++;
    res.on("close", () => activeSlow--);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("first chunk");
    return;
  }
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  calls.push(JSON.parse(raw));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const answer = "IPA: /ðə/\n\n这个\n\n【详解】\n在完整原文中理解选中的表达。";
  res.write(
    `data: ${JSON.stringify({ model: "native-test-model", choices: [{ delta: { content: answer } }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
const modelPort = (model.address() as any).port;
const devPort = createServer();
await new Promise<void>((r) => devPort.listen(0, "127.0.0.1", r));
const debugPort = (devPort.address() as any).port;
await new Promise<void>((r) => devPort.close(() => r()));
const env = {
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
};
const testKey = "LOCAL_TEST_KEY_NEVER_SEND_EXTERNALLY";
let app: any, browser: any;
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  while (Date.now() < end) {
    try {
      value = await fn();
      if (predicate(value)) return value;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for native notes state");
}
async function deadline<T>(promise: Promise<T>, timeout = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native transport timed out")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function connect() {
  return await poll(
    async () => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`),
    Boolean,
  );
}
async function notesPage() {
  return await poll(
    async () =>
      browser
        .contexts()
        .flatMap((c: any) => c.pages())
        .find((p: any) => p.url().includes("sumatra-notes/index.html")),
    Boolean,
  );
}
async function stop() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
    app = null;
  }
}
try {
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1280x900@100x80", file],
    { saveSettings: true, env },
  );
  await app.client.waitForRenderIdle();
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  browser = await connect();
  let panel = await notesPage();
  await panel.locator("#cards").waitFor();
  await panel.waitForFunction(() => !!(window as any).chrome?.storage);
  await panel.waitForFunction(() => fetch.name === "nativeFetch");
  const transport = await deadline(
    panel.evaluate(async (port: number) => {
      const base = `http://127.0.0.1:${port}`;
      const get = await fetch(base + "/models").then((r) => r.json());
      const denied = await fetch(base + "/unauthorized");
      const deniedBody = await denied.json();
      const redirect = await fetch(base + "/redirect");
      const controller = new AbortController();
      const slow = await fetch(base + "/slow", { signal: controller.signal });
      const reader = slow.body!.getReader();
      await reader.read();
      controller.abort();
      let aborted = false;
      try {
        await reader.read();
      } catch (error) {
        aborted = (error as Error).name === "AbortError";
      }
      return {
        model: get.models[0].name,
        status: denied.status,
        message: deniedBody.error.message,
        redirect: redirect.status,
        aborted,
      };
    }, modelPort),
  );
  assert.deepEqual(transport, {
    model: "native-model",
    status: 401,
    message: "synthetic denied",
    redirect: 302,
    aborted: true,
  });
  assert.equal(redirectFollowed, false);
  await poll(
    async () => activeSlow,
    (n) => n === 0,
  );
  await panel.evaluate(
    async ({ testKey, modelPort }: any) => {
      await (window as any).chrome.storage.local.set({
        settings: {
          provider: "openai",
          apiKey: testKey,
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          model: "native-test",
          ipa: "us",
          panelZoom: 100,
          clickToAnnotate: true,
        },
      });
    },
    { testKey, modelPort },
  );
  const seeded = await app.client.seedTextSelection(1);
  assert.ok(seeded.parts > 0);
  sendCommandSync(app.frame, cmdId("CmdContextAnnotate"));
  await panel.locator(".meaning").filter({ hasText: "这个" }).waitFor();
  await panel.locator(".pending").waitFor({ state: "hidden" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /context of a word/);
  const highlights = await panel.evaluate(async () => {
    const stored = await (window as any).chrome.storage.local.get(null);
    return Object.entries(stored).filter(([k]) => k.startsWith("page:"));
  });
  assert.equal(highlights.length, 1);
  assert.match(highlights[0][0], /^page:sha256:/);
  assert.ok((highlights[0][1] as any).annotations[0].anchor.ranges.length > 0);
  const encrypted = readFileSync(join(data, "context-notes.dat"));
  assert.equal(
    encrypted.includes(Buffer.from(testKey)),
    false,
    "API key must be encrypted on disk",
  );
  await captureWindowToPng(app.frame, join(output, "native-notes.png"));
  sendCommandSync(app.frame, cmdId("CmdReadingHistory"));
  const history = await poll(
    async () =>
      browser
        .contexts()
        .flatMap((c: any) => c.pages())
        .find((p: any) => p.url().includes("sumatra-notes/history.html")),
    Boolean,
  );
  await history.locator(".row").first().waitFor();
  assert.ok(
    (await history
      .locator(".group h3")
      .filter({ hasText: /Earlier|较早/ })
      .count()) > 0,
    "legacy history without timestamps must load",
  );
  assert.match(
    await history.locator(".group h3").first().textContent(),
    /Today|今天/,
  );
  await history.locator("#search").fill("context-native");
  assert.equal(await history.locator(".row").count(), 1);
  await captureWindowToPng(app.frame, join(output, "native-history.png"));
  await panel.evaluate((port: number) => {
    fetch(`http://127.0.0.1:${port}/slow`)
      .then((r) => r.body!.getReader().read())
      .catch(() => {});
  }, modelPort);
  await poll(
    async () => activeSlow,
    (n) => n === 1,
  );
  await stop();
  await poll(
    async () => activeSlow,
    (n) => n === 0,
  );
  const renamed = join(output, "renamed.pdf");
  copyFileSync(file, renamed);
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1280x900@100x80", renamed],
    { saveSettings: true, env },
  );
  browser = await connect();
  panel = await notesPage();
  await panel.locator(".meaning").filter({ hasText: "这个" }).waitFor();
  assert.equal(
    calls.length,
    1,
    "restoring notes must not call the model again",
  );
  console.log(
    "PASS: native selection → streaming model → highlight anchors; encrypted persistence; chronological searchable history; rename/reopen restore; HTTP without CORS, GET, 401 body, redirect blocking, cancellation and window-close cleanup.",
  );
  console.log(`Artifacts: ${output}`);
} finally {
  await stop();
  await new Promise<void>((r) => model.close(() => r()));
}
