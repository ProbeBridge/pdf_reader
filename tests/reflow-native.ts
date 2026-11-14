import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { makeReflowFixture } from "./reflow-fixture.ts";

const root = resolve(import.meta.dir, ".."),
  output = join(root, ".test-artifacts", `reflow-native-${Date.now()}`);
mkdirSync(output, { recursive: true });
process.env.SUMATRA_TEST_EXE = join(
  root,
  "sumatrapdf",
  "out",
  "rel64",
  "SumatraPDF.exe",
);
const { launchControlled, sendCommandSync, killAndWait } =
  await import("../sumatrapdf/tests/win-automation.ts");
const { cmdId } = await import("../sumatrapdf/tests/util.ts");
const { ControlCommand } = await import("../sumatrapdf/tests/control.ts");
const {
  setProcessDpiAware,
  findChildWindow,
  getWindowLong,
  GWL_STYLE,
  moveWindow,
  sendMessage,
  setCursorPos,
  clientToScreen,
  packCoords,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
  MK_LBUTTON,
  sendCopyDataW,
  captureWindowToPng,
  getScrollInfo,
  SB_HORZ,
  SB_VERT,
  enumWindows,
  getClassName,
  getWindowPid,
  getWindowRect,
  isWindowVisible,
} = await import("../sumatrapdf/tests/winapi.ts");
setProcessDpiAware();
const scrollMode =
  process.argv.find((arg) => arg.startsWith("--scrollbars="))?.split("=")[1] ||
  "windows";
assert.ok(["windows", "overlay", "smart"].includes(scrollMode));
const firstFile = join(output, "reflow-primary.pdf"),
  secondFile = join(output, "reflow-secondary.pdf"),
  data = join(output, "appdata");
writeFileSync(firstFile, makeReflowFixture("primary"));
writeFileSync(secondFile, makeReflowFixture("secondary"));
mkdirSync(data);
writeFileSync(
  join(data, "SumatraPDF-settings.txt"),
  `FollowSystemLanguage = false\nUiLanguage = cn\nRestoreSession = false\nCheckForUpdates = false\nShowToc = true\nSidebarDx = 210\nShowStartPage = true\nRememberOpenedFiles = true\nUseTabs = true\nDefaultZoom = 200\nScrollbars = ${scrollMode}\n`,
);
const calls: any[] = [],
  report: any = { output, pdf: firstFile, milestones: [] };
