import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { readingSummary } from "../sumatrapdf/src/notes/reading-stats-model.js";
import { libraryKey } from "../sumatrapdf/src/notes/library-model.js";

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
const bookFile = join(output, "Unopened book.pdf"),
  bookBytes = makeTextPdf(
    "A local book that has never been in reading history.",
  );
writeFileSync(bookFile, bookBytes);
const bookKey = libraryKey(bookFile, true);
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
async function libraryCall(page: any, action: string, fields: any = {}) {
  return page.evaluate(
    ({ action, fields }: any) =>
      (window as any).__sumatra__.call(
        "notes",
        JSON.stringify({ action, ...fields }),
      ),
    { action, fields },
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
  assert.deepEqual(await libraryCall(history, "library"), []);
  assert.ok(
    !(await libraryCall(history, "history")).some(
      (item: any) => item.path === bookFile,
    ),
  );
  await libraryCall(history, "write", {
    key: bookKey,
    value: JSON.stringify({
      name: "Unopened book.pdf",
      path: bookFile,
      addedAt: Date.now(),
    }),
    expected: "null",
  });
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
  console.log(
    "Checking local library persistence, new-file opening and missing-file recovery...",
  );
  const books = await libraryCall(notes, "library");
  assert.equal(books.length, 1);
  assert.equal(books[0].book.path, bookFile);
  assert.equal(books[0].missing, false);
  sendCommandSync(app.frame, cmdId("CmdReadingHistory"));
  const home = await pageFor("history.html");
  await home.locator("#library").click();
  await home.locator(".book-title").waitFor();
  await home.locator(".book-title").click();
  await notes
    .locator("#doc-title")
    .filter({ hasText: "Unopened book.pdf" })
    .waitFor();
  assert.ok(
    (await libraryCall(notes, "history")).some(
      (item: any) => item.path === bookFile,
    ),
  );
  sendCommandSync(app.frame, cmdId("CmdCloseCurrentDocument"));
  sendCommandSync(app.frame, cmdId("CmdReadingHistory"));
  renameSync(bookFile, bookFile + ".moved");
  assert.equal((await libraryCall(home, "library"))[0].missing, true);
  await assert.rejects(
    libraryCall(home, "open", { path: bookFile }),
    /moved|unavailable/,
  );
  await home.locator("#library").click();
  await home.locator(".book-status:not([hidden])").waitFor();
  await home.locator(".book-remove").click();
  await home.waitForFunction(
    () => document.querySelectorAll(".book-card").length === 0,
  );
  assert.equal(
    existsSync(bookFile + ".moved"),
    true,
    "removing a library entry keeps the source file",
  );
  await home.locator("#toast button").click();
  await home.locator(".book-title").waitFor();
  assert.equal((await libraryCall(home, "library")).length, 1);
  assert.deepEqual(readFileSync(bookFile + ".moved"), bookBytes);
  renameSync(bookFile + ".moved", bookFile);
  await stop();
  console.log(
    `PASS: native theme sync/persistence, page dwell/deduplication, foreground timing, vocabulary idempotency/date, local statistics persistence. Artifacts: ${output}`,
  );
} finally {
  await stop();
}
