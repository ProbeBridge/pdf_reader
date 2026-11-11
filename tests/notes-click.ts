import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `click-${Date.now()}`);
mkdirSync(output, { recursive: true });
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf",
  "out",
  "rel64",
  "SumatraPDF.exe",
);
const {
  launchControlled,
  sendCommandSync,
  clickAt,
  findCanvas,
  pressEscape,
  killAndWait,
} = await import("../sumatrapdf/tests/win-automation.ts");
const { cmdId, makeTextPdf } = await import("../sumatrapdf/tests/util.ts");
const { ControlCommand } = await import("../sumatrapdf/tests/control.ts");
const {
  findTopWindow,
  isWindowVisible,
  captureWindowToPng,
  sendMessage,
  packCoords,
  WM_LBUTTONUP,
  MK_LBUTTON,
  setProcessDpiAware,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const file = join(output, "click.pdf");
writeFileSync(
  file,
  makeTextPdf("The context of a word determines its meaning."),
);
const data = join(output, "appdata");
mkdirSync(data);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "RestoreSession = false\nCheckForUpdates = false\nShowToc = false\nRememberOpenedFiles = true\nUseTabs = true\nSelectionToolbar = true\n",
);
let calls = 0;
const model = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  assert.match(request.messages[1].content, /The/);
  calls++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const answer = "IPA: /ðə/\n\n这个\n\n【详解】\n根据句子语境理解这个词。";
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
const modelPort = (model.address() as any).port;
const debugServer = createServer();
await new Promise<void>((r) => debugServer.listen(0, "127.0.0.1", r));
const debugPort = (debugServer.address() as any).port;
await new Promise<void>((r) => debugServer.close(() => r()));
let app: any, browser: any;
async function poll<T>(
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  timeout = 15000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (ok(value)) return value;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for click annotation state");
}
async function wordPoint() {
  const layout = await app.client.layout();
  const match = /page n=1 shown=1 .* screen=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(
    layout.raw,
  );
  assert.ok(match, layout.raw);
  const [x, y, dx, dy] = match.slice(1).map(Number);
  // makeTextPdf draws 18pt Helvetica at (72,700); this is inside "The".
  return {
    x: Math.round(x + (87 * dx) / 612),
    y: Math.round(y + (86 * dy) / 792),
  };
}
try {
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1280x900@100x80", file],
    {
      saveSettings: true,
      env: {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      },
    },
  );
  await app.client.waitForRenderIdle();
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  browser = await poll(async () => {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    } catch {
      return null;
    }
  }, Boolean);
  const panel = await poll(
    async () =>
      browser
        .contexts()
        .flatMap((c: any) => c.pages())
        .find((p: any) => p.url().includes("sumatra-notes/index.html")),
    Boolean,
  );
  await panel.waitForFunction(() => fetch.name === "nativeFetch");
  await panel.evaluate(async (modelPort: number) => {
    await (window as any).chrome.storage.local.set({
      settings: {
        provider: "openai",
        apiKey: "LOCAL_CLICK_TEST_ONLY",
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "click-test",
        ipa: "us",
        clickToAnnotate: true,
      },
    });
  }, modelPort);
  const canvas = findCanvas(app.frame);
  assert.ok(canvas, "document canvas exists");
  await app.client.waitForRenderIdle();
  // Ordinary mouse hover starts extraction; prime the same cache deterministically for posted input.
  await app.client.seedTextSelection(1);
  await pressEscape(app.frame);
  const first = await wordPoint();
  await clickAt(canvas, first.x, first.y, 0);
  const point = packCoords(first.x, first.y);
  sendMessage(canvas, 0x0203, MK_LBUTTON, point); // WM_LBUTTONDBLCLK
  sendMessage(canvas, WM_LBUTTONUP, 0, point);
  await Bun.sleep(1200);
  assert.equal(calls, 0, "double-click must select text without annotating");
  const doubleSelection = String(
    (
      await app.client.request(ControlCommand.TestSelectionVars, [
        "${selection}",
      ])
    )[1],
  );
  captureWindowToPng(app.frame, join(output, "double-click.png"));
  assert.match(
    doubleSelection,
    /expanded=The(?:\r?\n|$)/,
    "double-click must preserve ordinary word selection",
  );
  console.log("PRECHECK PASS: double-click selected text without annotating");
  await pressEscape(app.frame);
  await clickAt(canvas, first.x, first.y, 1000);
  await panel
    .locator(".meaning")
    .filter({ hasText: "这个" })
    .waitFor({ timeout: 15000 });
  await panel.locator(".pending").waitFor({ state: "hidden" });
  assert.equal(calls, 1, "one plain English-word click must annotate once");
  assert.equal(
    await panel.locator(".quote").textContent(),
    "The",
    "a single click must capture the whole word",
  );
  const range = await panel.evaluate(async () => {
    const values = await (window as any).chrome.storage.local.get(null);
    return (
      Object.entries(values).find(([key]) =>
        key.startsWith("page:"),
      )?.[1] as any
    )?.annotations[0]?.anchor.ranges[0];
  });
  assert.equal(
    range.end - range.start,
    3,
    "the highlight anchor must cover all three word glyphs",
  );
  console.log("PRECHECK PASS: native single word click annotated successfully");
  const same = await wordPoint();
  await clickAt(canvas, same.x, same.y, 1000);
  const overlay = findTopWindow(app.proc.pid, "SumatraContextNoteActions");
  captureWindowToPng(
    app.frame,
    join(output, "after-first-highlight-click.png"),
  );
  assert.ok(
    overlay && isWindowVisible(overlay),
    "the first click on a new highlight must show its delete action",
  );
  assert.equal(
    calls,
    1,
    "clicking an existing highlight must not request the model again",
  );
  await pressEscape(app.frame);
  await app.client.seedTextSelection(1);
  const selected = String(
    (
      await app.client.request(ControlCommand.TestSelectionVars, [
        "${selection}",
      ])
    )[1],
  );
  assert.match(
    selected,
    /nrects=[1-9]/,
    "explicit selection has visible ranges",
  );
  sendCommandSync(app.frame, cmdId("CmdContextAnnotate"));
  await poll(
    async () => calls,
    (value) => value === 2,
  );
  await panel.locator(".pending").waitFor({ state: "hidden" });
  const afterCommand = String(
    (
      await app.client.request(ControlCommand.TestSelectionVars, [
        "${selection}",
      ])
    )[1],
  );
  assert.equal(
    afterCommand,
    selected,
    "explicit selection annotation must preserve the user's selection",
  );
  console.log(
    "PASS: single click annotates; first highlight click opens delete; double-click and explicit selection retain native semantics",
  );
  console.log(`Artifacts: ${output}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
  }
  model.closeAllConnections();
  await new Promise<void>((r) => model.close(() => r()));
}