report.scrollMode = scrollMode;
const model = createServer(async (request, response) => {
  if (request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[{"id":"local-reflow-test"}]}');
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  calls.push(JSON.parse(body));
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const content of [
    "IPA: /koʊˌɑːpəˈreɪʃən/\n\n",
    "可靠协作\n\n",
    "【详解】\n根据原文段落解释组件之间的协作。",
  ]) {
    await Bun.sleep(70);
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelPort = (model.address() as any).port;
const portReservation = createServer();
await new Promise<void>((resolve) =>
  portReservation.listen(0, "127.0.0.1", resolve),
);
const debugPort = (portReservation.address() as any).port;
await new Promise<void>((resolve) => portReservation.close(() => resolve()));
let app: any, browser: any, panel: any;
function mark(step: string) {
  report.step = step;
  (report.steps ||= []).push({ time: new Date().toISOString(), step });
  console.log(`[reflow-native] ${step}`);
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
}
async function traceFlow(flow: any) {
  flow.on("pageerror", (error: Error) =>
    (report.pageErrors ||= []).push(error.message),
  );
  await flow.evaluate(() => {
    const scope = window as any;
    if (scope.testBridgeLog) return;
    scope.testBridgeLog = [];
    const record = (value: any) => {
      scope.testBridgeLog.push({ at: performance.now(), ...value });
      if (scope.testBridgeLog.length > 120) scope.testBridgeLog.shift();
    };
    const call = scope.__sumatra__.call.bind(scope.__sumatra__);
    scope.__sumatra__.call = (name: string, data: string) => {
      const request = JSON.parse(data);
      record({ call: request.action, page: request.page, zoom: request.zoom });
      return call(name, data).then(
        (value: any) => {
          record({
            done: request.action,
            page: request.page,
            error: value?.error,
            htmlLength: value?.html?.length,
          });
          return value;
        },
        (error: any) => {
          record({
            failed: request.action,
            page: request.page,
            error: String(error),
          });
          throw error;
        },
      );
    };
    for (const event of ["reflownavigate", "reflowzoom", "reflowfocus"])
      addEventListener(event, (e: any) => record({ event, detail: e.detail }));
  });
}
async function captureFailure() {
  const failure: any = { step: report.step };
  if (app) {
    try {
      failure.chapter = await app.client.chapterInfo();
    } catch (error) {
      failure.chapterError = String(error);
    }
    try {
      failure.layout = (await app.client.layout()).raw;
    } catch (error) {
      failure.layoutError = String(error);
    }
    try {
      await captureWindowToPng(app.frame, join(output, "failure-native.png"));
    } catch (error) {
      failure.screenshotError = String(error);
    }
  }
  if (browser) {
    failure.views = [];
    for (const page of browser
      .contexts()
      .flatMap((context: any) => context.pages())) {
      try {
        const state = await page.evaluate(() => ({
          url: location.href,
          label: document.querySelector("#page-label")?.textContent,
          status: document.querySelector("#status")?.textContent,
          scrollY,
          sections: [
            ...document.querySelectorAll<HTMLElement>(".source-page"),
          ].map((section) => ({
            page: section.dataset.page,
            top: section.getBoundingClientRect().top,
            height: section.getBoundingClientRect().height,
            text: section.textContent?.slice(0, 160),
          })),
          bridge: (window as any).testBridgeLog,
          text: document.body.innerText.slice(0, 1600),
        }));
        failure.views.push(state);
        if (page.url().includes("sumatra-reflow"))
          await page.screenshot({ path: join(output, "failure-reflow.png") });
      } catch (error) {
        failure.views.push({ url: page.url(), error: String(error) });
      }
    }
  }
  report.failure = failure;
}
async function poll<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
  timeout = 30000,
): Promise<T> {
  const until = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const value = await read();
      if (accepts(value)) return value;
      last = value;
    } catch (e) {
      last = String(e);
    }
    await Bun.sleep(100);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}
