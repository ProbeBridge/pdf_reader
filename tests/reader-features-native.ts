import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { readingSummary } from "../sumatrapdf/src/notes/reading-stats-model.js";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".test-artifacts", `reader-features-${Date.now()}`);
const data = join(output, "appdata");
mkdirSync(data, { recursive: true });
process.env.SUMATRA_TEST_EXE =
  process.env.SUMATRA_THEME_EXE ||
  join(root, "sumatrapdf/out/rel64/SumatraPDF.exe");
const { launchControlled, sendCommandSync, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { cmdId, makeTextPdf } = await import("../sumatrapdf/tests/util.ts");
const {
  setForegroundWindow,
  showWindow,
  SW_RESTORE,
  captureWindowToPng,
  setProcessDpiAware,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const file = join(output, "reading.pdf");
writeFileSync(
  file,
  makeTextPdf(
    "Read a page and annotate vocabulary. Theme changes must keep the document open.",
  ),
);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  "Theme = Light\nRestoreSession = false\nCheckForUpdates = false\nReuseInstance = false\nShowStartPage = true\nRememberOpenedFiles = true\n",
);
const portServer = createServer();
await new Promise<void>((done) => portServer.listen(0, "127.0.0.1", done));
const port = (portServer.address() as any).port;
await new Promise<void>((done) => portServer.close(() => done()));
let app: any, browser: any;
async function poll<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const until = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (valid(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `Timed out waiting for native reader state: ${lastError || "condition not met"}`,
  );
}
async function start() {
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1100x820@80x80", file],
    {
      saveSettings: true,
      env: {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      },
    },
  );
  await app.client.waitForRenderIdle();
  setForegroundWindow(app.frame);
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  browser = await poll(
    () => chromium.connectOverCDP(`http://127.0.0.1:${port}`),
    Boolean,
  );
}
async function pageFor(name: string) {
  return await poll(
    async () =>
      browser
        .contexts()
        .flatMap((context: any) => context.pages())
        .find((page: any) => page.url().endsWith(name)),
    Boolean,
  );
}
async function stats(page: any) {
  return await page.evaluate(() =>
    (window as any).__sumatra__.call(
      "notes",
      JSON.stringify({ action: "readingStats" }),
    ),
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
    assert.equal(app.proc.exitCode, 0, "reader exits cleanly");
    app = null;
  }
}
try {
  console.log("Checking native notes theme and vocabulary storage...");
  await start();
  let notes = await pageFor("index.html");
  await notes.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await notes.locator("[data-theme-toggle]").click();
  await notes.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await notes.evaluate(async () => {
    const bridge = (window as any).__sumatra__;
    const call = bridge.call.bind(bridge);
    for (const id of ["native-new-word", "native-new-word"])
      await call(
        "notes",
        JSON.stringify({
          action: "recordVocabulary",
          id,
          createdAt: Date.now(),
        }),
      );
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await call(
      "notes",
      JSON.stringify({
        action: "recordVocabulary",
        id: "native-previous-day",
        createdAt: yesterday.getTime(),
      }),
    );
  });
  setForegroundWindow(app.frame);
  const first = await poll(
    async () => readingSummary(await stats(notes), 7),
    (summary: any) => summary.today.pages === 1 && summary.today.seconds >= 2,
  );
  assert.equal(
    first.today.words,
    1,
    "duplicate vocabulary messages count once",
  );
  assert.equal(
    first.days.at(-2)?.words,
    1,
    "vocabulary retains its creation day",
  );
  const SW_MINIMIZE = 6;
  console.log("Checking minimized reading timer...");
  showWindow(app.frame, SW_MINIMIZE);
  const before = readingSummary(await stats(notes)).today.seconds;
  await Bun.sleep(2200);
  assert.equal(
    readingSummary(await stats(notes)).today.seconds,
    before,
    "minimized reader does not accumulate reading time",
  );
  showWindow(app.frame, SW_RESTORE);
  setForegroundWindow(app.frame);
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  console.log("Checking native reflow theme synchronization...");
  const reflow = await pageFor("reflow.html");
  await reflow.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await reflow.locator("[data-theme-toggle]").click();
  await notes.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  sendCommandSync(app.frame, cmdId("CmdToggleLightDarkTheme"));
  await reflow.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await notes.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.ok(captureWindowToPng(app.frame, join(output, "native-dark.png")));
  sendCommandSync(app.frame, cmdId("CmdReadingHistory"));
  console.log("Checking native statistics page...");
  const history = await pageFor("history.html");
  await history.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await history.locator("#statistics").click();
  await history.waitForFunction(
    () => document.querySelector('[data-stat="pages"]')?.textContent === "1",
  );
  assert.equal(await history.locator('[data-stat="words"]').textContent(), "1");
  await history.screenshot({ path: join(output, "native-statistics.png") });
  await stop();
  assert.match(
    readFileSync(join(data, "SumatraPDF-settings.txt"), "utf8"),
    /^Theme\s*=\s*Dark\s*$/m,
  );
  await start();
  notes = await pageFor("index.html");
  console.log("Checking saved theme and statistics after restart...");
  await notes.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  const restored = await poll(
    async () => readingSummary(await stats(notes), 7),
    (summary: any) => summary.today.words === 1,
  );
  assert.equal(
    restored.today.pages,
    1,
    "reopening a document preserves daily page deduplication",
  );
  assert.equal(restored.days.at(-2)?.words, 1);
  await stop();
  console.log(
    `PASS: native theme sync/persistence, page dwell/deduplication, foreground timing, vocabulary idempotency/date, encrypted statistics persistence. Artifacts: ${output}`,
  );
} finally {
  await stop();
}