async function deadline<T>(
  promise: Promise<T>,
  label: string,
  ms = 30000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function pageFor(host: string) {
  return await poll(
    async () =>
      browser
        .contexts()
        .flatMap((context: any) => context.pages())
        .find((page: any) => page.url().includes(host) && !page.isClosed()),
    Boolean,
    host,
  );
}
async function nativeCall(page: any, action: string, fields: any = {}) {
  return await deadline(
    page.evaluate(
      ({ action, fields }: any) =>
        (window as any).__sumatra__.call(
          "reflow",
          JSON.stringify({ action, ...fields }),
        ),
      { action, fields },
    ),
    action,
  );
}
async function queuePendingExtraction(flow: any, label: string) {
  mark(label);
  const pending = await flow.evaluate(() => {
    (window as any).cleanupPending = true;
    (window as any).__sumatra__
      .call("reflow", JSON.stringify({ action: "page", page: 3 }))
      .then(
        () => {
          (window as any).cleanupPending = false;
        },
        () => {
          (window as any).cleanupPending = false;
        },
      );
    return (window as any).cleanupPending;
  });
  (report.pendingProbes ||= []).push({ label, pending });
  assert.equal(
    pending,
    true,
    "cleanup path must begin with an outstanding native page request",
  );
}
async function waitPage(flow: any, page: number, caller = "") {
  mark(`waitPage ${page}: ${caller}`);
  await flow.waitForFunction(
    (page: number) =>
      document
        .querySelector("#page-label")
        ?.textContent?.startsWith(`${page} /`) &&
      !!document.querySelector(
        `.source-page[data-page="${page}"] .page-content`,
      ) &&
      document.querySelector("#pages")?.getAttribute("aria-busy") !== "true",
    page,
  );
  await poll(
    () => app.client.chapterInfo(),
    (info: any) => info.page === page,
    `controller page ${page}`,
  );
}
function scrollbarSnapshot(label: string) {
  const canvas = findChildWindow(app.frame, "SUMATRA_PDF_CANVAS"),
    style = getWindowLong(canvas, GWL_STYLE),
    overlays: any[] = [];
  enumWindows((hwnd) => {
    if (
      getWindowPid(hwnd) === app.proc.pid &&
      getClassName(hwnd) === "SUMATRA_OVERLAY_SCROLLBAR"
    ) {
      const rect = getWindowRect(hwnd);
      overlays.push({
        visible: isWindowVisible(hwnd),
        horizontal: rect.right - rect.left > rect.bottom - rect.top,
        rect,
      });
    }
    return true;
  });
  const state = {
    nativeH: !!(style & 0x00100000),
    nativeV: !!(style & 0x00200000),
    h: getScrollInfo(canvas, SB_HORZ),
    v: getScrollInfo(canvas, SB_VERT),
    overlays,
  };
  report[label] = state;
  return state;
}
async function geometry(flow: any, label: string) {
  const metrics = await poll(
    async () =>
      flow.evaluate(() => {
        const contents = [
          ...document.querySelectorAll<HTMLElement>(".page-content"),
        ];
        return {
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          tables: contents.flatMap((content) =>
            [...content.querySelectorAll<HTMLTableElement>("table")].map(
              (table) => ({
                width: table.getBoundingClientRect().width,
                available: content.clientWidth,
                font: parseFloat(getComputedStyle(table).fontSize),
                columns: Math.max(
                  ...[...table.rows].map((row) =>
                    [...row.cells].reduce((n, cell) => n + cell.colSpan, 0),
                  ),
                ),
                cells: [...table.querySelectorAll<HTMLElement>("th,td")].map(
                  (cell) => ({
                    scroll: cell.scrollWidth,
                    width: cell.clientWidth,
                  }),
                ),
              }),
            ),
          ),
          images: contents.flatMap((content) =>
            [...content.querySelectorAll("img")].map((image) => ({
              width: image.getBoundingClientRect().width,
              available: content.clientWidth,
            })),
          ),
          font: contents.length
            ? parseFloat(getComputedStyle(contents[0]).fontSize)
            : 0,
        };
      }),
    (value: any) =>
      value.scroll <= value.width + 1 &&
      value.tables.length > 0 &&
      value.images.length > 0 &&
      value.tables.every(
        (table: any) =>
          table.width <= table.available + 1 &&
          table.cells.every((cell: any) => cell.scroll <= cell.width + 1),
      ) &&
      value.images.every((image: any) => image.width <= image.available + 1),
    label,
  );
  assert.equal(
    getWindowLong(findChildWindow(app.frame, "SUMATRA_PDF_CANVAS"), GWL_STYLE) &
      0x00100000,
    0,
    "native horizontal scrollbar must be hidden during true reflow",
  );
  assert.ok(
    scrollbarSnapshot(`${label}-scrollbars`).overlays.every(
      (overlay) => !overlay.visible,
    ),
    "reflow must hide native overlay scrollbars",
  );
  report[label] = metrics;
  return metrics;
}
async function stop() {
  if (app) {
    await app.client.quit().catch(() => {});
    app.client.close();
    await Promise.race([app.proc.exited, Bun.sleep(8000)]);
    if (app.proc.exitCode === null) await killAndWait(app.proc);
    app = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
try {
  mark("launch isolated native application");
  app = await launchControlled(
    ["-appdata", data, "-window-pos", "1420x960@60x50", firstFile],
    {
      saveSettings: true,
      env: {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      },
    },
  );
  await app.client.waitForRenderIdle();
  sendCommandSync(app.frame, cmdId("CmdContextNotes"));
  browser = await poll(
    () => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`),
    Boolean,
    "WebView CDP",
  );
  panel = await pageFor("sumatra-notes/index.html");
  await panel.locator("#cards").waitFor();
  await panel.waitForFunction(() => !!(window as any).chrome?.storage?.local);
  await panel.evaluate(async (port: number) => {
    await (window as any).chrome.storage.local.set({
      settings: {
        provider: "openai",
        apiKey: "LOCAL_REFLOW_FIXTURE_ONLY",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local-reflow-test",
        ipa: "us",
        panelZoom: 100,
        clickToAnnotate: false,
      },
    });
  }, modelPort);
  await app.client.waitForRenderIdle();
  const originalBars = scrollbarSnapshot("originalBeforeReflow");
  if (scrollMode === "windows")
    assert.ok(
      originalBars.nativeH && originalBars.nativeV,
      "200% fixture must require both original Windows scrollbars",
    );
  if (scrollMode === "overlay")
    assert.ok(
      originalBars.overlays.some((bar) => bar.visible && bar.horizontal) &&
        originalBars.overlays.some((bar) => bar.visible && !bar.horizontal),
      "200% fixture must require both always-visible overlay scrollbars",
    );
  async function checkReflowSwitch(enabled: boolean) {
    const button = (await app.client.virtTree()).find((item: any) =>
      item.text.startsWith("重排："),
    );
    assert.ok(button && button.rect.dx > 0 && button.rect.dy > 0);
    assert.equal(
      button.text,
      enabled ? "重排：开" : "重排：关",
      "toolbar switch must display the actual reflow state",
    );
  }
  await checkReflowSwitch(false);
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  let flow = await pageFor("sumatra-reflow/reflow.html");
  await traceFlow(flow);
  await waitPage(flow, 1, "first enable");
  await checkReflowSwitch(true);
  const firstNavigation = (await nativeCall(flow, "ready")).navigation;
  const exported: any = await nativeCall(flow, "page", { page: 1 });
  writeFileSync(join(output, "actual-page1.xhtml"), exported.html || "");
  writeFileSync(
    join(output, "actual-page1-source.txt"),
    exported.sourceText || "",
  );
  assert.equal(exported.error, "");
  const regions = await flow.evaluate(() => {
    const content = document.querySelector(
      '.source-page[data-page="1"] .page-content',
    )!;
    const header = content.querySelector('[data-page-region="header"]');
    const footer = content.querySelector('[data-page-region="footer"]');
    return {
      header: header?.textContent?.replace(/\s+/g, " ").trim(),
      footer: footer?.textContent?.replace(/\s+/g, " ").trim(),
      body: [...content.querySelectorAll("h1,h2,h3,p")]
        .filter((element) => !element.closest("[data-page-region]"))
        .map((element) => element.textContent)
        .join(" "),
    };
  });
  report.regions = regions;
  assert.ok(
    regions.header?.includes("HeaderLeft") &&
      regions.header.includes("HeaderRight"),
    "repeated page headers must be isolated above the body",
  );
  assert.match(
    regions.footer || "",
    /FooterLeft.*Copyright Reader fixture.*1/,
    "the footer's left label, centered copyright and right page number must stay together below the body",
  );
  assert.match(
    regions.body,
    /Reflow primary document/,
    "a unique title near the page edge must remain a body heading",
  );
  assert.ok(
    !/HeaderLeft|HeaderRight|FooterLeft|Copyright Reader fixture/.test(
      regions.body,
    ),
  );
  assert.match(
    exported.html,
    /<table[\s>]/,
    "real MuPDF table hunt must export a semantic table; mock HTML is not sufficient",
  );
  assert.match(exported.html, /<img[\s>]/, "real MuPDF must export the image");
  const cache: any = await nativeCall(flow, "cache-info");
  assert.ok(cache.path.endsWith(".ordered.html.jsonl"));
  const records = readFileSync(cache.path)
    .subarray(0, cache.bytes)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records[0].format, "SumatraPDF ordered XHTML");
  assert.equal(records[0].version, 1);
  const cachedPage = records.filter((record) => record.page === 1);
  assert.equal(cachedPage.length, 1);
  assert.equal(cachedPage[0].html, exported.html);
  assert.equal(cachedPage[0].sourceText, exported.sourceText);
  const repeated: any = await nativeCall(flow, "page", { page: 1 });
  assert.equal(
    repeated.cached,
    true,
    "repeat requests must read the temporary ordered file",
  );
  assert.equal(repeated.html, exported.html);
  report.cache = cache;
  assert.equal(
    (exported.html.match(/<img[\s>]/g) || []).length,
    1,
    "retain the ordinary masked picture without exporting its background watermark",
  );
  const tableStructure = await flow
    .locator('.source-page[data-page="1"] table')
    .first()
    .evaluate((table: HTMLTableElement) => ({
      rows: [...table.rows].map((row) => row.cells.length),
      headers: [...table.rows[0].cells].map((cell) => cell.textContent?.trim()),
    }));
  report.tableStructure = tableStructure;
  assert.deepEqual(
    tableStructure.rows,
    [3, 3, 3, 3],
    "real ruled PDF table must retain every column, including Description",
  );
  assert.deepEqual(tableStructure.headers, [
    "Parameter",
    "Value",
    "Description",
  ]);
  assert.match(exported.sourceText, /cooperation/);
  const paragraphs = await flow
    .locator('.source-page[data-page="1"] p')
    .allTextContents();
  assert.ok(
    paragraphs.includes(
      "The cooperation between components determines reliable behavior. A narrow reading pane should wrap this paragraph into additional lines.",
    ),
    "physical PDF lines must become one paragraph, including a sentence boundary inside a line",
  );
  assert.ok(
    paragraphs.includes(
      "Pictures and register tables remain entirely inside the reading width.",
    ),
    "the larger paragraph gap must retain a separate paragraph",
  );
  report.paragraphs = paragraphs;
  assert.ok(paragraphs.includes("- FeatureFirst has no terminal punctuation"));
  assert.ok(
    paragraphs.includes("- FeatureSecond remains an independent item"),
    "closely spaced list items without terminal punctuation must stay separate",
  );
  report.milestones.push("actual MuPDF XHTML table/image");
  const initial = await geometry(flow, "initial");
  sendCommandSync(app.frame, cmdId("CmdZoom400"));
  await flow.waitForFunction(() =>
    document.querySelector("#page-label")?.textContent?.includes("400%"),
  );
  const large = await geometry(flow, "zoom400");
  assert.equal(large.font, 72);
  assert.ok(large.images[0].width >= initial.images[0].width);
  mark("TOC sidebar navigation to source page 2");
  await app.client.tocSidebarNav(2);
  await waitPage(flow, 2, "TOC sidebar");
  await nativeCall(flow, "position", { page: 1, navigation: firstNavigation });
  assert.equal(
    (await app.client.chapterInfo()).page,
    2,
    "a stale scroll report must not undo a newer TOC navigation",
  );
  const register: any = await nativeCall(flow, "page", { page: 2 });
  writeFileSync(join(output, "actual-page2.xhtml"), register.html || "");
  assert.match(
    register.html,
    /<table[\s>]/,
    "the actual 32-column PDF grid must be recognized as a table",
  );
  const grid = await geometry(flow, "register400");
  const columnPage: any = await nativeCall(flow, "page", { page: 2 });
  const columnMarkers = [
    "ColumnLeftOne",
    "ColumnLeftTwo",
    "ColumnLeftThree",
    "ColumnRightOne",
    "ColumnRightTwo",
    "ColumnRightThree",
  ];
  let previousColumn = -1;
  for (const marker of columnMarkers) {
    const position = columnPage.html.indexOf(marker);
    assert.ok(
      position > previousColumn,
      `columns must read top to bottom, then left to right: ${marker}`,
    );
    previousColumn = position;
  }
  assert.ok(
    grid.tables.some((table: any) => table.columns >= 32),
    "32-bit register columns must retain table structure",
  );
  await captureWindowToPng(
    app.frame,
    join(output, "native-reflow-register.png"),
  );
  mark("preserve the center glyph across original/reflow toggles");
  sendCommandSync(app.frame, cmdId("CmdZoom100"));
  await flow.waitForFunction(() =>
    document.querySelector("#page-label")?.textContent?.includes("100%"),
  );
  const centerGlyph = await flow.evaluate(async (data: any) => {
    const content = document.querySelector(
      '.source-page[data-page="2"] .page-content',
    )!;
    const walk = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node; (node = walk.nextNode());) {
      const index = node.textContent!.indexOf("The original page number");
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      scrollBy(
        0,
        rect.top +
          rect.height / 2 -
          (document.querySelector("nav")!.getBoundingClientRect().bottom +
            innerHeight) /
            2,
      );
      break;
    }
    const range = document.caretRangeFromPoint(
      innerWidth / 2,
      (document.querySelector("nav")!.getBoundingClientRect().bottom +
        innerHeight) /
        2,
    )!;
    while (
      /\s/.test(range.startContainer.textContent![range.startOffset] || "") &&
      range.startOffset + 1 < range.startContainer.textContent!.length
    )
      range.setStart(range.startContainer, range.startOffset + 1);
    range.setEnd(range.startContainer, range.startOffset + 1);
    const { SourcePage } = await import(
      new URL("reflow-model.js", location.href).href
    );
    const model = new SourcePage(content, 2, data.sourceText, data.displayText);
    return {
      ranges: model.selection(range),
      top: range.getBoundingClientRect().top,
    };
  }, register);
  assert.equal(centerGlyph.ranges.length, 1);
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  await poll(
    async () => scrollbarSnapshot("centerOriginal").nativeV,
    Boolean,
    "original view after toggle",
  );
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  await waitPage(flow, 2, "center glyph toggle");
  const centerAfter = await flow.evaluate(
    async ({ data, glyph }: any) => {
      const content = document.querySelector(
        '.source-page[data-page="2"] .page-content',
      )!;
      const { SourcePage } = await import(
        new URL("reflow-model.js", location.href).href
      );
      const model = new SourcePage(
        content,
        2,
        data.sourceText,
        data.displayText,
      );
      return model.domRanges(glyph.start, glyph.end)[0].getBoundingClientRect()
        .top;
    },
    { data: register, glyph: centerGlyph.ranges[0] },
  );
  report.centerToggle = {
    before: centerGlyph.top,
    after: centerAfter,
    ranges: centerGlyph.ranges,
  };
  assert.ok(
    Math.abs(centerAfter - centerGlyph.top) < 40,
    `switching original/reflow must retain the viewport's center content: ${JSON.stringify(report.centerToggle)}`,
  );
  report.originalCenter = await nativeCall(flow, "original-center");
  const imageBefore = await flow
    .locator('.source-page[data-page="2"] img')
    .first()
    .evaluate((image: HTMLImageElement) => {
      const rect = image.getBoundingClientRect();
      scrollBy(
        0,
        rect.top +
          rect.height / 2 -
          (document.querySelector("nav")!.getBoundingClientRect().bottom +
            innerHeight) /
            2,
      );
      const centered = image.getBoundingClientRect();
      return centered.top + centered.height / 2;
    });
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  await poll(
    async () => scrollbarSnapshot("imageOriginal").nativeV,
    Boolean,
    "original image view",
  );
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  await waitPage(flow, 2, "center image toggle");
  const imageAfter = await flow
    .locator('.source-page[data-page="2"] img')
    .first()
    .evaluate((image: HTMLImageElement) => {
      const rect = image.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
  report.centerImage = { before: imageBefore, after: imageAfter };
  assert.ok(
    Math.abs(imageBefore - imageAfter) < 16,
    `switching original/reflow must retain the center of an image: ${JSON.stringify(report.centerImage)}`,
  );
  sendCommandSync(app.frame, cmdId("CmdZoom400"));
  await flow.waitForFunction(() =>
    document.querySelector("#page-label")?.textContent?.includes("400%"),
  );
  moveWindow(app.frame, 60, 50, 800, 800);
  await app.client.waitForRenderIdle();
  await geometry(flow, "narrow800");
  moveWindow(app.frame, 60, 50, 1420, 960);
  await app.client.waitForRenderIdle();
  const splitter = (await app.client.virtTree("SUMATRA_PDF_FRAME")).find(
    (item: any) => item.name === "contextNotesSplitter",
  );
  assert.ok(splitter);
  const from = {
      x: splitter.rect.x + Math.floor(splitter.rect.dx / 2),
      y: splitter.rect.y + Math.floor(splitter.rect.dy / 2),
    },
    to = { x: from.x - 140, y: from.y };
  let screen = clientToScreen(app.frame, from.x, from.y);
  setCursorPos(screen.x, screen.y);
  sendMessage(
    app.frame,
    WM_LBUTTONDOWN,
    MK_LBUTTON,
    packCoords(from.x, from.y),
  );
  screen = clientToScreen(app.frame, to.x, to.y);
  setCursorPos(screen.x, screen.y);
  sendMessage(app.frame, WM_MOUSEMOVE, MK_LBUTTON, packCoords(to.x, to.y));
  sendMessage(app.frame, WM_LBUTTONUP, 0, packCoords(to.x, to.y));
  await app.client.waitForRenderIdle();
  const dragged = await geometry(flow, "notesWidened");
  assert.ok(
    dragged.width < large.width,
    "widening notes must reduce the reflow width without overflow",
  );
  mark("TOC sidebar navigation back to source page 1");
  await app.client.tocSidebarNav(1);
  await waitPage(flow, 1, "TOC return for AI selection");
  sendCommandSync(app.frame, cmdId("CmdZoom100"));
  await flow.waitForFunction(() =>
    document.querySelector("#page-label")?.textContent?.includes("100%"),
  );
  await flow.evaluate(() => {
    const content = document.querySelector(
        '.source-page[data-page="1"] .page-content',
      )!,
      walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const text = node.textContent!,
        at = text.indexOf("cooperation");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "cooperation".length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      return;
    }
    throw new Error("reliable word missing from actual XHTML");
  });
  await flow.locator("#annotate").click();
  mark("waiting for selected-word streaming note");
  await panel.locator(".pending").first().waitFor();
  await panel.locator(".meaning").filter({ hasText: "可靠协作" }).waitFor();
  await panel.locator(".pending").waitFor({ state: "hidden" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages.at(-1).content, /cooperation/);
  assert.match(calls[0].messages.at(-1).content, /between components/);
  const stored: any = await panel.evaluate(async () => {
    const all = await (window as any).chrome.storage.local.get(null);
    return Object.entries(all).find(
      ([key, value]: any) =>
        key.startsWith("page:") &&
        value.annotations?.some((note: any) => note.quote === "cooperation"),
    );
  });
  assert.ok(stored);
  assert.match(stored[0], /^page:sha256:/);
  const note = stored[1].annotations.find(
      (note: any) => note.quote === "cooperation",
    ),
    wordStart = Array.from(
      exported.sourceText.slice(0, exported.sourceText.indexOf("cooperation")),
    ).length;
  assert.deepEqual(note.anchor.ranges, [
    { page: 1, start: wordStart, end: wordStart + "cooperation".length },
  ]);
  await flow.locator(".note-ink").first().waitFor();
  assert.equal(
    readFileSync(join(data, "context-notes.dat")).includes(
      Buffer.from("LOCAL_REFLOW_FIXTURE_ONLY"),
    ),
    true,
  );
  report.milestones.push(
    "selection → native source glyphs → streaming API → note → DOM highlight",
  );
  await flow.locator("#next").click();
  await waitPage(flow, 2, "reflow next button");
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  await app.client.waitForRenderIdle();
  await poll(
    async () =>
      scrollMode === "windows"
        ? scrollbarSnapshot("restoringOriginal").nativeV
        : scrollbarSnapshot("restoringOriginal").overlays.some(
            (bar) => bar.visible,
          ),
    Boolean,
    "restore original scrollbars",
  );
  await checkReflowSwitch(false);
  const restoredBars = scrollbarSnapshot("originalAfterReflow");
  mark(`checking immediate original ${scrollMode} scrollbar restoration`);
  assert.equal(
    restoredBars.nativeH,
    originalBars.nativeH,
    "returning to original must immediately restore its horizontal scrollbar",
  );
  assert.equal(
    restoredBars.nativeV,
    originalBars.nativeV,
    "returning to original must immediately restore its vertical scrollbar",
  );
  for (const horizontal of [true, false])
    assert.equal(
      restoredBars.overlays.some(
        (bar) => bar.visible && bar.horizontal === horizontal,
      ),
      originalBars.overlays.some(
        (bar) => bar.visible && bar.horizontal === horizontal,
      ),
      `returning to original must restore its ${horizontal ? "horizontal" : "vertical"} overlay state`,
    );
  assert.equal(
    (await app.client.chapterInfo()).page,
    2,
    "returning to original must retain source page",
  );
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  await waitPage(flow, 2, "toggle original/reflow");
  const drawing: any = await nativeCall(flow, "page", { page: 3 });
  assert.equal(drawing.error, "");
  assert.match(drawing.sourceText, /VectorInput/);
  assert.match(drawing.sourceText, /VectorProcess/);
  assert.match(drawing.sourceText, /VectorOutput/);
  assert.equal(
    (drawing.html.match(/<img[\s>]/g) || []).length,
    2,
    "retain the vector diagram and raster image without their background watermark",
  );
  assert.ok(
    !drawing.html.includes("VectorInput"),
    "diagram labels must be included in its image without duplicate loose text",
  );
  // Queue actual native work, then switch controller while its response may be
  // pending. The fixture's large third-page image makes this path substantive.
  await queuePendingExtraction(
    flow,
    "pending page extraction before document switch",
  );
  assert.ok(
    sendCopyDataW(app.frame, 0x44646557, `[Open("${secondFile}", 0, 1, 0)]`),
  );
  await poll(
    () => app.client.request(ControlCommand.TestCurrentTab),
    (value: any) => String(value[1]).includes("reflow-secondary.pdf"),
    "second document",
  );
  await poll(
    async () => flow.isClosed(),
    Boolean,
    "old reflow host destruction",
  );
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  flow = await pageFor("sumatra-reflow/reflow.html");
  await traceFlow(flow);
  await waitPage(flow, 1, "new document while extraction pending");
  const newPage: any = await nativeCall(flow, "page", { page: 1 });
  assert.match(newPage.sourceText, /secondary document/);
  assert.ok(!newPage.sourceText.includes("primary document"));
  await queuePendingExtraction(
    flow,
    "pending page extraction before tab close",
  );
  sendCommandSync(app.frame, cmdId("CmdCloseCurrentDocument"));
  await poll(
    async () => flow.isClosed(),
    Boolean,
    "closed-tab host destruction",
  );
  assert.deepEqual(await app.client.request(ControlCommand.Ping), ["pong"]);
  sendCommandSync(app.frame, cmdId("CmdToggleDocumentReflow"));
  flow = await pageFor("sumatra-reflow/reflow.html");
  await traceFlow(flow);
  await waitPage(flow, 2, "original tab after closing other document");
  const restored: any = await nativeCall(flow, "page", { page: 1 });
  assert.match(restored.sourceText, /primary document/);
  await queuePendingExtraction(
    flow,
    "pending page extraction before window close",
  );
  await app.client.quit();
  app.client.close();
  const code = await deadline(
    app.proc.exited,
    "pending-task window close",
    10000,
  );
  assert.equal(code, 0);
  assert.equal(
    existsSync(cache.path),
    false,
    "the temporary document must be deleted after the reader exits",
  );
  app = null;
  await browser.close().catch(() => {});
  browser = null;
  assert.match(
    readFileSync(join(data, "SumatraPDF-settings.txt"), "utf8"),
    /^DefaultZoom\s*=\s*200\s*$/m,
    "reflow font zoom must not overwrite original PDF zoom",
  );
  report.milestones.push(
    "source page/TOC navigation, original toggle, tab/controller/window pending cleanup",
  );
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    "PASS: actual PDF→MuPDF XHTML tables/images; native reflow/zoom/scrollbars/splitter; 32-column table fit; source navigation and AI anchors; pending task cleanup.",
  );
  console.log(`Artifacts: ${output}`);
} catch (error) {
  await captureFailure();
  report.error = String((error as Error).stack || error);
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await stop();
  await new Promise<void>((resolve) => model.close(() => resolve()));
}
